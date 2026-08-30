import { chromium, type Browser, type Page } from "playwright";
import type { QaSession, UiActionEntry } from "./session.js";

/** Cuántos elementos se le describen al modelo por instantánea. */
const MAX_ELEMENTS = 60;
/** Tope de capturas guardadas: cada una pesa decenas de KB en el reporte. */
const MAX_SCREENSHOTS = 30;
const ACTION_TIMEOUT_MS = 8_000;

/**
 * Código que corre DENTRO de la página, generado como string a propósito.
 *
 * Playwright serializa la función y la evalúa en el navegador. Si se escribe
 * como función de TypeScript, esbuild —que usa tsx— le inyecta un helper
 * __name para preservar el nombre, ese helper no existe dentro de la página y
 * la evaluación muere con "ReferenceError: __name is not defined". Como string
 * no lo toca ningún transpilador y funciona igual con tsx que con el build.
 *
 * Va como expresión autoejecutada con el límite ya adentro: page.evaluate con
 * un string no reenvía los argumentos, así que pasarlo por parámetro devolvía
 * undefined en silencio.
 *
 * El precio es que este bloque no se type-checkea. Es una porción chica y
 * autocontenida, y la alternativa era un fallo que sólo aparece en ejecución.
 */
function snapshotScript(max: number): string {
  return `(() => {
  const max = ${max};
  for (const previo of document.querySelectorAll("[data-qa-ref]")) {
    previo.removeAttribute("data-qa-ref");
  }

  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = el.type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    return el.getAttribute("role") || "text";
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder;
    return (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70);
  }

  const SELECTOR = "a,button,input,select,textarea,[role],[data-testid]";
  const salida = [];
  const candidatos = document.querySelectorAll(SELECTOR);
  let n = 0;
  for (const el of candidatos) {
    if (salida.length >= max) break;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (style.visibility === "hidden" || style.display === "none") continue;

    // Los contenedores se saltean: un <form> o un <ul> que envuelve a otros
    // candidatos aportaría una entrada con todo el texto de sus hijos
    // concatenado, que es ruido puro para el modelo. Se describe lo que se
    // puede tocar, no lo que lo agrupa.
    const esInteractivo = /^(a|button|input|select|textarea)$/.test(el.tagName.toLowerCase());
    if (!esInteractivo && el.querySelector(SELECTOR)) continue;

    n += 1;
    const ref = "e" + n;
    el.setAttribute("data-qa-ref", ref);

    const item = { ref: ref, role: roleOf(el), name: nameOf(el) };
    const testid = el.getAttribute("data-testid");
    if (testid) item.testid = testid;

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
      else item.value = String(el.value).slice(0, 60);
      if (el.disabled) item.disabled = true;
    } else if (tag === "select") {
      item.value = el.value;
      if (el.disabled) item.disabled = true;
    } else if (tag === "button" && el.disabled) {
      item.disabled = true;
    }
    salida.push(item);
  }
  return salida;
})()`;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  testid?: string;
}

/**
 * Navegador controlado por el agente.
 *
 * Arranca perezosamente: si la corrida no usa ninguna herramienta de UI, nunca
 * se lanza Chromium y no se paga ese costo.
 *
 * El diseño central es la instantánea: al modelo NO se le manda el HTML de la
 * página, que serían decenas de miles de tokens y lo ahogaría. Se le manda una
 * lista compacta de los elementos con los que se puede interactuar, cada uno
 * con una referencia corta que después usa para clickear o escribir.
 */
export class BrowserSession {
  readonly #session: QaSession;
  #browser: Browser | null = null;
  #page: Page | null = null;
  #screenshotCount = 0;

  constructor(session: QaSession) {
    this.#session = session;
  }

  get launched(): boolean {
    return this.#browser !== null;
  }

