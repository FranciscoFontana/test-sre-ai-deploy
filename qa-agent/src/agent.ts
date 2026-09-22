import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  createPartFromFunctionResponse,
  type Content,
  type Part,
} from "@google/genai";
import type { QaTool } from "./tools.js";

export interface AgentUsage {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  iterations: number;
  usage: AgentUsage;
  /** true si se agotaron las iteraciones sin que el modelo dejara de llamar herramientas. */
  hitIterationCap: boolean;
  /** Texto final del modelo cuando dejó de llamar herramientas, si lo hubo. */
  finalText: string;
  /** true si hizo falta forzar la llamada de cierre. */
  neededClosingNudge: boolean;
  /** Por qué el modelo dejó de llamar herramientas (STOP, MAX_TOKENS, ...). */
  finishReason: string;
}

export interface AgentRunOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userMessage: string;
  tools: QaTool[];
  maxIterations: number;
  maxOutputTokens: number;
  /** Tiempo máximo que puede tardar cada llamada al modelo antes de abortarla. */
  requestTimeoutMs: number;
  /** Se consulta después de cada ronda: si devuelve true, la corrida termina. */
  shouldStop: () => boolean;
  onIteration: (iteration: number) => void;
  /**
   * Herramienta con la que el agente debe cerrar la corrida. Si el modelo deja
   * de llamar herramientas sin haberla usado, se le fuerza esa llamada.
   */
  closingToolName: string;
}

/** Error de infraestructura: la corrida no pudo completarse. */
export class AgentError extends Error {}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
/**
 * Reintentos ante errores de red. Son menos que los de estado HTTP porque cada
 * intento fallido puede costar el timeout completo: con 120 s por llamada, tres
 * reintentos ya son ocho minutos en el peor caso.
 */
const MAX_NETWORK_RETRIES = 3;
/** Cuántas veces se reintenta un turno cuya llamada a herramienta salió corrupta. */
const MAX_MALFORMED_RETRIES = 3;

/**
 * Códigos de Node y de undici —el cliente HTTP de fetch— que indican un corte
 * pasajero: la conexión se cayó o no llegó a establecerse, pero el servidor no
 * dijo que la request estuviera mal.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reconoce un error de red o un timeout, que no traen status HTTP.
 *
 * Hasta ahora sólo se reintentaban los errores con status (429, 503...), y un
 * `fetch failed` —la conexión cortada antes de recibir respuesta— abortaba la
 * corrida al primer intento, aunque es tan pasajero como un 503. Pasó en una
 * corrida real: después de 21 requests y un hallazgo registrado, una sola
 * llamada colgada tiró abajo todo.
 *
 * Devuelve una descripción para el log, o null si no es un error de red.
 */
function describeNetworkError(error: unknown, timeoutMs: number): string | null {
  if (!(error instanceof Error) || error instanceof ApiError) return null;

  // El SDK aborta cada intento al vencer el timeout con un AbortController.
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return `sin respuesta en ${Math.round(timeoutMs / 1000)} s`;
  }

  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;

  if (code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) {
    return `error de red (${code})`;
  }
  if (error.message === "fetch failed") {
    return "error de red (fetch failed)";
  }
  return null;
}

/**
 * Distingue un 429 por cuota diaria de uno por límite por minuto.
 *
 * Importa porque cambia qué hacer: el límite por minuto se destraba esperando,
 * la cuota diaria no. Reintentar cinco veces contra una cuota agotada son cien
 * segundos tirados y un diagnóstico peor.
 *
 * Google identifica la cuota en el cuerpo del error (por ejemplo
 * GenerateRequestsPerDayPerProjectPerModel). Si el formato cambia y no hay
 * coincidencia, se cae al comportamiento anterior: reintentar.
 */
function isDailyQuotaError(message: string): boolean {
  return /per\s*day|perday|daily limit|cuota diaria/i.test(message);
}

/**
 * Traduce los errores del SDK a algo accionable.
 *
 * La distinción importante es entre quedarse sin cuota del día (no hay nada
 * que reintentar hoy) y un rate limit por minuto (se reintenta con backoff).
 */
function describeApiError(error: ApiError): string {
  const status = error.status;
  const message = error.message ?? "";

  if (status === 400 && /API key not valid/i.test(message)) {
    return "La GEMINI_API_KEY no es válida. Generá una nueva en aistudio.google.com.";
  }
  if (status === 403) {
    return `Gemini rechazó la request por permisos (403): ${message}`;
  }
  if (status === 429) {
    const base = isDailyQuotaError(message)
      ? "Se agotó la cuota DIARIA de este modelo en la capa gratuita."
      : "Gemini devolvió 429 incluso después de reintentar con backoff, probablemente por cuota diaria agotada.";
    return [
      base,
      "La cuota gratuita es por modelo: probá otro con QA_MODEL, por ejemplo",
      "QA_MODEL=gemini-3.5-flash-lite (los modelos lite tienen la cuota diaria más alta).",
      "Si ya los agotaste todos, se renueva sola en el próximo ciclo diario.",
    ].join(" ");
  }
  if (status === 404) {
    return `El modelo no existe o no está disponible en tu tier (404): ${message}`;
  }
  return `La API de Gemini falló (${status ?? "sin status"}): ${message}`;
}

