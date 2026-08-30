import type { BrowserSession } from "./browser.js";
import type { QaTool } from "./tools.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Todas las herramientas de UI comparten el mismo campo purpose obligatorio. */
const PURPOSE_FIELD = {
  type: "string",
  description: "Qué estás verificando con esta acción, en una línea.",
} as const;

/**
 * Herramientas para operar la interfaz.
 *
 * El ciclo esperado es: abrir, mirar, actuar, volver a mirar. Las referencias
 * de elementos se regeneran en cada instantánea, así que después de cambiar la
 * página hay que volver a pedirla; eso se le dice al modelo en cada respuesta.
 */
export function buildUiTools(browser: BrowserSession): QaTool[] {
  const open: QaTool = {
    name: "browser_open",
    description: [
      "Abre una página de la aplicación en un navegador real y espera a que cargue.",
      "Sólo indicás el path: el host es fijo. La interfaz principal está en /.",
      "Después de abrir, usá browser_snapshot para ver con qué podés interactuar.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path que arranca con /. Normalmente /" },
        purpose: PURPOSE_FIELD,
      },
      required: ["path", "purpose"],
    },
    run: async (args) =>
      browser.open(asString(args.path) ?? "", asString(args.purpose) ?? ""),
  };

  const snapshot: QaTool = {
    name: "browser_snapshot",
    description: [
      "Describe la página actual: los elementos visibles con los que se puede interactuar,",
      "cada uno con una referencia corta (e1, e2...), su rol, su nombre y su estado.",
      "Usá esas referencias en browser_click, browser_fill y browser_select.",
      "Las referencias cambian en cada instantánea: después de actuar, volvé a pedirla.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { purpose: PURPOSE_FIELD },
      required: ["purpose"],
    },
    run: async (args) => browser.snapshot(asString(args.purpose) ?? ""),
  };

  const click: QaTool = {
    name: "browser_click",
    description:
      "Hace clic en un elemento de la página usando la referencia de la última instantánea.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Referencia del elemento, por ejemplo e4." },
        purpose: PURPOSE_FIELD,
      },
      required: ["ref", "purpose"],
    },
    run: async (args) => browser.click(asString(args.ref) ?? "", asString(args.purpose) ?? ""),
  };

  const fill: QaTool = {
    name: "browser_fill",
    description:
      "Escribe texto en un campo de entrada, reemplazando lo que hubiera. Usá la referencia de la última instantánea.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Referencia del campo, por ejemplo e2." },
        text: { type: "string", description: "Texto a escribir. Puede ser vacío para limpiar." },
        purpose: PURPOSE_FIELD,
      },
      required: ["ref", "text", "purpose"],
    },
    run: async (args) =>
      browser.fill(asString(args.ref) ?? "", asString(args.text) ?? "", asString(args.purpose) ?? ""),
  };

  const select: QaTool = {
    name: "browser_select",
    description:
      "Elige una opción de una lista desplegable. El valor es el value de la opción, no su texto visible.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Referencia del desplegable." },
        value: { type: "string", description: "Valor de la opción a elegir." },
        purpose: PURPOSE_FIELD,
      },
      required: ["ref", "value", "purpose"],
    },
    run: async (args) =>
      browser.select(
        asString(args.ref) ?? "",
        asString(args.value) ?? "",
        asString(args.purpose) ?? "",
      ),
  };

  const press: QaTool = {
    name: "browser_press",
    description:
      "Presiona una tecla sobre el elemento con foco. Sirve para Enter, Escape, Tab y similares.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Nombre de la tecla: Enter, Escape, Tab, ArrowDown." },
        purpose: PURPOSE_FIELD,
      },
      required: ["key", "purpose"],
    },
    run: async (args) => browser.press(asString(args.key) ?? "", asString(args.purpose) ?? ""),
  };

  return [open, snapshot, click, fill, select, press];
}
