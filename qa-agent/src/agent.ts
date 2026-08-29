import { ApiError, GoogleGenAI, createPartFromFunctionResponse, type Content } from "@google/genai";
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
}

export interface AgentRunOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userMessage: string;
  tools: QaTool[];
  maxIterations: number;
  maxOutputTokens: number;
  /** Se consulta después de cada ronda: si devuelve true, la corrida termina. */
  shouldStop: () => boolean;
  onIteration: (iteration: number) => void;
}

/** Error de infraestructura: la corrida no pudo completarse. */
export class AgentError extends Error {}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return [
      "Gemini devolvió 429 incluso después de reintentar con backoff.",
      "En capa gratuita esto suele ser la cuota diaria agotada, no el límite por minuto.",
      "Probá de nuevo mañana, o bajá QA_MAX_ITERATIONS para gastar menos por corrida.",
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
 * espera y se reintenta. Sólo se rinde después de MAX_RETRIES.
 */
async function callWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error instanceof ApiError ? error.status : undefined;
      if (status === undefined || !RETRY_STATUSES.has(status) || attempt === MAX_RETRIES) {
        break;
      }
      // 429 en capa gratuita se destraba esperando: el límite es por minuto.
      const waitMs = status === 429 ? 20_000 : 2_000 * 2 ** attempt;
      console.log(
        `[qa-agent] ${label}: ${status}, reintento ${attempt + 1}/${MAX_RETRIES} en ${Math.round(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
    }
  }

  if (lastError instanceof ApiError) {
    throw new AgentError(describeApiError(lastError));
  }
  throw new AgentError(
    `Fallo inesperado llamando a Gemini: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Lista los modelos disponibles para la key, para diagnosticar un 404. */
export async function listAvailableModels(apiKey: string): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
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
  const ai = new GoogleGenAI({ apiKey: options.apiKey });

  const functionDeclarations = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));

  const contents: Content[] = [{ role: "user", parts: [{ text: options.userMessage }] }];
  const usage: AgentUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
  let iterations = 0;
  let stoppedNaturally = false;

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
    );

    iterations += 1;
    usage.promptTokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.responseTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
    usage.totalTokens += response.usageMetadata?.totalTokenCount ?? 0;
    options.onIteration(iterations);

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      // El modelo dejó de pedir herramientas: terminó por su cuenta.
      stoppedNaturally = true;
      break;
    }

    const modelParts = response.candidates?.[0]?.content?.parts;
    contents.push({
      role: "model",
      parts: modelParts ?? calls.map((call) => ({ functionCall: call })),
    });

    const resultParts = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const tool = options.tools.find((t) => t.name === name);
      const output = tool
        ? await tool.run(call.args ?? {})
        : JSON.stringify({ error: `No existe una herramienta llamada ${name}.` });
      resultParts.push(createPartFromFunctionResponse(call.id ?? name, name, { output }));
    }
    contents.push({ role: "user", parts: resultParts });

    if (options.shouldStop()) {
      stoppedNaturally = true;
      break;
    }
  }

  return { iterations, usage, hitIterationCap: !stoppedNaturally };
}