/**
 * Llama al modelo reintentando los errores transitorios.
 *
 * La capa gratuita de Gemini limita a pocas requests por minuto, así que un
 * 429 en mitad de una corrida es esperable y no debe abortar el gate: se
 * espera y se reintenta. Lo mismo con un 503 cuando el servicio está
 * saturado, y con los cortes de red y los timeouts, que no traen status.
 *
 * Los dos tipos de falla llevan contadores separados: los de red pueden costar
 * el timeout completo en cada intento, así que tienen un tope más bajo.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let lastError: unknown;
  let httpRetries = 0;
  let networkRetries = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const networkIssue = describeNetworkError(error, timeoutMs);
      if (networkIssue !== null) {
        if (networkRetries >= MAX_NETWORK_RETRIES) break;
        networkRetries += 1;
        const waitMs = 2_000 * 2 ** (networkRetries - 1);
        console.log(
          `[qa-agent] ${label}: ${networkIssue}, reintento ${networkRetries}/${MAX_NETWORK_RETRIES} en ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
        continue;
      }

      const status = error instanceof ApiError ? error.status : undefined;
      if (status === undefined || !RETRY_STATUSES.has(status) || httpRetries >= MAX_RETRIES) {
        break;
      }
      if (status === 429 && error instanceof ApiError && isDailyQuotaError(error.message ?? "")) {
        // Esperar no sirve: la cuota diaria no se renueva en un minuto.
        break;
      }
      if (status === 429 && httpRetries === 0 && error instanceof ApiError) {
        // Se muestra el detalle de Google la primera vez: dice qué cuota se
        // agotó y en cuánto se renueva, que es justo lo que hace falta saber.
        console.log(`[qa-agent] detalle del 429: ${(error.message ?? "").slice(0, 400)}`);
      }
      httpRetries += 1;
      // Un 429 por límite por minuto sí se destraba esperando.
      const waitMs = status === 429 ? 20_000 : 2_000 * 2 ** (httpRetries - 1);
      console.log(
        `[qa-agent] ${label}: ${status}, reintento ${httpRetries}/${MAX_RETRIES} en ${Math.round(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
    }
  }

  if (lastError instanceof ApiError) {
    throw new AgentError(describeApiError(lastError));
  }
  const networkIssue = describeNetworkError(lastError, timeoutMs);
  if (networkIssue !== null) {
    throw new AgentError(
      `Gemini no respondió después de ${MAX_NETWORK_RETRIES} reintentos (${networkIssue}). ` +
        "Suele ser una degradación pasajera del servicio: reintentá la corrida más tarde.",
    );
  }
  throw new AgentError(
    `Fallo inesperado llamando a Gemini: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Lista los modelos disponibles para la key, para diagnosticar un 404. */
