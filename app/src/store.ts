import { randomUUID } from "node:crypto";

export const PRIORITIES = ["low", "med", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  createdAt: string;
}

/**
 * Bugs que se pueden sembrar deliberadamente vía la variable de entorno
 * SEED_BUG. Existen para poder demostrar que el gate de QA con IA frena
 * un deploy de verdad: con un bug activo el agente debe encontrarlo.
 *
 * No se exponen por la API — si el agente pudiera leer qué bug está activo
 * no estaría explorando, estaría copiándose.
 */
export const SEED_BUGS = ["none", "empty-title", "delete-404"] as const;
export type SeedBug = (typeof SEED_BUGS)[number];

export function readSeedBug(raw: string | undefined): SeedBug {
  const value = (raw ?? "none").trim();
  return (SEED_BUGS as readonly string[]).includes(value)
    ? (value as SeedBug)
    : "none";
}

export class TodoStore {
  readonly seedBug: SeedBug;
  #todos = new Map<string, Todo>();

  constructor(seedBug: SeedBug = "none") {
    this.seedBug = seedBug;
  }

  list(done?: boolean): Todo[] {
    const all = [...this.#todos.values()];
    const filtered = done === undefined ? all : all.filter((t) => t.done === done);
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Todo | undefined {
    return this.#todos.get(id);
  }

  create(input: { title: string; priority?: Priority }): Todo {
    const todo: Todo = {
      id: randomUUID(),
      title: input.title,
      done: false,
      priority: input.priority ?? "med",
      createdAt: new Date().toISOString(),
    };
    this.#todos.set(todo.id, todo);
    return todo;
  }

  update(
    id: string,
    patch: { title?: string; done?: boolean; priority?: Priority },
  ): Todo | undefined {
    const existing = this.#todos.get(id);
    if (!existing) return undefined;
    const updated: Todo = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.done !== undefined ? { done: patch.done } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    };
    this.#todos.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.#todos.delete(id);
  }

  reset(): void {
    this.#todos.clear();
  }
}
