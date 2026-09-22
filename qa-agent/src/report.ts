import { buildCoverage, type CoverageReport } from "./coverage.js";
import {
  SEVERITIES,
  SEVERITY_RANK,
  type Finding,
  type QaSession,
  type RequestLogEntry,
  type RunOutcome,
  type Severity,
  type UiActionEntry,
} from "./session.js";

export interface RunMeta {
  baseUrl: string;
  model: string;
  startedAt: string;
  durationMs: number;
  iterations: number;
  maxIterations: number;
  hitIterationCap: boolean;
  failOn: Severity;
  /** Presente sólo si la corrida se interrumpió antes de terminar. */
  abortReason?: string;
}

/**
 * 0 = QA aprobado · 1 = QA rechazó el build · 2 = la corrida no pudo completarse.
 * El 2 no dice que la app esté mal: dice que no se sabe.
 */
export interface GateDecision {
  exitCode: 0 | 1 | 2;
  passed: boolean;
  reasons: string[];
}

/**
 * Un chequeo: todo lo que el agente hizo bajo una misma intención declarada,
 * sin importar si fue contra la API o contra la interfaz. Una verificación
 * puede tener evidencia de las dos superficies.
 */
export interface CheckGroup {
  purpose: string;
  entries: RequestLogEntry[];
  uiEntries: UiActionEntry[];
  /** true si un finding apunta al mismo endpoint, o si una acción de UI falló. */
  failed: boolean;
}

export interface ReportData {
  meta: RunMeta;
  gate: GateDecision;
  outcome: RunOutcome | null;
  findings: Finding[];
  counts: Record<Severity, number>;
  coverage: CoverageReport;
  checks: CheckGroup[];
  requestLog: RequestLogEntry[];
  uiLog: UiActionEntry[];
}

/**
 * El gate. Un deploy sólo pasa si el agente cerró la corrida explícitamente
 * con veredicto pass y no dejó findings por encima del umbral.
 *
 * Una corrida que no llegó a cerrarse NO se toma como aprobada: no saber
 * si la app está bien no es lo mismo que saber que está bien.
 */
export function decideGate(
  session: QaSession,
  failOn: Severity,
  hitIterationCap: boolean,
): GateDecision {
  const reasons: string[] = [];
  const blocking = session.findingsAtOrAbove(failOn);

  if (blocking.length > 0) {
    reasons.push(
      `${blocking.length} finding(s) con gravedad ${failOn} o superior: ` +
        blocking.map((f) => f.title).join("; "),
    );
  }
  if (session.outcome === null) {
    reasons.push(
      hitIterationCap
        ? "La corrida se cortó por el tope de iteraciones sin llamar a finish_run: cobertura incompleta."
        : "El agente terminó sin llamar a finish_run: la corrida quedó incompleta.",
    );
  } else if (session.outcome.verdict === "fail") {
    reasons.push(`Veredicto del agente: fail — ${session.outcome.summary}`);
    // El veredicto y los findings deberían contar la misma historia. Que no
    // coincidan casi siempre significa que report_finding falló y el detalle
    // quedó sólo como prosa: el bloqueo es correcto, pero el reporte queda
    // sin nada accionable para quien tenga que arreglarlo.
    if (session.findings.length === 0) {
      reasons.push(
        "El agente cerró con fail pero no registró ningún finding con report_finding: " +
          "el detalle existe sólo en el resumen y el reporte queda sin evidencia estructurada.",
      );
    }
  }
  if (session.requestCount === 0) {
    reasons.push("El agente no ejecutó ninguna request HTTP: la corrida no probó nada.");
  }

  const passed = reasons.length === 0;
  return { exitCode: passed ? 0 : 1, passed, reasons };
}

/**
 * El gate de una corrida que se interrumpió antes de terminar.
 *
 * Nunca aprueba: no saber si la app está bien no es lo mismo que saber que lo
 * está. Pero tampoco dice que esté mal. Lo que el agente alcanzó a registrar se
 * informa como parcial, para que quien lea el reporte sepa qué se probó y qué
 * encontró hasta el corte, en vez de quedarse sin nada.
 */
