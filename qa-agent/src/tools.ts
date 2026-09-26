import { SEVERITIES, type QaSession, type Severity } from "./session.js";

/** Techo de caracteres del cuerpo de respuesta que se le devuelve al modelo. */
const MAX_BODY_CHARS = 2000;
/** Techo de la evidencia que se guarda en el reporte: no hace falta tanto. */
const MAX_EVIDENCE_CHARS = 400;
const REQUEST_TIMEOUT_MS = 10_000;

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"];

/**
 * Herramienta neutral respecto del proveedor.
 *
 * El esquema es JSON Schema plano, que es lo que acepta Gemini vía
 * `parametersJsonSchema`, y `run` recibe los argumentos sin tipar porque el
 * modelo puede mandar cualquier cosa: cada herramienta valida lo que necesita.
 * Mantenerlas así hace que cambiar de proveedor toque sólo la capa de cliente.
 */
export interface QaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

function truncate(text: string, max = MAX_BODY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncado, ${text.length} caracteres en total]`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Techo del relleno en el cuerpo, para que un {{PAD:...}} enorme no se coma la memoria. */
const MAX_PAD_CHARS = 2_000_000;

/**
 * Techo del relleno en la URL. Node rechaza con 431 una request cuya línea de
 * pedido más los headers pasan de 16 KB, así que un relleno más grande no
 * probaría la app sino el servidor HTTP. Con 4000 alcanza para cualquier
 * límite de longitud razonable de un parámetro.
 */
const MAX_PAD_CHARS_PATH = 4_000;

const PAD_MARKER = /\{\{PAD:(\d+)\}\}/g;

/**
 * Un intento de marcador PAD que no tiene la forma exacta: {{PAD}},
 * {{pad:5}}, {{ PAD:5 }}. Deliberadamente no atrapa cualquier {{...}}: un
 * texto como {{7*7}} es una prueba legítima de inyección de plantillas y
 * tiene que llegar a la app tal cual.
 */
const MALFORMED_PAD = /\{\{\s*PAD\b[^}]*\}\}/i;

/**
 * Expande {{PAD:n}} a n caracteres, en el cuerpo o en el path.
 *
 * Existe porque el modelo no puede escribir un cuerpo de 100kb ni un
 * parámetro de cientos de caracteres: tendría que emitirlos dentro de los
 * argumentos de la llamada, y además los cuenta mal. Sin esto, al intentar
 * probar el límite de tamaño mandaba un cuerpo truncado, recibía
 * MALFORMED_JSON y reportaba como bug lo que era una limitación de la
 * herramienta.
 *
 * Al principio sólo se expandía en el cuerpo. El agente, razonablemente, lo
 * usó también en un parámetro de query (?q={{PAD:105}}); el marcador viajó
 * literal, 11 caracteres, la app respondió 200 como correspondía, y el
 * agente reportó un bug que no existía y bloqueó un deploy.
 */
function expandPadding(text: string, max: number): string {
  return text.replace(PAD_MARKER, (_match, digits: string) => "A".repeat(Math.min(Number(digits), max)));
}

/** El mayor n de los {{PAD:n}} presentes, o 0 si no hay ninguno. */
function largestPad(text: string): number {
  let largest = 0;
  for (const match of text.matchAll(PAD_MARKER)) {
    largest = Math.max(largest, Number(match[1]));
  }
  return largest;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function buildTools(session: QaSession): QaTool[] {
  /**
   * Ejecuta una request HTTP contra el entorno bajo prueba.
   *
   * La URL base está fijada del lado del servidor, no en el input: el modelo
   * sólo elige un `path`. Es lo que impide que el agente le pegue a cualquier
   * otro host, aunque el prompt lo indujera a hacerlo.
   */
  const httpRequest: QaTool = {
    name: "http_request",
    description: [
      "Ejecuta una request HTTP contra la aplicación bajo prueba y devuelve la respuesta.",
      "El campo purpose es obligatorio: escribí en una línea qué estás verificando.",
      "Va al reporte y es lo que permite mostrar qué se probó y con qué resultado.",
      "Sólo se indica el path (por ejemplo /api/todos): el host es fijo y no se puede cambiar.",
      "El campo body es un STRING crudo, no un objeto: mandá JSON ya serializado.",
      "Eso te permite probar a propósito cuerpos malformados, por ejemplo un JSON sin cerrar.",
      "Para probar límites de tamaño usá el marcador {{PAD:n}}: se reemplaza por n caracteres",
      "antes de enviar, y funciona tanto en el body como en el path.",
      'En el body: {"title":"{{PAD:150000}}"} manda un cuerpo de más de 100kb.',
      "En el path: /api/todos?q={{PAD:105}} manda un parámetro q de 105 caracteres (máximo 4000).",
      "Escribir vos mismo textos tan largos es imposible y los contarías mal: usá siempre el marcador.",
      "La respuesta informa sentBodyBytes y sentPathChars para que confirmes cuánto viajó.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: HTTP_METHODS, description: "Método HTTP." },
        purpose: {
          type: "string",
          description:
            "Qué estás verificando con esta request, en una línea. Ej: rechazar título vacío.",
        },
        path: {
          type: "string",
          description:
            "Path que arranca con /, incluyendo query string si hace falta. Ej: /api/todos?done=true",
        },
        body: {
          type: "string",
          description: "Cuerpo crudo de la request como string. Omitir para GET y DELETE.",
        },
        headers: {
          type: "object",
          description:
            "Headers extra. Si mandás body y no especificás content-type, se asume application/json.",
        },
      },
      required: ["method", "path", "purpose"],
    },
    run: async (args) => {
      if (session.requestCount >= session.maxRequests) {
        return JSON.stringify({
          error: `Se alcanzó el tope de ${session.maxRequests} requests de esta corrida. No hagas más llamadas: cerrá con finish_run usando lo que ya observaste.`,
        });
      }

      const method = (asString(args.method) ?? "").toUpperCase();
      if (!HTTP_METHODS.includes(method)) {
        return JSON.stringify({
          error: `Método inválido. Usá uno de: ${HTTP_METHODS.join(", ")}.`,
        });
      }

      const path = asString(args.path);
      if (path === undefined || !path.startsWith("/")) {
        return JSON.stringify({
          error: "El path debe empezar con /. No se aceptan URLs absolutas.",
        });
      }

      const purpose = asString(args.purpose);
      const rawBody = asString(args.body);

      // Un marcador que no se puede expandir no se manda nunca: viajaría como
      // texto literal y el agente creería haber probado otra cosa. Se le
      // devuelve el error para que corrija la llamada.
      for (const [donde, texto] of [["path", path], ["body", rawBody ?? ""]] as const) {
        const withoutValid = texto.replace(PAD_MARKER, "");
        const bad = MALFORMED_PAD.exec(withoutValid);
        if (bad) {
          return JSON.stringify({
            error: `Marcador mal formado en ${donde}: ${bad[0]}. La forma exacta es {{PAD:n}}, con n un número. No se envió la request.`,
          });
        }
      }
      if (largestPad(path) > MAX_PAD_CHARS_PATH) {
        return JSON.stringify({
          error: `En el path, {{PAD:n}} admite hasta ${MAX_PAD_CHARS_PATH} caracteres: más que eso lo rechaza el servidor HTTP con 431 antes de llegar a la app, y no probaría nada del contrato. No se envió la request.`,
        });
      }

      const padInPath = largestPad(path) > 0;
      const sentPath = expandPadding(path, MAX_PAD_CHARS_PATH);
      const body = rawBody === undefined ? undefined : expandPadding(rawBody, MAX_PAD_CHARS);
      const headers = asStringRecord(args.headers);
      const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
      if (body !== undefined && !hasContentType) {
        headers["content-type"] = "application/json";
      }

      const url = `${session.baseUrl}${sentPath}`;
      // En la evidencia va lo que viajó de verdad, recortado si es largo.
      const loggedPath = truncate(sentPath, MAX_EVIDENCE_CHARS);
      const startedAt = performance.now();
      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const latencyMs = Math.round(performance.now() - startedAt);
        const text = await response.text();

        session.requestLog.push({
          method,
          path: loggedPath,
          status: response.status,
          latencyMs,
          ...(purpose !== undefined ? { purpose } : {}),
          ...(body !== undefined
            ? {
                bodyBytes: Buffer.byteLength(body),
                requestBody: truncate(body, MAX_EVIDENCE_CHARS),
              }
            : {}),
          responseBody: truncate(text, MAX_EVIDENCE_CHARS),
        });

        return JSON.stringify({
          status: response.status,
          contentType: response.headers.get("content-type"),
          latencyMs,
          // Se informa el tamano ya expandido: si el modelo uso {{PAD:n}} no
          // tiene otra forma de saber cuantos bytes salieron de verdad, y sin
          // ese dato no puede juzgar si probo el limite que queria probar.
          ...(body !== undefined ? { sentBodyBytes: Buffer.byteLength(body) } : {}),
          // Mismo motivo para el path: si usó {{PAD:n}} ahí, tiene que poder
          // comprobar cuántos caracteres viajaron.
          ...(padInPath ? { sentPathChars: sentPath.length } : {}),
          body: truncate(text),
        });
      } catch (error) {
        const latencyMs = Math.round(performance.now() - startedAt);
        const message = error instanceof Error ? error.message : String(error);
        session.requestLog.push({
          method,
          path: loggedPath,
          status: null,
          latencyMs,
          ...(purpose !== undefined ? { purpose } : {}),
          ...(body !== undefined
            ? {
                bodyBytes: Buffer.byteLength(body),
                requestBody: truncate(body, MAX_EVIDENCE_CHARS),
              }
            : {}),
          error: message,
        });
        return JSON.stringify({
          status: null,
          latencyMs,
          error: `La request falló sin respuesta HTTP: ${message}`,
        });
      }
    },
  };

  /** Registra un hallazgo. Append-only: no hay forma de borrar ni editar. */
  const reportFinding: QaTool = {
    name: "report_finding",
    description: [
      "Registra un bug encontrado. Llamalo una vez por cada problema distinto, apenas lo confirmes.",
      "Sólo reportá cosas que hayas verificado con una request real y que contradigan el contrato OpenAPI.",
      "Un finding sin reproducción concreta no sirve.",
    ].join(" "),
    // Esquema deliberadamente chato y con descripciones de una línea.
    //
    // La versión anterior metía los criterios de severidad (cinco líneas) dentro
    // de la descripción del campo, y pedía en `reproduction` el cuerpo de la
    // request y de la respuesta —o sea, JSON anidado con comillas dentro de un
    // argumento JSON—. Gemini devolvía MALFORMED_FUNCTION_CALL una y otra vez y
    // el hallazgo nunca llegaba a registrarse.
    //
    // Los criterios de severidad viven ahora en el prompt de sistema, que es
    // texto libre y no tiene que sobrevivir a una serialización.
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: [...SEVERITIES] },
        title: { type: "string", description: "Resumen en una línea." },
        endpoint: { type: "string", description: "Método y path. Ej: POST /api/todos" },
        expected: { type: "string", description: "Qué exige el contrato." },
        actual: { type: "string", description: "Qué devolvió la aplicación." },
        request_sent: {
          type: "string",
          description: "La request que lo demuestra, en texto plano y en una línea.",
        },
        response_seen: {
          type: "string",
          description: "El status y lo esencial del cuerpo, en texto plano y en una línea.",
        },
      },
      required: ["severity", "title", "endpoint", "expected", "actual", "request_sent"],
    },
    run: async (args) => {
      const severity = asString(args.severity);
      if (severity === undefined || !(SEVERITIES as readonly string[]).includes(severity)) {
        return JSON.stringify({ error: `severity inválida. Usá una de: ${SEVERITIES.join(", ")}.` });
      }
      for (const field of ["title", "endpoint", "expected", "actual", "request_sent"] as const) {
        if (asString(args[field]) === undefined) {
          return JSON.stringify({ error: `Falta el campo ${field} o no es un string.` });
        }
      }

      const responseSeen = asString(args.response_seen);
      session.findings.push({
        severity: severity as Severity,
        title: args.title as string,
        endpoint: args.endpoint as string,
        expected: args.expected as string,
        actual: args.actual as string,
        reproduction: [
          `Request:  ${args.request_sent as string}`,
          ...(responseSeen !== undefined ? [`Response: ${responseSeen}`] : []),
        ].join("\n"),
      });
      return JSON.stringify({ recorded: true, totalFindings: session.findings.length });
    },
  };

  /** Cierra la corrida. Sin esta llamada, la corrida se considera incompleta. */
  const finishRun: QaTool = {
    name: "finish_run",
    description: [
      "Cerrá la corrida cuando hayas cubierto el contrato. Llamalo exactamente una vez, al final.",
      "verdict fail si encontraste algo que debería frenar el deploy; pass si la aplicación respeta el contrato.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        summary: {
          type: "string",
          description: "Dos o tres frases: qué probaste, qué encontraste y por qué ese veredicto.",
        },
      },
      required: ["verdict", "summary"],
    },
    run: async (args) => {
      const verdict = asString(args.verdict);
      const summary = asString(args.summary);
      if (verdict !== "pass" && verdict !== "fail") {
        return JSON.stringify({ error: "verdict debe ser pass o fail." });
      }
      if (summary === undefined) {
        return JSON.stringify({ error: "Falta summary." });
      }
      session.outcome = { verdict, summary };
      return JSON.stringify({ acknowledged: true });
    },
  };

  return [httpRequest, reportFinding, finishRun];
}
