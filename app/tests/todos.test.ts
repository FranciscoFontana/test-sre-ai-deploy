import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

function makeApp(seedBug: "none" | "empty-title" | "delete-404" = "none") {
  return createApp({ seedBug }).app;
}

describe("health", () => {
  const app = makeApp();

  it("responde /healthz", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("responde /readyz", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("/version expone el sha pero nunca el bug sembrado", async () => {
    const res = await request(makeApp("empty-title")).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("gitSha");
    expect(JSON.stringify(res.body)).not.toContain("empty-title");
  });
});

describe("POST /api/todos", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("crea un todo y devuelve 201", async () => {
    const res = await request(app).post("/api/todos").send({ title: "Comprar pan" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Comprar pan", done: false, priority: "med" });
    expect(res.body.id).toBeTypeOf("string");
  });

  it("acepta una prioridad válida", async () => {
    const res = await request(app).post("/api/todos").send({ title: "Urgente", priority: "high" });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("high");
  });

  it("rechaza título vacío con 400", async () => {
    const res = await request(app).post("/api/todos").send({ title: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rechaza título ausente con 400", async () => {
    const res = await request(app).post("/api/todos").send({});
    expect(res.status).toBe(400);
  });

  it("rechaza título que no es string con 400", async () => {
    const res = await request(app).post("/api/todos").send({ title: 42 });
    expect(res.status).toBe(400);
  });

  it("rechaza prioridad fuera del enum con 400", async () => {
    const res = await request(app).post("/api/todos").send({ title: "x", priority: "urgentísima" });
    expect(res.status).toBe(400);
  });

  it("rechaza JSON malformado con 400 en formato uniforme", async () => {
    const res = await request(app)
      .post("/api/todos")
      .set("content-type", "application/json")
      .send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
  });
});

describe("GET /api/todos", () => {
  it("lista y filtra por done", async () => {
    const app = makeApp();
    const a = (await request(app).post("/api/todos").send({ title: "A" })).body;
    await request(app).post("/api/todos").send({ title: "B" });
    await request(app).patch(`/api/todos/${a.id}`).send({ done: true });

    expect((await request(app).get("/api/todos")).body.items).toHaveLength(2);
    expect((await request(app).get("/api/todos?done=true")).body.items).toHaveLength(1);
    expect((await request(app).get("/api/todos?done=false")).body.items).toHaveLength(1);
  });

  it("rechaza un filtro done inválido con 400", async () => {
    const res = await request(makeApp()).get("/api/todos?done=quizas");
    expect(res.status).toBe(400);
  });

  it("devuelve 404 para un id inexistente", async () => {
    const res = await request(makeApp()).get("/api/todos/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /api/todos/:id", () => {
  it("actualiza y persiste el cambio", async () => {
    const app = makeApp();
    const todo = (await request(app).post("/api/todos").send({ title: "Original" })).body;

    const patched = await request(app).patch(`/api/todos/${todo.id}`).send({ title: "Editado", done: true });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "Editado", done: true });

    const fetched = await request(app).get(`/api/todos/${todo.id}`);
    expect(fetched.body).toMatchObject({ title: "Editado", done: true });
  });

  it("devuelve 404 para un id inexistente", async () => {
    const res = await request(makeApp()).patch("/api/todos/no-existe").send({ done: true });
    expect(res.status).toBe(404);
  });

  it("rechaza done no booleano con 400", async () => {
    const app = makeApp();
    const todo = (await request(app).post("/api/todos").send({ title: "x" })).body;
    const res = await request(app).patch(`/api/todos/${todo.id}`).send({ done: "si" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/todos/:id", () => {
  it("borra y luego devuelve 404", async () => {
    const app = makeApp();
    const todo = (await request(app).post("/api/todos").send({ title: "Borrable" })).body;

    expect((await request(app).delete(`/api/todos/${todo.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/todos/${todo.id}`)).status).toBe(404);
  });

  it("devuelve 404 al borrar un id inexistente", async () => {
    const res = await request(makeApp()).delete("/api/todos/no-existe");
    expect(res.status).toBe(404);
  });
});

describe("rutas desconocidas", () => {
  it("/api/* devuelve JSON, no HTML", async () => {
    const res = await request(makeApp()).get("/api/inventado");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// Estos tests documentan el comportamiento ROTO que se activa a propósito
// con SEED_BUG. Son la contraparte determinística de lo que el agente de QA
// debe descubrir por su cuenta explorando el entorno.
describe("bugs sembrados (SEED_BUG)", () => {
  it("empty-title: acepta título vacío con 201 en vez de 400", async () => {
    const res = await request(makeApp("empty-title")).post("/api/todos").send({ title: "" });
    expect(res.status).toBe(201);
  });

  it("delete-404: devuelve 204 al borrar un id inexistente en vez de 404", async () => {
    const res = await request(makeApp("delete-404")).delete("/api/todos/no-existe");
    expect(res.status).toBe(204);
  });
});