export function abortedGate(session: QaSession, failOn: Severity, reason: string): GateDecision {
  const reasons = [`La corrida se interrumpió antes de terminar: ${reason}`];

  const blocking = session.findingsAtOrAbove(failOn);
  if (blocking.length > 0) {
    reasons.push(
      `Hasta el corte ya había ${blocking.length} finding(s) con gravedad ${failOn} o superior: ` +
        blocking.map((f) => f.title).join("; "),
    );
  }
  reasons.push(
    `Resultado parcial: ${session.requestCount} requests y ${session.findings.length} finding(s) ` +
      "registrados antes de la interrupción. La cobertura quedó incompleta.",
  );

  return { exitCode: 2, passed: false, reasons };
}

/** Saca el método y la ruta de un endpoint escrito por el modelo. */
function parseEndpoint(endpoint: string): { method: string; path: string } | null {
  const match = /^\s*([A-Z]+)\s+(\S+)/.exec(endpoint.trim().toUpperCase());
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { method: match[1], path: match[2] };
}

/**
 * Agrupa las requests por la intención que el agente declaró.
 *
 * El estado de cada grupo es DERIVADO, no declarado: se marca como fallado si
 * algún finding apunta al mismo endpoint. Es una heurística y el reporte lo
 * dice; la fuente de verdad de los fallos sigue siendo la lista de findings.
 */
export function buildChecks(
  requestLog: RequestLogEntry[],
  uiLog: UiActionEntry[],
  findings: Finding[],
): CheckGroup[] {
  const endpointsConFalla = findings
    .map((f) => parseEndpoint(f.endpoint))
    .filter((e): e is { method: string; path: string } => e !== null);

  const SIN_INTENCION = "(sin intención declarada)";
  const grupos = new Map<string, CheckGroup>();

  const obtener = (purpose: string): CheckGroup => {
    const clave = purpose.trim() || SIN_INTENCION;
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = { purpose: clave, entries: [], uiEntries: [], failed: false };
      grupos.set(clave, grupo);
    }
    return grupo;
  };

  for (const entry of requestLog) obtener(entry.purpose ?? "").entries.push(entry);
  for (const entry of uiLog) obtener(entry.purpose ?? "").uiEntries.push(entry);

  for (const grupo of grupos.values()) {
    const porFinding = grupo.entries.some((entry) =>
      endpointsConFalla.some((fallo) => {
        if (fallo.method !== entry.method) return false;
        // El endpoint del finding puede venir como plantilla (/api/todos/{id}).
        const base = fallo.path.replace(/\{[^}]*\}/g, "").replace(/\/+$/, "");
        return entry.path.toUpperCase().startsWith(base);
      }),
    );
    // Una acción de UI que no se pudo ejecutar es un fallo directo, no
    // derivado: el botón no estaba, o no respondió.
    const porUi = grupo.uiEntries.some((entry) => !entry.ok);
    grupo.failed = porFinding || porUi;
  }

  return [...grupos.values()];
}

export function buildReportData(
  session: QaSession,
  meta: RunMeta,
  gate: GateDecision,
  openapiYaml: string,
): ReportData {
  return {
    meta,
    gate,
    outcome: session.outcome,
    findings: [...session.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    ),
    counts: session.countsBySeverity(),
    coverage: buildCoverage(openapiYaml, session.requestLog),
    checks: buildChecks(session.requestLog, session.uiLog, session.findings),
    requestLog: session.requestLog,
    uiLog: session.uiLog,
  };
}

export function buildJsonReport(data: ReportData) {
  return {
    schemaVersion: 2,
    meta: data.meta,
    gate: data.gate,
    verdict: data.outcome,
    counts: data.counts,
    coverage: {
      total: data.coverage.total,
      covered: data.coverage.covered,
      rows: data.coverage.rows,
      offContractCount: data.coverage.offContract.length,
    },
    checks: data.checks.map((c) => ({
      purpose: c.purpose,
      failed: c.failed,
      requests: c.entries.length,
      uiActions: c.uiEntries.length,
    })),
    findings: data.findings,
    requestLog: data.requestLog,
    // Sin las capturas: son cientos de KB de base64 y ya están en el HTML.
    uiLog: data.uiLog.map(({ screenshot, ...resto }) => ({
      ...resto,
      hasScreenshot: screenshot !== undefined,
    })),
  };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🔵 low",
  info: "⚪ info",
};

