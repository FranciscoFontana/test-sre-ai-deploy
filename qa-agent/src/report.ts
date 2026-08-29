import {
  SEVERITIES,
  SEVERITY_RANK,
  type Finding,
  type QaSession,
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

/**
 * El gate. Un deploy sólo pasa si el agente cerró la corrida explícitamente
 * con veredicto pass y no dejó findings por encima del umbral.
 *
 * Una corrida que no llegó a cerrarse NO se toma como aprobada: no saber
 * si la app está bien no es lo mismo que saber que está bien.
 */
export function decideGate(session: QaSession, failOn: Severity, hitIterationCap: boolean): GateDecision {
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

export function buildJsonReport(session: QaSession, meta: RunMeta, gate: GateDecision) {
  return {
    schemaVersion: 1,
    meta,
    gate: { passed: gate.passed, exitCode: gate.exitCode, reasons: gate.reasons },
    verdict: session.outcome,
    counts: session.countsBySeverity(),
    findings: session.findings,
    requestLog: session.requestLog,
  };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🔵 low",
  info: "⚪ info",
};

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

export function buildMarkdownReport(session: QaSession, meta: RunMeta, gate: GateDecision): string {
  const counts = session.countsBySeverity();
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
  }

  if (session.outcome) {
    lines.push(`> **Veredicto del agente (${session.outcome.verdict}):** ${session.outcome.summary}`);
    lines.push("");
  }

  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Entorno probado | \`${meta.baseUrl}\` |`);
  lines.push(`| Modelo | \`${meta.model}\` |`);
  lines.push(`| Requests HTTP ejecutadas | ${session.requestCount} |`);
  lines.push(`| Iteraciones | ${meta.iterations} / ${meta.maxIterations}${meta.hitIterationCap ? " (tope alcanzado)" : ""} |`);
  lines.push(`| Duración | ${(meta.durationMs / 1000).toFixed(1)} s |`);
  lines.push(`| Umbral de bloqueo | \`${meta.failOn}\` o superior |`);
  lines.push("");

  const summaryCells = SEVERITIES.map((s) => `${SEVERITY_LABEL[s]}: **${counts[s]}**`).join(" · ");
  lines.push(`**Hallazgos:** ${summaryCells}`);
  lines.push("");

  if (session.findings.length === 0) {
    lines.push("No se encontraron desviaciones respecto del contrato.");
    lines.push("");
  } else {
    lines.push("## Hallazgos");
    lines.push("");
    const sorted = [...session.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    sorted.forEach((finding, i) => {
      lines.push(renderFinding(finding, i + 1));
      lines.push("");
    });
  }

  lines.push("<details><summary>Requests ejecutadas</summary>");
  lines.push("");
  lines.push("| # | Método | Path | Status | ms |");
  lines.push("|---|---|---|---|---|");
  session.requestLog.forEach((entry, i) => {
    const status = entry.status ?? `error: ${entry.error ?? "?"}`;
    lines.push(`| ${i + 1} | ${entry.method} | \`${entry.path}\` | ${status} | ${entry.latencyMs} |`);
  });
  lines.push("");
  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}
