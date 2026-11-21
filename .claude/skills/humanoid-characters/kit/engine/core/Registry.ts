/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M1): how content plugs into the engine. A game registers its
 * object defs, interactions, species and so on by id; the engine looks them up without knowing the
 * game. Registration order is kept (lists come back in the order things were added), and an id can
 * be registered only once, so two pieces of content can never silently replace each other.
 */
export class Registry<T> {
  readonly kind: string;
  private readonly items = new Map<string, T>();

  constructor(kind: string) {
    this.kind = kind;
  }

  register(id: string, item: T): T {
    if (this.items.has(id)) throw new Error(`${this.kind} '${id}' is already registered`);
    this.items.set(id, item);
    return item;
  }

  /** Register many, keyed by a field of each (e.g. `def => def.id`). */
  registerAll(items: Iterable<T>, idOf: (item: T) => string): void {
    for (const it of items) this.register(idOf(it), it);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** The item, or an error naming what was asked for (for content that must exist). */
  require(id: string): T {
    const it = this.items.get(id);
    if (it === undefined) throw new Error(`No ${this.kind} '${id}'`);
    return it;
  }

  ids(): string[] {
    return [...this.items.keys()];
  }

  all(): T[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }
}
