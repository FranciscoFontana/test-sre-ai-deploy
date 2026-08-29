import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, listAvailableModels, runAgent } from "./agent.js";
import { buildInitialUserMessage, buildSystemInstruction } from "./prompt.js";
import { buildJsonReport, buildMarkdownReport, decideGate, type RunMeta } from "./report.js";
import { QaSession, SEVERITIES, type Severity } from "./session.js";
import { buildTools } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** 0 = QA aprobado · 1 = QA rechazó el build · 2 = el gate no pudo ejecutarse. */
const EXIT_INFRA_ERROR = 2;

/** Señal interna de salida. No es un error del programa: ya se reportó. */
class ExitSignal extends Error {}

/**
 * Aborta la corrida por un problema de infraestructura.
 *
 * Fija process.exitCode en lugar de llamar a process.exit(): en Windows,
 * process.exit() con sockets todavía abiertos dispara una assertion de libuv
 * que aborta el proceso con un código distinto del pedido. En el camino de
 * éxito eso convertiría un QA aprobado en un fallo.
 */
function fail(message: string): never {
  console.error(`\n[qa-agent] ERROR: ${message}`);
  console.error("[qa-agent] El gate no pudo ejecutarse. Esto NO cuenta como QA aprobado.");
  process.exitCode = EXIT_INFRA_ERROR;
  throw new ExitSignal(message);
}

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseSeverity(raw: string | undefined, fallback: Severity): Severity {
  if (raw === undefined) return fallback;
  if ((SEVERITIES as readonly string[]).includes(raw)) return raw as Severity;
  throw new Error(`Umbral inválido: '${raw}'. Valores posibles: ${SEVERITIES.join(", ")}.`);
}

const config = {
  baseUrl: readArg("--base-url") ?? process.env.QA_BASE_URL,
  apiKey: process.env.GEMINI_API_KEY,
  // Pinneado a propósito en vez de usar el alias gemini-flash-latest: este
  // modelo es el gate de un deploy, y no quiero que cambie solo bajo los pies.
  // Ver los modelos disponibles para tu key: el agente los lista ante un 404.
  model: process.env.QA_MODEL ?? "gemini-3.6-flash",
  maxIterations: Number(process.env.QA_MAX_ITERATIONS ?? 20),
  maxRequests: Number(process.env.QA_MAX_REQUESTS ?? 80),
  // Gemini 3.x razona antes de responder y ese pensamiento consume presupuesto
  // de salida. Con un tope bajo el modelo se queda sin margen justo antes de
  // emitir la llamada de cierre y devuelve una respuesta vacía.
  maxOutputTokens: Number(process.env.QA_MAX_OUTPUT_TOKENS ?? 16384),
  failOn: parseSeverity(readArg("--fail-on") ?? process.env.QA_FAIL_ON, "high"),
  outDir: readArg("--out-dir") ?? process.env.QA_OUT_DIR ?? process.cwd(),
  contractPath: process.env.QA_CONTRACT_PATH ?? join(REPO_ROOT, "contracts", "openapi.yaml"),
};

