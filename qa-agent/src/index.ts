import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, listAvailableModels, runAgent } from "./agent.js";
import { BrowserSession } from "./browser.js";
import { buildInitialUserMessage, buildSystemInstruction } from "./prompt.js";
import { buildHtmlReport } from "./html.js";
import {
  abortedGate,
  buildJsonReport,
  buildMarkdownReport,
  buildReportData,
  decideGate,
  type GateDecision,
  type RunMeta,
} from "./report.js";
import { QaSession, SEVERITIES, type Severity } from "./session.js";
import { buildTools } from "./tools.js";
import { buildUiTools } from "./ui-tools.js";

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
  //
  // Historia de la elección:
  //
  // Primero se eligió gemini-3.5-flash-lite por medición: cerró en 5
  // iteraciones, sin llamadas corruptas y con 29k tokens contra 271k.
  //
  // El 22/09/2026 flash-lite quedó saturado durante horas ("This model is
  // currently experiencing high demand") y se pasó a gemini-3.5-flash, que
  // respondía más rápido. Pero ese mismo día se agotó su cuota DIARIA sin
  // haber completado una sola corrida: cada reintento ante un 503 también
  // consume cuota, y las ráfagas de ese día se llevaron el presupuesto.
  //
  // Se vuelve a flash-lite, que nunca llegó al 429 ese día —sólo fallaba por
  // saturación— y por lo tanto conserva su cuota, además de ser el que mejor
  // funcionó: 5 iteraciones, sin llamadas corruptas, 29k tokens contra 271k.
  model: process.env.QA_MODEL ?? "gemini-3.5-flash-lite",
  // Medido: el agente hace el trabajo útil en las primeras 5 iteraciones y
  // después se queda girando, una request por turno, sin converger. Como cada
  // iteración reenvía todo el historial, las de más cuestan cuota y no aportan.
  maxIterations: Number(process.env.QA_MAX_ITERATIONS ?? 22),
  maxRequests: Number(process.env.QA_MAX_REQUESTS ?? 80),
  // Gemini 3.x razona antes de responder y ese pensamiento consume presupuesto
  // de salida. Con un tope bajo el modelo se queda sin margen justo antes de
  // emitir la llamada de cierre y devuelve una respuesta vacía.
  maxOutputTokens: Number(process.env.QA_MAX_OUTPUT_TOKENS ?? 16384),
  // Medido con Gemini degradado: llamadas legítimas de hasta 90 s. Por encima
  // de 120 s se asume que la llamada quedó colgada, se aborta y se reintenta.
  requestTimeoutMs: Number(process.env.QA_REQUEST_TIMEOUT_MS ?? 120_000),
  failOn: parseSeverity(readArg("--fail-on") ?? process.env.QA_FAIL_ON, "high"),
  outDir: readArg("--out-dir") ?? process.env.QA_OUT_DIR ?? process.cwd(),
  contractPath: process.env.QA_CONTRACT_PATH ?? join(REPO_ROOT, "contracts", "openapi.yaml"),
};

/** Escribe los tres reportes. Se usa tanto al terminar como al abortar. */
function writeReports(
  session: QaSession,
  meta: RunMeta,
  gate: GateDecision,
  openapiYaml: string,
) {
  const data = buildReportData(session, meta, gate, openapiYaml);
  const paths = {
    md: resolve(config.outDir, "qa-report.md"),
    json: resolve(config.outDir, "qa-report.json"),
    html: resolve(config.outDir, "qa-report.html"),
  };
  writeFileSync(paths.md, buildMarkdownReport(data), "utf8");
  writeFileSync(paths.json, JSON.stringify(buildJsonReport(data), null, 2), "utf8");
  writeFileSync(paths.html, buildHtmlReport(data), "utf8");
  return { data, paths };
}

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
  // El gate falla cerrado: hasta que la corrida termine y decida, el código de
  // salida dice "no se pudo ejecutar". Si el proceso terminara antes por
  // cualquier motivo imprevisto —por ejemplo, que el event loop se vacíe en
  // medio de una llamada—, Node saldría con 0 y el pipeline lo leería como QA
  // aprobado. Se detectó forzando una llamada colgada en una prueba.
  process.exitCode = EXIT_INFRA_ERROR;

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
  const browser = new BrowserSession(session);
  const tools = [...buildTools(session), ...buildUiTools(browser)];

  const startedAt = new Date();
  const startedMs = performance.now();
  let iterationsDone = 0;

  console.log(
    `[qa-agent] arrancando · modelo=${config.model} · tope=${config.maxIterations} iteraciones / ${config.maxRequests} requests · timeout ${Math.round(config.requestTimeoutMs / 1000)} s por llamada`,
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
      requestTimeoutMs: config.requestTimeoutMs,
      closingToolName: "finish_run",
      shouldStop: () => session.outcome !== null,
      onIteration: (iteration) => {
        iterationsDone = iteration;
        console.log(
          `[qa-agent] iteración ${iteration}/${config.maxIterations} · ` +
            `${session.requestCount} requests · ${session.findings.length} findings`,
        );
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // Lo que el agente alcanzó a hacer se guarda igual. Antes, una corrida que
    // abortaba no dejaba nada: en una corrida real se perdieron 21 requests y
    // un hallazgo registrado, y no hubo forma de saber qué había encontrado.
    // Si escribir el reporte falla, no puede tapar el error original.
    try {
      const partialMeta: RunMeta = {
        baseUrl: config.baseUrl,
        model: config.model,
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(performance.now() - startedMs),
        iterations: iterationsDone,
        maxIterations: config.maxIterations,
        hitIterationCap: false,
        failOn: config.failOn,
        abortReason: reason,
      };
      const { paths } = writeReports(
        session,
        partialMeta,
        abortedGate(session, config.failOn, reason),
        openapiYaml,
      );
      console.error(
        `[qa-agent] reporte parcial escrito: ${session.requestCount} requests y ` +
          `${session.findings.length} finding(s) hasta el corte`,
      );
      console.error(`[qa-agent]   ${paths.md}`);
      console.error(`[qa-agent]   ${paths.html}`);
    } catch (reportError) {
      console.error(
        `[qa-agent] no se pudo escribir el reporte parcial: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }

    // Un 404 casi siempre es un id de modelo que no existe en este tier.
    // Listar lo disponible ahorra una vuelta de diagnóstico.
    if (error instanceof AgentError && /404/.test(reason)) {
      const available = await listAvailableModels(config.apiKey, config.requestTimeoutMs);
      if (available.length > 0) {
        console.error(`\n[qa-agent] modelos disponibles para tu key: ${available.join(", ")}`);
      }
    }
    fail(reason);
  } finally {
    // Sin esto Chromium queda vivo y el proceso nunca termina.
    await browser.close();
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
  const { data, paths } = writeReports(session, meta, gate, openapiYaml);
  const mdPath = paths.md;
  const jsonPath = paths.json;
  const htmlPath = paths.html;

  console.log(
    `[qa-agent] tokens · prompt=${result.usage.promptTokens} ` +
      `respuesta=${result.usage.responseTokens} total=${result.usage.totalTokens}`,
  );
  console.log(
    `[qa-agent] cobertura del contrato · ${data.coverage.covered}/${data.coverage.total} casos · ` +
      `${data.checks.length} chequeos · ${session.requestCount} requests · ` +
      `${session.uiLog.length} acciones de UI`,
  );
  console.log(`[qa-agent] reportes: ${mdPath}`);
  console.log(`[qa-agent]           ${jsonPath}`);
  console.log(`[qa-agent]           ${htmlPath}`);

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
