import { parse as parseYaml } from "yaml";
import type { RequestLogEntry } from "./session.js";

/**
 * Un caso del contrato: una combinación de método, ruta y código de respuesta
 * que el OpenAPI documenta explícitamente.
 */
export interface ContractCase {
  method: string;
  pathTemplate: string;
  status: number;
  description: string;
}

export interface CoverageRow extends ContractCase {
  /** true si alguna request observó exactamente ese código en esa ruta. */
  covered: boolean;
  /** Cuántas veces se observó. */
  hits: number;
}

export interface CoverageReport {
  rows: CoverageRow[];
  total: number;
  covered: number;
  /** Requests que no corresponden a ningún caso documentado del contrato. */
  offContract: RequestLogEntry[];
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

/** Convierte /api/todos/{id} en un regex que matchea /api/todos/lo-que-sea. */
function templateToRegex(template: string): RegExp {
  const escaped = template
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{[^}]+\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

/** El log guarda la query string; para comparar contra el contrato sobra. */
function stripQuery(path: string): string {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
}

/**
 * Lee el contrato y enumera cada caso documentado.
 *
 * Deliberadamente no valida el OpenAPI ni resuelve $ref: sólo necesita la
 * grilla de método/ruta/status para cruzarla contra lo que el agente ejecutó.
 */
export function extractContractCases(openapiYaml: string): ContractCase[] {
  const doc = parseYaml(openapiYaml) as Record<string, unknown>;
  const paths = doc?.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const cases: ContractCase[] = [];
  for (const [pathTemplate, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const responses = (operation as Record<string, unknown>)?.responses as
        | Record<string, { description?: string }>
        | undefined;
      if (!responses) continue;

      for (const [statusKey, response] of Object.entries(responses)) {
        const status = Number(statusKey);
        if (!Number.isFinite(status)) continue; // ignora "default"
        const raw = response?.description ?? "";
        cases.push({
          method: method.toUpperCase(),
          pathTemplate,
          status,
          description: raw.replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
    }
  }
  return cases;
}

/**
 * Cruza los casos del contrato contra lo que el agente ejecutó realmente.
 *
 * Es la parte del reporte que no depende de lo que el agente diga de sí mismo:
 * se calcula del log de requests, así que no puede exagerar ni inventar
 * cobertura. "Cubierto" significa que se observó ese código en esa ruta, no
 * que se haya validado el cuerpo completo de la respuesta.
 */
export function buildCoverage(
  openapiYaml: string,
  requestLog: RequestLogEntry[],
): CoverageReport {
  const cases = extractContractCases(openapiYaml);
  const matchers = cases.map((c) => ({ ...c, regex: templateToRegex(c.pathTemplate) }));

  const rows: CoverageRow[] = matchers.map((matcher) => {
    const hits = requestLog.filter(
      (entry) =>
        entry.method === matcher.method &&
        entry.status === matcher.status &&
        matcher.regex.test(stripQuery(entry.path)),
    ).length;
    return {
      method: matcher.method,
      pathTemplate: matcher.pathTemplate,
      status: matcher.status,
      description: matcher.description,
      covered: hits > 0,
      hits,
    };
  });

  // Requests que no encajan en ningún caso documentado. Suelen ser
  // exploración legítima (rutas inexistentes, métodos no soportados), pero
  // conviene verlas: si son muchas, el contrato está incompleto.
  const offContract = requestLog.filter(
    (entry) =>
      !matchers.some(
        (matcher) =>
          entry.method === matcher.method &&
          entry.status === matcher.status &&
          matcher.regex.test(stripQuery(entry.path)),
      ),
  );

  return {
    rows,
    total: rows.length,
    covered: rows.filter((r) => r.covered).length,
    offContract,
  };
}
