import { Router } from "express";
import { sendError } from "../errors.js";
import { PRIORITIES, type Priority, type TodoStore } from "../store.js";

const MAX_TITLE_LENGTH = 200;

function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

/** Parsea ?done=true|false. Devuelve `null` si el valor es inválido. */
function parseDoneFilter(raw: unknown): boolean | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function todosRouter(store: TodoStore): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const done = parseDoneFilter(req.query.done);
    if (done === null) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "El parámetro 'done' sólo acepta 'true' o 'false'.",
      );
    }
    res.json({ items: store.list(done) });
  });

  router.post("/", (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "VALIDATION_ERROR", "El cuerpo debe ser un objeto JSON.");
    }

    const { title, priority } = body;

    if (typeof title !== "string") {
      return sendError(res, 400, "VALIDATION_ERROR", "El campo 'title' es obligatorio y debe ser string.");
    }

    // BUG SEMBRADO 'empty-title': se saltea la validación de título vacío,
    // de modo que POST { title: "" } devuelve 201 en lugar de 400.
    if (store.seedBug !== "empty-title" && title.trim().length === 0) {
      return sendError(res, 400, "VALIDATION_ERROR", "El campo 'title' no puede estar vacío.");
    }

    if (title.length > MAX_TITLE_LENGTH) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `El campo 'title' no puede superar los ${MAX_TITLE_LENGTH} caracteres.`,
      );
    }

    if (priority !== undefined && !isPriority(priority)) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `El campo 'priority' debe ser uno de: ${PRIORITIES.join(", ")}.`,
      );
    }

    const todo = store.create({ title, ...(priority !== undefined ? { priority } : {}) });
    res.status(201).json(todo);
  });

  router.get("/:id", (req, res) => {
    const todo = store.get(req.params.id);
    if (!todo) {
      return sendError(res, 404, "NOT_FOUND", "No existe un todo con ese id.");
    }
    res.json(todo);
  });

  router.patch("/:id", (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, 400, "VALIDATION_ERROR", "El cuerpo debe ser un objeto JSON.");
    }

    const { title, done, priority } = body;

    if (title !== undefined) {
      if (typeof title !== "string") {
        return sendError(res, 400, "VALIDATION_ERROR", "El campo 'title' debe ser string.");
      }
      if (title.trim().length === 0) {
        return sendError(res, 400, "VALIDATION_ERROR", "El campo 'title' no puede estar vacío.");
      }
      if (title.length > MAX_TITLE_LENGTH) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          `El campo 'title' no puede superar los ${MAX_TITLE_LENGTH} caracteres.`,
        );
      }
    }

    if (done !== undefined && typeof done !== "boolean") {
      return sendError(res, 400, "VALIDATION_ERROR", "El campo 'done' debe ser booleano.");
    }

    if (priority !== undefined && !isPriority(priority)) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `El campo 'priority' debe ser uno de: ${PRIORITIES.join(", ")}.`,
      );
    }

    const updated = store.update(req.params.id, {
      ...(title !== undefined ? { title: title as string } : {}),
      ...(done !== undefined ? { done: done as boolean } : {}),
      ...(priority !== undefined ? { priority: priority as Priority } : {}),
    });

    if (!updated) {
      return sendError(res, 404, "NOT_FOUND", "No existe un todo con ese id.");
    }
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const removed = store.remove(req.params.id);

    // BUG SEMBRADO 'delete-404': devuelve 204 aunque el id no exista,
    // ocultando el 404 que la API debería dar.
    if (!removed && store.seedBug !== "delete-404") {
      return sendError(res, 404, "NOT_FOUND", "No existe un todo con ese id.");
    }
    res.status(204).end();
  });

  return router;
}
