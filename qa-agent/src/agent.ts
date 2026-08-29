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
  let finalText = "";
  let neededClosingNudge = false;

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
    );

    iterations += 1;
    accumulate(response.usageMetadata);

    const calls = response.functionCalls ?? [];
    const modelParts = response.candidates?.[0]?.content?.parts;
    if (modelParts && modelParts.length > 0) {
      contents.push({ role: "model", parts: modelParts });
    } else if (calls.length > 0) {
      contents.push({ role: "model", parts: calls.map((call) => ({ functionCall: call })) });
    }

    if (calls.length === 0) {
      // El modelo dejó de pedir herramientas: se dio por terminado.
      finalText = response.text ?? "";
      stoppedNaturally = true;
      break;
    }

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
  if (!options.shouldStop() && iterations < options.maxIterations) {
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
  };
}
