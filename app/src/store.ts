import { randomUUID } from "node:crypto";

export const PRIORITIES = ["low", "med", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SORT_FIELDS = ["createdAt", "title", "priority"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  createdAt: string;
}

/** Cuántas tareas hay en total, sin importar los filtros aplicados. */
export interface TodoCounts {
  total: number;
  pending: number;
  done: number;
}

export interface ListQuery {
  done?: boolean;
  search?: string;
  sort?: SortField;
  order?: SortOrder;
}

/**
 * Bugs que se pueden sembrar deliberadamente vía la variable de entorno
 * SEED_BUG. Existen para poder demostrar que el gate de QA con IA frena
 * un deploy de verdad: con un bug activo el agente debe encontrarlo.
 *
 * No se exponen por la API — si el agente pudiera leer qué bug está activo
 * no estaría explorando, estaría copiándose.
 */
export const SEED_BUGS = ["none", "empty-title", "delete-404", "search-ignores-case"] as const;
export type SeedBug = (typeof SEED_BUGS)[number];

export function readSeedBug(raw: string | undefined): SeedBug {
  const value = (raw ?? "none").trim();
  return (SEED_BUGS as readonly string[]).includes(value)
    ? (value as SeedBug)
    : "none";
}

/** high pesa más que med, que pesa más que low. */
const PRIORITY_WEIGHT: Record<Priority, number> = { high: 3, med: 2, low: 1 };

export class TodoStore {
  readonly seedBug: SeedBug;
  #todos = new Map<string, Todo>();

  constructor(seedBug: SeedBug = "none") {
    this.seedBug = seedBug;
  }

  counts(): TodoCounts {
    const all = [...this.#todos.values()];
    const done = all.filter((t) => t.done).length;
    return { total: all.length, pending: all.length - done, done };
  }

  list(query: ListQuery = {}): Todo[] {
    let items = [...this.#todos.values()];

    if (query.done !== undefined) {
      items = items.filter((t) => t.done === query.done);
    }

    if (query.search !== undefined && query.search.trim().length > 0) {
      const needle = query.search.trim();
      // BUG SEMBRADO 'search-ignores-case': la búsqueda pasa a distinguir
      // mayúsculas de minúsculas, así que buscar "pan" no encuentra "Pan".
      items =
        this.seedBug === "search-ignores-case"
          ? items.filter((t) => t.title.includes(needle))
          : items.filter((t) => t.title.toLowerCase().includes(needle.toLowerCase()));
    }

    const field = query.sort ?? "createdAt";
    const direction = query.order === "desc" ? -1 : 1;
    items.sort((a, b) => {
      let comparison: number;
      if (field === "priority") {
        comparison = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      } else if (field === "title") {
        comparison = a.title.localeCompare(b.title, "es", { sensitivity: "base" });
      } else {
        comparison = a.createdAt.localeCompare(b.createdAt);
      }
      // Desempate estable por id: sin esto, dos tareas con la misma prioridad
      // pueden salir en distinto orden entre llamadas y el agente lo reporta
      // como inconsistencia.
      return comparison !== 0 ? comparison * direction : a.id.localeCompare(b.id);
    });

    return items;
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

  /** Marca como completadas todas las pendientes. Devuelve cuántas cambió. */
  completeAll(): number {
    let updated = 0;
    for (const [id, todo] of this.#todos) {
      if (!todo.done) {
        this.#todos.set(id, { ...todo, done: true });
        updated += 1;
      }
    }
    return updated;
  }

  /** Elimina las completadas. Devuelve cuántas borró. */
  removeCompleted(): number {
    let deleted = 0;
    for (const [id, todo] of this.#todos) {
      if (todo.done) {
        this.#todos.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  reset(): void {
    this.#todos.clear();
  }
}