  async #ensurePage(): Promise<Page> {
    if (this.#page) return this.#page;
    this.#browser = await chromium.launch();
    const context = await this.#browser.newContext({
      viewport: { width: 1000, height: 720 },
      deviceScaleFactor: 1,
    });
    this.#page = await context.newPage();
    this.#page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return this.#page;
  }

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
    this.#page = null;
  }

  /** JPEG en data URI. Se corta al llegar al tope para no inflar el reporte. */
  async #screenshot(): Promise<string | undefined> {
    if (this.#screenshotCount >= MAX_SCREENSHOTS || !this.#page) return undefined;
    try {
      const buffer = await this.#page.screenshot({ type: "jpeg", quality: 55 });
      this.#screenshotCount += 1;
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  async #record(
    entry: Omit<UiActionEntry, "ms" | "screenshot">,
    startedAt: number,
    conCaptura: boolean,
  ): Promise<void> {
    const screenshot = conCaptura ? await this.#screenshot() : undefined;
    this.#session.uiLog.push({
      ...entry,
      ms: Math.round(performance.now() - startedAt),
      ...(screenshot ? { screenshot } : {}),
    });
  }

  async open(path: string, purpose: string): Promise<string> {
    const startedAt = performance.now();
    if (!path.startsWith("/")) {
      await this.#record(
        { action: "open", purpose, detail: path, ok: false, error: "path inválido" },
        startedAt,
        false,
      );
      return JSON.stringify({ error: "El path debe empezar con /. El host es fijo." });
    }

    const url = `${this.#session.baseUrl}${path}`;
    try {
      const page = await this.#ensurePage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
      await this.#record({ action: "open", purpose, detail: url, ok: true }, startedAt, true);
      return JSON.stringify({
        ok: true,
        url,
        title: await page.title(),
        hint: "Usá browser_snapshot para ver con qué elementos podés interactuar.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#record(
        { action: "open", purpose, detail: url, ok: false, error: message },
        startedAt,
        false,
      );
      return JSON.stringify({ error: `No se pudo abrir ${url}: ${message}` });
    }
  }

  /**
   * Describe la página en forma compacta.
   *
   * Cada elemento visible con el que se puede interactuar recibe un atributo
   * data-qa-ref que sirve de identificador estable hasta la próxima
   * instantánea. Las referencias se regeneran en cada llamada, así que el
   * modelo tiene que volver a mirar después de cambiar la página.
   */
  async snapshot(purpose: string): Promise<string> {
    const startedAt = performance.now();
    try {
      const page = await this.#ensurePage();
      const elements = (await page.evaluate(snapshotScript(MAX_ELEMENTS))) as SnapshotElement[];

      await this.#record({ action: "snapshot", purpose, ok: true }, startedAt, true);

      return JSON.stringify({
        url: page.url(),
        title: await page.title(),
        elements,
        truncated: elements.length >= MAX_ELEMENTS,
        hint: "Para actuar usá el ref, por ejemplo browser_click con ref e4.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#record({ action: "snapshot", purpose, ok: false, error: message }, startedAt, false);
      return JSON.stringify({ error: `No se pudo leer la página: ${message}` });
    }
  }

  /** Describe un ref para el registro, sin depender de que el modelo lo cuente. */
  async #describe(ref: string): Promise<string> {
    try {
      const page = await this.#ensurePage();
      const el = page.locator(`[data-qa-ref="${ref}"]`);
      const testid = await el.getAttribute("data-testid", { timeout: 1500 });
      const label = await el.getAttribute("aria-label", { timeout: 1500 });
      const texto = (await el.textContent({ timeout: 1500 })) ?? "";
      const nombre = label ?? texto.replace(/\s+/g, " ").trim().slice(0, 40);
      return testid ? `${ref} (${testid}${nombre ? `: ${nombre}` : ""})` : `${ref} ${nombre}`;
    } catch {
      return ref;
    }
  }

  async #act(
    action: "click" | "fill" | "press",
    ref: string | undefined,
    purpose: string,
    detail: string | undefined,
    operacion: (page: Page) => Promise<void>,
  ): Promise<string> {
    const startedAt = performance.now();
    const target = ref ? await this.#describe(ref) : undefined;
    try {
      const page = await this.#ensurePage();
      await operacion(page);
      // La UI hace fetch y vuelve a dibujar; se le da un respiro antes de
      // capturar, o la imagen muestra el estado anterior al cambio.
      await page.waitForTimeout(350);
      await this.#record(
        { action, purpose, ...(target ? { target } : {}), ...(detail ? { detail } : {}), ok: true },
        startedAt,
        true,
      );
      return JSON.stringify({ ok: true, hint: "Volvé a llamar browser_snapshot para ver el resultado." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#record(
        {
          action,
          purpose,
          ...(target ? { target } : {}),
          ...(detail ? { detail } : {}),
          ok: false,
          error: message,
        },
        startedAt,
        true,
      );
      return JSON.stringify({ error: `La acción falló: ${message}` });
    }
  }

  click(ref: string, purpose: string): Promise<string> {
    return this.#act("click", ref, purpose, undefined, async (page) => {
      await page.locator(`[data-qa-ref="${ref}"]`).click({ timeout: ACTION_TIMEOUT_MS });
    });
  }

  fill(ref: string, text: string, purpose: string): Promise<string> {
    return this.#act("fill", ref, purpose, `"${text.slice(0, 60)}"`, async (page) => {
      await page.locator(`[data-qa-ref="${ref}"]`).fill(text, { timeout: ACTION_TIMEOUT_MS });
    });
  }

  press(key: string, purpose: string): Promise<string> {
    return this.#act("press", undefined, purpose, key, async (page) => {
      await page.keyboard.press(key);
    });
  }

  /** Selecciona una opción de un <select>. */
  select(ref: string, value: string, purpose: string): Promise<string> {
    return this.#act("fill", ref, purpose, `opción "${value}"`, async (page) => {
      await page.locator(`[data-qa-ref="${ref}"]`).selectOption(value, { timeout: ACTION_TIMEOUT_MS });
    });
  }
}
