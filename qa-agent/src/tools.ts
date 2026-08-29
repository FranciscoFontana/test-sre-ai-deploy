import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { SEVERITIES, type QaSession, type Severity } from "./session.js";

/** Techo de caracteres del cuerpo de respuesta que se le devuelve al modelo. */
const MAX_BODY_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

function truncate(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n...[truncado, ${text.length} caracteres en total]`;
}

export function buildTools(session: QaSession) {
  /**
   * Ejecuta una request HTTP contra el entorno bajo prueba.
   *
   * La URL base está fijada en el servidor, no en el input: el modelo sólo
   * elige un `path`. Es lo que impide que el agente le pegue a cualquier
   * otro host, aunque el prompt lo indujera a hacerlo.
   */
  const httpRequest = betaTool({
    name: "http_request",
    description: [
      "Ejecuta una request HTTP contra la aplicación bajo prueba y devuelve la respuesta.",
      "Sólo se indica el path (por ejemplo '/api/todos'): el host es fijo y no se puede cambiar.",
      "El campo 'body' es un STRING crudo, no un objeto: mandá JSON serializado.",
      "Eso te permite probar a propósito cuerpos malformados, por ejemplo '{\"title\": '.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"],
          description: "Método HTTP.",
        },
        path: {
          type: "string",
          description:
            "Path que arranca con '/', incluyendo query string si hace falta. Ej: '/api/todos?done=true'.",
        },
        body: {
          type: "string",
          description: "Cuerpo crudo de la request como string. Omitir para GET/DELETE.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Headers extra. Si mandás body y no especificás content-type, se asume application/json.",
        },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (session.requestCount >= session.maxRequests) {
        return JSON.stringify({
          error: `Se alcanzó el tope de ${session.maxRequests} requests de esta corrida. No hagas más llamadas: cerrá con finish_run usando lo que ya observaste.`,
        });
      }

      const path = input.path;
      if (!path.startsWith("/")) {
        return JSON.stringify({
          error: "El path debe empezar con '/'. No se aceptan URLs absolutas.",
        });
      }

      const url = `${session.baseUrl}${path}`;
      const headers: Record<string, string> = { ...(input.headers ?? {}) };
      if (input.body !== undefined && !("content-type" in headers) && !("Content-Type" in headers)) {
        headers["content-type"] = "application/json";
      }

      const startedAt = performance.now();
      try {
        const response = await fetch(url, {
          method: input.method,
          headers,
          ...(input.body !== undefined ? { body: input.body } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const latencyMs = Math.round(performance.now() - startedAt);
        const text = await response.text();

        session.requestLog.push({
          method: input.method,
          path,
          status: response.status,
          latencyMs,
        });

        return JSON.stringify({
          status: response.status,
          contentType: response.headers.get("content-type"),
          latencyMs,
          body: truncate(text),
        });
      } catch (error) {
        const latencyMs = Math.round(performance.now() - startedAt);
        const message = error instanceof Error ? error.message : String(error);
        session.requestLog.push({
          method: input.method,
          path,
          status: null,
          latencyMs,
          error: message,
        });
        return JSON.stringify({
          status: null,
          latencyMs,
          error: `La request falló sin respuesta HTTP: ${message}`,
        });
      }
    },
  });

  /** Registra un hallazgo. Append-only: no hay forma de borrar ni editar. */
  const reportFinding = betaTool({
    name: "report_finding",
    description: [
      "Registra un bug encontrado. Llamalo una vez por cada problema distinto, apenas lo confirmes.",
      "Sólo reportá cosas que hayas verificado con una request real y que contradigan el contrato OpenAPI.",
      "Un finding sin reproducción concreta no sirve.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: [...SEVERITIES],
          description: [
            "critical: pérdida o corrupción de datos, 5xx ante entrada normal, exposición de datos internos.",
            "high: viola el contrato de forma que rompe a un cliente (status incorrecto, validación ausente).",
            "medium: desviación real del contrato con impacto acotado.",
            "low: inconsistencia menor.",
            "info: observación que no es un bug.",
          ].join(" "),
        },
        title: { type: "string", description: "Resumen en una línea." },
        endpoint: {
          type: "string",
          description: "Método y path afectados. Ej: 'POST /api/todos'.",
        },
        expected: {
          type: "string",
          description: "Qué exige el contrato, citando la parte relevante del OpenAPI.",
        },
        actual: { type: "string", description: "Qué devolvió realmente la aplicación." },
        reproduction: {
          type: "string",
          description:
            "Pasos exactos: método, path, cuerpo enviado y respuesta observada (status y cuerpo).",
        },
      },
      required: ["severity", "title", "endpoint", "expected", "actual", "reproduction"],
      additionalProperties: false,
    },
    run: async (input) => {
      session.findings.push({
        severity: input.severity as Severity,
        title: input.title,
        endpoint: input.endpoint,
        expected: input.expected,
        actual: input.actual,
        reproduction: input.reproduction,
      });
      return JSON.stringify({
        recorded: true,
        totalFindings: session.findings.length,
      });
    },
  });

  /** Cierra la corrida. Sin esta llamada, la corrida se considera incompleta. */
  const finishRun = betaTool({
    name: "finish_run",
    description: [
      "Cerrá la corrida cuando hayas cubierto el contrato. Llamalo exactamente una vez, al final.",
      "verdict 'fail' si encontraste algo que debería frenar el deploy; 'pass' si la aplicación respeta el contrato.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        summary: {
          type: "string",
          description:
            "Dos o tres frases: qué probaste, qué encontraste y por qué ese veredicto.",
        },
      },
      required: ["verdict", "summary"],
      additionalProperties: false,
    },
    run: async (input) => {
      session.outcome = { verdict: input.verdict, summary: input.summary };
      return JSON.stringify({ acknowledged: true });
    },
  });

  return [httpRequest, reportFinding, finishRun];
}