export async function listAvailableModels(apiKey: string, timeoutMs: number): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } });
  const names: string[] = [];
  try {
    const pager = await ai.models.list();
    for await (const model of pager) {
      if (model.name) names.push(model.name.replace(/^models\//, ""));
    }
  } catch {
    return [];
  }
  return names;
}

/**
 * Loop agéntico manual.
 *
 * El SDK de Gemini puede ejecutar las herramientas por su cuenta
 * (automaticFunctionCalling), pero acá se desactiva a propósito: necesitamos
 * contar iteraciones, cortar apenas el agente llama a finish_run y decidir
 * qué hacer ante cada error. Ese control es el gate.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  // Sin timeout propio, una llamada colgada queda a merced del de undici, que
  // son cinco minutos. El SDK aplica este valor por intento, no a la secuencia
  // entera de reintentos.
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { timeout: options.requestTimeoutMs },
  });

  const functionDeclarations = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));

  const contents: Content[] = [{ role: "user", parts: [{ text: options.userMessage }] }];
  const usage: AgentUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
  let iterations = 0;
  let stoppedNaturally = false;
  let finalText = "";
  let neededClosingNudge = false;
  let finishReason = "";
  let malformedRetries = 0;

  const accumulate = (metadata: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | undefined): void => {
    usage.promptTokens += metadata?.promptTokenCount ?? 0;
    usage.responseTokens += metadata?.candidatesTokenCount ?? 0;
    usage.totalTokens += metadata?.totalTokenCount ?? 0;
  };

  /** Ejecuta las herramientas pedidas y devuelve las partes de respuesta. */
  const executeCalls = async (
    calls: { name?: string; id?: string; args?: Record<string, unknown> }[],
  ): Promise<Part[]> => {
    const resultParts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const tool = options.tools.find((t) => t.name === name);
      const output = tool
        ? await tool.run(call.args ?? {})
        : JSON.stringify({ error: `No existe una herramienta llamada ${name}.` });
      resultParts.push(createPartFromFunctionResponse(call.id ?? name, name, { output }));
    }
    return resultParts;
  };

  while (iterations < options.maxIterations) {
    const response = await callWithRetry(
      () =>
        ai.models.generateContent({
          model: options.model,
          contents,
          config: {
            systemInstruction: options.systemInstruction,
            tools: [{ functionDeclarations }],
            // Ver el comentario de arriba: el loop lo manejamos nosotros.
            automaticFunctionCalling: { disable: true },
            maxOutputTokens: options.maxOutputTokens,
          },
        }),
      "generateContent",
      options.requestTimeoutMs,
    );

    iterations += 1;
    accumulate(response.usageMetadata);

    const calls = response.functionCalls ?? [];
    const reason = String(response.candidates?.[0]?.finishReason ?? "sin finishReason");

    if (calls.length === 0) {
      // El modelo dejó de pedir herramientas. finishReason distingue por qué:
      // STOP es que se dio por terminado; MAX_TOKENS que se quedó sin
      // presupuesto de salida; MALFORMED_FUNCTION_CALL que sí quiso llamar una
      // herramienta pero la llamada salió corrupta.
      //
      // Ese último caso se destraba reintentando el mismo turno, y conviene
      // hacerlo: darlo por terminado descarta un hallazgo que el modelo ya
      // tenía. No se agrega nada a `contents` para no dejar un turno colgado.
      if (reason === "MALFORMED_FUNCTION_CALL" && malformedRetries < MAX_MALFORMED_RETRIES) {
        malformedRetries += 1;
        console.log(
          `[qa-agent] llamada mal formada, reintento ${malformedRetries}/${MAX_MALFORMED_RETRIES}`,
        );
        continue;
      }

      finalText = response.text ?? "";
      finishReason = reason;
      stoppedNaturally = true;
      options.onIteration(iterations);
      break;
    }

    const modelParts = response.candidates?.[0]?.content?.parts;
    contents.push({
      role: "model",
      parts:
        modelParts && modelParts.length > 0
          ? modelParts
          : calls.map((call) => ({ functionCall: call })),
    });
    contents.push({ role: "user", parts: await executeCalls(calls) });
    // Se loguea después de ejecutar, para que los contadores reflejen
    // lo que ya pasó y no el estado previo a esta iteración.
    options.onIteration(iterations);

    if (options.shouldStop()) {
      stoppedNaturally = true;
      break;
    }
  }

  /**
   * Cierre forzado.
   *
   * Un modelo puede darse por terminado escribiendo su conclusión en prosa en
   * lugar de llamar a la herramienta de cierre. Sin esto, esa corrida se
   * contaría como incompleta y bloquearía un deploy que estaba bien.
   *
   * No se acepta el texto libre como veredicto: se le exige la llamada, con
   * mode ANY restringido a esa única función. El veredicto tiene que entrar
   * al gate por el mismo camino estructurado que en una corrida normal.
   */
  // Se intenta SIEMPRE que la corrida haya terminado sin veredicto, incluso si
  // fue por agotar las iteraciones. Ese es justamente el caso en que más hace
  // falta: el agente ya tiene los hallazgos registrados y sólo falta que emita
  // el veredicto. Condicionarlo a que sobraran iteraciones —como estaba— dejaba
  // sin cerrar precisamente las corridas que llegaban al tope.
  if (!options.shouldStop()) {
    neededClosingNudge = true;
    contents.push({
      role: "user",
      parts: [
        {
          text:
            "No cerraste la corrida. Repasá lo que probaste y llamá ahora a " +
            `${options.closingToolName} con tu veredicto: "pass" si la aplicación respetó ` +
            'el contrato, "fail" si encontraste algo que deba frenar el deploy.',
        },
      ],
    });

    const response = await callWithRetry(
      () =>
        ai.models.generateContent({
          model: options.model,
          contents,
          config: {
            systemInstruction: options.systemInstruction,
            tools: [{ functionDeclarations }],
            automaticFunctionCalling: { disable: true },
            maxOutputTokens: options.maxOutputTokens,
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: [options.closingToolName],
              },
            },
          },
        }),
      "cierre forzado",
      options.requestTimeoutMs,
    );

    iterations += 1;
    accumulate(response.usageMetadata);
    await executeCalls(response.functionCalls ?? []);
    options.onIteration(iterations);
  }

  return {
    iterations,
    usage,
    hitIterationCap: !stoppedNaturally,
    finalText,
    neededClosingNudge,
    finishReason,
  };
}
