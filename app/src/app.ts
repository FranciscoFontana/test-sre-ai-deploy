import express, { type ErrorRequestHandler } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendError } from "./errors.js";
import { healthRouter } from "./routes/health.js";
import { todosRouter } from "./routes/todos.js";
import { readSeedBug, TodoStore, type SeedBug } from "./store.js";

// `src/` y `dist/` están ambos un nivel debajo de app/, así que esta ruta
// resuelve igual corriendo con tsx que con el build compilado.
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

export interface AppOptions {
  seedBug?: SeedBug;
}

export function createApp(options: AppOptions = {}) {
  const seedBug = options.seedBug ?? readSeedBug(process.env.SEED_BUG);
  const store = new TodoStore(seedBug);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter());
  app.use("/api/todos", todosRouter(store));
  app.use(express.static(PUBLIC_DIR));

  // Cualquier ruta /api/* desconocida responde JSON, no el HTML por defecto.
  app.use("/api", (_req, res) => {
    sendError(res, 404, "NOT_FOUND", "Ese endpoint no existe.");
  });

  // express.json() lanza un SyntaxError con .status 400 ante un body malformado.
  // Sin este handler, Express respondería una página HTML de error.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof SyntaxError && "status" in err && err.status === 400) {
      sendError(res, 400, "MALFORMED_JSON", "El cuerpo de la request no es JSON válido.");
      return;
    }
    if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large") {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "El cuerpo de la request excede el límite de 100kb.");
      return;
    }
    console.error("[error] no manejado:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Error interno del servidor.");
  };
  app.use(errorHandler);

  return { app, store, seedBug };
}
