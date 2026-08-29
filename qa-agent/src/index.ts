import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialUserMessage, buildSystem } from "./prompt.js";
import { buildJsonReport, buildMarkdownReport, decideGate, type RunMeta } from "./report.js";
import { QaSession, SEVERITIES, type Severity } from "./session.js";
import { buildTools } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** 0 = QA aprobado · 1 = QA rechazó el build · 2 = el gate no pudo ejecutarse. */
const EXIT_INFRA_ERROR = 2;

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
  model: process.env.QA_MODEL ?? "claude-haiku-4-5",
  maxIterations: Number(process.env.QA_MAX_ITERATIONS ?? 20),
  maxRequests: Number(process.env.QA_MAX_REQUESTS ?? 80),
  failOn: parseSeverity(readArg("--fail-on") ?? process.env.QA_FAIL_ON, "high"),
  outDir: readArg("--out-dir") ?? process.env.QA_OUT_DIR ?? process.cwd(),
  contractPath: process.env.QA_CONTRACT_PATH ?? join(REPO_ROOT, "contracts", "openapi.yaml"),
  // Las API keys vinculadas a una identidad exigen declarar el workspace
  // en cada request. Con una key clásica esto queda vacío y no se envía.
  workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
};

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

/** Espera a que el entorno responda antes de gastar un solo token. */
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
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("Falta ANTHROPIC_API_KEY en el entorno.");
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
  const client = new Anthropic(
    config.workspaceId
      ? { defaultHeaders: { "anthropic-workspace-id": config.workspaceId } }
      : {},
  );
  if (config.workspaceId) {
    console.log(`[qa-agent] workspace: ${config.workspaceId}`);
  }

  const startedAt = new Date();
  const startedMs = performance.now();
  let iterations = 0;
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  console.log(
    `[qa-agent] arrancando · modelo=${config.model} · tope=${config.maxIterations} iteraciones / ${config.maxRequests} requests`,
  );

  try {
    const runner = client.beta.messages.toolRunner({
      model: config.model,
      max_tokens: 4096,
      max_iterations: config.maxIterations,
      system: buildSystem(openapiYaml),
      tools,
      messages: [
        {
          role: "user",
          content: buildInitialUserMessage(config.baseUrl, config.maxRequests),
        },
      ],
    });

    for await (const message of runner) {
      iterations += 1;
      usage.input += message.usage.input_tokens ?? 0;
      usage.output += message.usage.output_tokens ?? 0;
      usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;

      console.log(
        `[qa-agent] iteración ${iterations}/${config.maxIterations} · ` +
          `${session.requestCount} requests · ${session.findings.length} findings`,
      );

      // El agente ya cerró la corrida: no hace falta seguir gastando iteraciones.
      if (session.outcome !== null) break;
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      fail("ANTHROPIC_API_KEY inválida o sin permisos.");
    }
    if (error instanceof Anthropic.RateLimitError) {
      fail("La API de Claude respondió rate limit. Reintentá la corrida.");
    }
    if (error instanceof Anthropic.APIError) {
      if (error.status === 400 && /workspace/i.test(error.message)) {
        fail(
          "Tu API key está vinculada a una identidad y requiere declarar el workspace. " +
            "Definí ANTHROPIC_WORKSPACE_ID con el id del workspace (lo encontrás en " +
            "console.anthropic.com -> Settings -> Workspaces).",
        );
      }
      fail(`La API de Claude falló (${error.status}): ${error.message}`);
    }
    fail(`Fallo inesperado durante la corrida: ${error instanceof Error ? error.message : String(error)}`);
  }

  const hitIterationCap = iterations >= config.maxIterations && session.outcome === null;
  const meta: RunMeta = {
    baseUrl: config.baseUrl,
    model: config.model,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - startedMs),
    iterations,
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

  // Diagnóstico del prompt caching: si cacheRead se queda en 0 a lo largo de
  // varias iteraciones, algo variable se coló en el prefijo del prompt.
  console.log(
    `[qa-agent] tokens · entrada=${usage.input} salida=${usage.output} ` +
      `cache_write=${usage.cacheWrite} cache_read=${usage.cacheRead}`,
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