function statusCell(entry: RequestLogEntry): string {
  return entry.status === null ? `error: ${entry.error ?? "?"}` : String(entry.status);
}

function renderFinding(finding: Finding, index: number): string {
  return [
    `### ${index}. ${finding.title}`,
    "",
    `**Gravedad:** ${SEVERITY_LABEL[finding.severity]}  `,
    `**Endpoint:** \`${finding.endpoint}\``,
    "",
    `**Esperado (según el contrato):** ${finding.expected}`,
    "",
    `**Observado:** ${finding.actual}`,
    "",
    "**Reproducción:**",
    "",
    "```",
    finding.reproduction,
    "```",
  ].join("\n");
}

export function buildMarkdownReport(data: ReportData): string {
  const { meta, gate, coverage, checks, counts } = data;
  const lines: string[] = [];

  lines.push("# Reporte de QA automatizado");
  lines.push("");
  lines.push(
    gate.passed
      ? "## ✅ GATE APROBADO"
      : gate.exitCode === 2
        ? "## ⚠️ GATE NO EJECUTADO — corrida incompleta"
        : "## ❌ GATE BLOQUEADO",
  );
  lines.push("");

  if (gate.exitCode === 2) {
    lines.push(
      "El deploy a producción se detiene porque la corrida no pudo completarse. " +
        "Esto **no** significa que la aplicación tenga un problema: significa que no se llegó a verificar.",
    );
    lines.push("");
    for (const reason of gate.reasons) lines.push(`- ${reason}`);
    lines.push("");
  } else if (!gate.passed) {
    lines.push("El deploy a producción se detiene por:");
    lines.push("");
    for (const reason of gate.reasons) lines.push(`- ${reason}`);
    lines.push("");
  } else if (data.outcome) {
    lines.push(`> **Veredicto del agente (pass):** ${data.outcome.summary}`);
    lines.push("");
  }

  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Entorno probado | \`${meta.baseUrl}\` |`);
  lines.push(`| Modelo | \`${meta.model}\` |`);
  lines.push(`| Chequeos ejecutados | ${checks.length} |`);
  lines.push(`| Requests HTTP | ${data.requestLog.length} |`);
  lines.push(`| Acciones sobre la interfaz | ${data.uiLog.length} |`);
  lines.push(`| Cobertura del contrato | ${coverage.covered} de ${coverage.total} casos |`);
  lines.push(
    `| Iteraciones | ${meta.iterations} / ${meta.maxIterations}${meta.hitIterationCap ? " (tope alcanzado)" : ""} |`,
  );
  lines.push(`| Duración | ${(meta.durationMs / 1000).toFixed(1)} s |`);
  lines.push(`| Umbral de bloqueo | \`${meta.failOn}\` o superior |`);
  lines.push("");
  lines.push(
    `**Hallazgos:** ${SEVERITIES.map((s) => `${SEVERITY_LABEL[s]}: **${counts[s]}**`).join(" · ")}`,
  );
  lines.push("");

  // --- Cobertura -------------------------------------------------------
  lines.push("## Cobertura del contrato");
  lines.push("");
  lines.push(
    `Se cruzaron los **${coverage.total} casos** que documenta el OpenAPI contra las requests ` +
      `que el agente ejecutó realmente. Esta sección **no depende de lo que el agente diga**: ` +
      "se calcula del log.",
  );
  lines.push("");
  lines.push("| Caso del contrato | Estado | Veces |");
  lines.push("|---|---|---|");
  for (const row of coverage.rows) {
    const estado = row.covered ? "✅ verificado" : "⬜ no probado";
    lines.push(
      `| \`${row.method} ${row.pathTemplate}\` → ${row.status} | ${estado} | ${row.hits} |`,
    );
  }
  lines.push("");
  if (coverage.offContract.length > 0) {
    lines.push(
      `Además hizo **${coverage.offContract.length} requests fuera del contrato** ` +
        "(rutas o combinaciones que el OpenAPI no documenta), que es exploración legítima.",
    );
    lines.push("");
  }
  lines.push(
    "> *Verificado* significa que se observó ese código en esa ruta, no que se haya " +
      "validado el cuerpo completo de la respuesta.",
  );
  lines.push("");

  // --- Chequeos --------------------------------------------------------
  lines.push("## Qué probó el agente");
  lines.push("");
  lines.push("| | Chequeo | Superficie | Evidencia |");
  lines.push("|---|---|---|---|");
  for (const check of checks) {
    const marca = check.failed ? "❌" : "✅";
    const superficies: string[] = [];
    if (check.entries.length > 0) superficies.push(`API (${check.entries.length})`);
    if (check.uiEntries.length > 0) superficies.push(`UI (${check.uiEntries.length})`);
    const evidencia = [
      ...check.entries.map(statusCell),
      ...check.uiEntries.map((e) => (e.ok ? e.action : `${e.action} falló`)),
    ].join(", ");
    lines.push(
      `| ${marca} | ${check.purpose} | ${superficies.join(" + ")} | ${evidencia} |`,
    );
  }
  lines.push("");
  lines.push(
    "> El texto de cada chequeo lo escribió el agente antes de ejecutar la request. " +
      "La marca ❌ se deriva de que un hallazgo apunte al mismo endpoint; la lista " +
      "de hallazgos de abajo es la fuente de verdad.",
  );
  lines.push("");

  // --- Interfaz --------------------------------------------------------
  if (data.uiLog.length > 0) {
    const fallidas = data.uiLog.filter((e) => !e.ok).length;
    lines.push("## Recorrido por la interfaz");
    lines.push("");
    lines.push(
      `El agente operó la aplicación en un navegador real: **${data.uiLog.length} acciones**` +
        (fallidas > 0 ? `, de las cuales **${fallidas} fallaron**.` : ", todas exitosas.") +
        " Las capturas de cada paso están en el reporte HTML.",
    );
    lines.push("");
    lines.push("| # | Acción | Sobre | Detalle | |");
    lines.push("|---|---|---|---|---|");
    data.uiLog.forEach((entry, i) => {
      lines.push(
        `| ${i + 1} | ${entry.action} | ${entry.target ?? "—"} | ${entry.detail ?? "—"} | ${entry.ok ? "✅" : `❌ ${entry.error ?? ""}`} |`,
      );
    });
    lines.push("");
  }

  // --- Hallazgos -------------------------------------------------------
  if (data.findings.length === 0) {
    lines.push("## Hallazgos");
    lines.push("");
    lines.push("No se encontraron desviaciones respecto del contrato.");
    lines.push("");
  } else {
    lines.push("## Hallazgos");
    lines.push("");
    data.findings.forEach((finding, i) => {
      lines.push(renderFinding(finding, i + 1));
      lines.push("");
    });
  }

  // --- Evidencia -------------------------------------------------------
  lines.push("<details><summary>Evidencia: todas las requests con su cuerpo</summary>");
  lines.push("");
  data.requestLog.forEach((entry, i) => {
    lines.push(`**${i + 1}. ${entry.method} \`${entry.path}\`** → ${statusCell(entry)} · ${entry.latencyMs} ms`);
    if (entry.purpose) lines.push(`> ${entry.purpose}`);
    if (entry.requestBody) {
      lines.push("");
      lines.push(`Enviado (${entry.bodyBytes} bytes):`);
      lines.push("```json");
      lines.push(entry.requestBody);
      lines.push("```");
    }
    if (entry.responseBody) {
      lines.push("");
      lines.push("Recibido:");
      lines.push("```json");
      lines.push(entry.responseBody);
      lines.push("```");
    }
    lines.push("");
  });
  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}
