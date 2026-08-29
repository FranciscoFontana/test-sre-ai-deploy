export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Orden de gravedad: índice más bajo = más grave. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export interface Finding {
  severity: Severity;
  title: string;
  endpoint: string;
  expected: string;
  actual: string;
  reproduction: string;
}

export interface RunOutcome {
  verdict: "pass" | "fail";
  summary: string;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number | null;
  latencyMs: number;
  error?: string;
}

/**
 * Estado de una corrida de QA. Acumula lo que el agente reporta y lo que
 * realmente ejecutó. Los findings son append-only a propósito: el agente
 * no tiene ninguna herramienta para borrar o editar lo ya reportado.
 */
export class QaSession {
  readonly baseUrl: string;
  readonly maxRequests: number;
  readonly findings: Finding[] = [];
  readonly requestLog: RequestLogEntry[] = [];
  outcome: RunOutcome | null = null;

  constructor(baseUrl: string, maxRequests = 80) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.maxRequests = maxRequests;
  }

  get requestCount(): number {
    return this.requestLog.length;
  }

  /** Findings con gravedad igual o mayor al umbral dado. */
  findingsAtOrAbove(threshold: Severity): Finding[] {
    return this.findings.filter(
      (f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[threshold],
    );
  }

  countsBySeverity(): Record<Severity, number> {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of this.findings) counts[f.severity] += 1;
    return counts;
  }
}
