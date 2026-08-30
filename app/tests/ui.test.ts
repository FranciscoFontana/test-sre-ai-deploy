import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

/**
 * Red determinística sobre la interfaz.
 *
 * Cubre los recorridos que un usuario hace siempre: agregar, completar,
 * filtrar, buscar, editar y las acciones masivas. El agente de IA explora
 * encima de esto; estos tests son los que tienen que pasar siempre igual.
 */

const TIMEOUT = 30_000;
let server: Server;
let browser: Browser;
let page: Page;
let baseUrl: string;

/** El store vive en el proceso, así que se reinicia entre tests. */
const { app, store } = createApp({ seedBug: "none" });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, TIMEOUT);

afterEach(() => {
  store.reset();
});

const test = (id: string) => page.locator(`[data-testid="${id}"]`);

async function abrir(): Promise<void> {
  await page.goto(baseUrl);
  // Se espera el botón de agregar, no la lista: un <ul> vacío mide cero y
  // Playwright lo considera oculto, así que esperar a que sea "visible"
  // nunca se cumple con la app recién cargada.
  await test("new-todo-submit").waitFor();
}

async function agregar(titulo: string, prioridad = "med"): Promise<void> {
  await test("new-todo-title").fill(titulo);
  await test("new-todo-priority").selectOption(prioridad);
  await test("new-todo-submit").click();
  await expect
    .poll(async () => test("todo-item").count(), { timeout: 5000 })
    .toBeGreaterThan(0);
}

describe("interfaz", () => {
  it(
    "agrega una tarea y la muestra en la lista",
    async () => {
      await abrir();
      await agregar("Comprar pan");
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Comprar pan");
      await expect.poll(() => test("count-total").textContent()).toBe("1");
      await expect.poll(() => test("count-pending").textContent()).toBe("1");
    },
    TIMEOUT,
  );

  it(
    "el campo de título queda vacío después de agregar",
    async () => {
      await abrir();
      await agregar("Algo");
      expect(await test("new-todo-title").inputValue()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "completar una tarea la tacha y mueve el contador",
    async () => {
      await abrir();
      await agregar("Tarea");
      await test("todo-checkbox").first().check();
      await expect.poll(() => test("count-done").textContent()).toBe("1");
      await expect.poll(() => test("count-pending").textContent()).toBe("0");
      await expect.poll(() => test("todo-item").first().getAttribute("class")).toContain("done");
    },
    TIMEOUT,
  );

  it(
    "los filtros muestran sólo lo que corresponde",
    async () => {
      await abrir();
      await agregar("Pendiente");
      await agregar("Completada");
      await test("todo-item").nth(1).locator('[data-testid="todo-checkbox"]').check();
      await expect.poll(() => test("count-done").textContent()).toBe("1");

      await test("filter-pending").click();
      await expect.poll(() => test("todo-item").count()).toBe(1);
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Pendiente");

      await test("filter-done").click();
      await expect.poll(() => test("todo-item").count()).toBe(1);
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Completada");

      await test("filter-all").click();
      await expect.poll(() => test("todo-item").count()).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "la búsqueda filtra sin distinguir mayúsculas",
    async () => {
      await abrir();
      await agregar("Comprar Pan");
      await agregar("Llamar al banco");

      await test("search-input").fill("pan");
      await expect.poll(() => test("todo-item").count(), { timeout: 5000 }).toBe(1);
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Comprar Pan");

      await test("search-input").fill("");
      await expect.poll(() => test("todo-item").count(), { timeout: 5000 }).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "editar el título haciendo clic y confirmando con Enter",
    async () => {
      await abrir();
      await agregar("Original");
      await test("todo-title").first().click();
      await test("todo-edit-input").fill("Editado");
      await page.keyboard.press("Enter");
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Editado");
    },
    TIMEOUT,
  );

  it(
    "Escape cancela la edición y deja el título original",
    async () => {
      await abrir();
      await agregar("Intacto");
      await test("todo-title").first().click();
      await test("todo-edit-input").fill("Descartado");
      await page.keyboard.press("Escape");
      await expect.poll(() => test("todo-title").first().textContent()).toBe("Intacto");
    },
    TIMEOUT,
  );

  it(
    "completar todas y borrar completadas",
    async () => {
      await abrir();
      await agregar("Una");
      await agregar("Dos");

      await test("complete-all").click();
      await expect.poll(() => test("count-done").textContent()).toBe("2");

      await test("clear-completed").click();
      await expect.poll(() => test("count-total").textContent()).toBe("0");
      await expect.poll(() => test("empty-state").isVisible()).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "las acciones masivas se deshabilitan cuando no aplican",
    async () => {
      await abrir();
      await expect.poll(() => test("complete-all").isDisabled()).toBe(true);
      await expect.poll(() => test("clear-completed").isDisabled()).toBe(true);

      await agregar("Algo");
      await expect.poll(() => test("complete-all").isDisabled()).toBe(false);
      await expect.poll(() => test("clear-completed").isDisabled()).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "muestra el error de la API cuando el título es sólo espacios",
    async () => {
      await abrir();
      // El input tiene required, así que un valor con espacios pasa la
      // validación del navegador y llega al servidor, que lo rechaza.
      await test("new-todo-title").fill("   ");
      await test("new-todo-submit").click();
      await expect.poll(() => test("error-box").isVisible(), { timeout: 5000 }).toBe(true);
      expect(await test("error-box").textContent()).toContain("vacío");
    },
    TIMEOUT,
  );
});
