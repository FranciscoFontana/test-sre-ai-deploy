import { buildCoverage, type CoverageReport } from "./coverage.js";
import {
  SEVERITIES,
  SEVERITY_RANK,
  type Finding,
  type QaSession,
  type RequestLogEntry,
  type RunOutcome,
  type Severity,
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
}

export interface GateDecision {
  exitCode: 0 | 1;
  passed: boolean;
  reasons: string[];
}

/** Un grupo de requests que compartían la misma intención declarada. */
export interface CheckGroup {
  purpose: string;
  entries: RequestLogEntry[];
  /** true si algún finding apunta al mismo endpoint que este chequeo. */
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
  findings: Finding[],
): CheckGroup[] {
  const endpointsConFalla = findings
    .map((f) => parseEndpoint(f.endpoint))
    .filter((e): e is { method: string; path: string } => e !== null);

  const grupos = new Map<string, RequestLogEntry[]>();
  for (const entry of requestLog) {
    const purpose = entry.purpose?.trim() || "(sin intención declarada)";
    const actual = grupos.get(purpose);
    if (actual) actual.push(entry);
    else grupos.set(purpose, [entry]);
  }

  return [...grupos.entries()].map(([purpose, entries]) => ({
    purpose,
    entries,
    failed: entries.some((entry) =>
      endpointsConFalla.some((fallo) => {
        if (fallo.method !== entry.method) return false;
        // El endpoint del finding puede venir como plantilla (/api/todos/{id}).
        const base = fallo.path.replace(/\{[^}]*\}/g, "").replace(/\/+$/, "");
        return entry.path.toUpperCase().startsWith(base);
      }),
    ),
  }));
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
    checks: buildChecks(session.requestLog, session.findings),
    requestLog: session.requestLog,
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
    })),
    findings: data.findings,
    requestLog: data.requestLog,
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
  lines.push(gate.passed ? "## ✅ GATE APROBADO" : "## ❌ GATE BLOQUEADO");
  lines.push("");

  if (!gate.passed) {
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
  lines.push("| | Chequeo | Requests | Resultados |");
  lines.push("|---|---|---|---|");
  for (const check of checks) {
    const marca = check.failed ? "❌" : "✅";
    const statuses = check.entries.map(statusCell).join(", ");
    lines.push(`| ${marca} | ${check.purpose} | ${check.entries.length} | ${statuses} |`);
  }
  lines.push("");
  lines.push(
    "> El texto de cada chequeo lo escribió el agente antes de ejecutar la request. " +
      "La marca ❌ se deriva de que un hallazgo apunte al mismo endpoint; la lista " +
      "de hallazgos de abajo es la fuente de verdad.",
  );
  lines.push("");

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