/** Espera a que el entorno responda antes de gastar una sola llamada al modelo. */
async function waitForTarget(baseUrl: string, attempts = 10): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/healthz`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        console.log(`[qa-agent] entorno accesible en ${baseUrl}`);
        return;
      }
      console.log(`[qa-agent] intento ${attempt}/${attempts}: /healthz devolvió ${response.status}`);
    } catch {
      console.log(`[qa-agent] intento ${attempt}/${attempts}: sin respuesta todavía`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`El entorno ${baseUrl} no respondió en /healthz tras ${attempts} intentos.`);
}

async function main(): Promise<void> {
  if (!config.baseUrl) {
    fail("Falta la URL del entorno. Definí QA_BASE_URL o pasá --base-url <url>.");
  }
  if (!config.apiKey) {
    fail("Falta GEMINI_API_KEY en el entorno. Sacá una en aistudio.google.com (Get API key).");
  }

  let openapiYaml: string;
  try {
    openapiYaml = readFileSync(config.contractPath, "utf8");
  } catch {
    fail(`No se pudo leer el contrato OpenAPI en ${config.contractPath}.`);
  }

  await waitForTarget(config.baseUrl);

  const session = new QaSession(config.baseUrl, config.maxRequests);
  const tools = buildTools(session);

  const startedAt = new Date();
  const startedMs = performance.now();

  console.log(
    `[qa-agent] arrancando · modelo=${config.model} · tope=${config.maxIterations} iteraciones / ${config.maxRequests} requests`,
  );

  let result;
  try {
    result = await runAgent({
      apiKey: config.apiKey,
      model: config.model,
      systemInstruction: buildSystemInstruction(openapiYaml),
      userMessage: buildInitialUserMessage(
        config.baseUrl,
        config.maxRequests,
        config.maxIterations,
      ),
      tools,
      maxIterations: config.maxIterations,
      maxOutputTokens: config.maxOutputTokens,
      closingToolName: "finish_run",
      shouldStop: () => session.outcome !== null,
      onIteration: (iteration) => {
        console.log(
          `[qa-agent] iteración ${iteration}/${config.maxIterations} · ` +
            `${session.requestCount} requests · ${session.findings.length} findings`,
        );
      },
    });
  } catch (error) {
    if (error instanceof AgentError) {
      // Un 404 casi siempre es un id de modelo que no existe en este tier.
      // Listar lo disponible ahorra una vuelta de diagnóstico.
      if (/404/.test(error.message)) {
        const available = await listAvailableModels(config.apiKey);
        if (available.length > 0) {
          console.error(`\n[qa-agent] modelos disponibles para tu key: ${available.join(", ")}`);
        }
      }
      fail(error.message);
    }
    fail(error instanceof Error ? error.message : String(error));
  }

  if (result.neededClosingNudge) {
    console.log(
      `[qa-agent] el modelo cortó sin llamar a finish_run (finishReason=${result.finishReason}); se le forzó el cierre`,
    );
    if (result.finalText.trim().length > 0) {
      console.log(`[qa-agent] texto con el que había cerrado: ${result.finalText.trim()}`);
    } else {
      console.log("[qa-agent] no devolvió texto: la respuesta vino vacía");
    }
  }

  const hitIterationCap = result.hitIterationCap && session.outcome === null;
  const meta: RunMeta = {
    baseUrl: config.baseUrl,
    model: config.model,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - startedMs),
    iterations: result.iterations,
    maxIterations: config.maxIterations,
    hitIterationCap,
    failOn: config.failOn,
  };

  const gate = decideGate(session, config.failOn, hitIterationCap);
  const markdown = buildMarkdownReport(session, meta, gate);
  const json = buildJsonReport(session, meta, gate);

  const mdPath = resolve(config.outDir, "qa-report.md");
  const jsonPath = resolve(config.outDir, "qa-report.json");
  writeFileSync(mdPath, markdown, "utf8");
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");

  console.log(
    `[qa-agent] tokens · prompt=${result.usage.promptTokens} ` +
      `respuesta=${result.usage.responseTokens} total=${result.usage.totalTokens}`,
  );
  console.log(`[qa-agent] reportes escritos en ${mdPath} y ${jsonPath}`);

  const counts = session.countsBySeverity();
  console.log(
    `[qa-agent] hallazgos · critical=${counts.critical} high=${counts.high} ` +
      `medium=${counts.medium} low=${counts.low} info=${counts.info}`,
  );

  if (gate.passed) {
    console.log("\n[qa-agent] ✅ GATE APROBADO — el deploy puede continuar.");
  } else {
    console.log("\n[qa-agent] ❌ GATE BLOQUEADO — el deploy se detiene:");
    for (const reason of gate.reasons) console.log(`  · ${reason}`);
  }

  // Igual que en fail(): exitCode en lugar de process.exit().
  process.exitCode = gate.exitCode;
}

main().catch((error) => {
  if (error instanceof ExitSignal) return; // ya reportado por fail()
  try {
    fail(error instanceof Error ? error.message : String(error));
  } catch {
    // fail() ya fijó el exitCode y escribió el mensaje.
  }
});
