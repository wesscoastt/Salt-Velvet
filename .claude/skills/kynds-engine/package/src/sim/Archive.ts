/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M4): the persistent memory store. When someone leaves the
 * simulated world (dies, moves away, is demoted past the last tier), what made them who they were
 * is written here, keyed by id, and kept through saves: the live world can let them go without the
 * story forgetting them. Bounded, so a long game's archive can't swallow the save: past `limit`, the
 * longest-held records go first (records marked `keep` never do).
 *
 * Game-agnostic and headless: what a record holds is the game's business.
 */

export interface ArchiveSave<T> {
  records: [string, T][];
  keep: string[];
}

export class Archive<T> {
  private records = new Map<string, T>();
  private kept = new Set<string>();
  readonly limit: number;

  constructor(limit = 400) {
    this.limit = limit;
  }

  /** File a record (replacing one under the same id). `keep`: never let it go for room. */
  put(id: string, record: T, keep = false): void {
    this.records.delete(id);
    this.records.set(id, record);
    if (keep) this.kept.add(id);
    this.trim();
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get size(): number {
    return this.records.size;
  }

  values(): IterableIterator<T> {
    return this.records.values();
  }

  private trim(): void {
    if (this.records.size <= this.limit) return;
    for (const id of this.records.keys()) {
      if (this.records.size <= this.limit) break;
      if (!this.kept.has(id)) this.records.delete(id);
    }
  }

  serialize(): ArchiveSave<T> {
    return { records: [...this.records], keep: [...this.kept].filter((id) => this.records.has(id)) };
  }

  load(data: ArchiveSave<T> | undefined): void {
    this.records = new Map(data?.records ?? []);
    this.kept = new Set(data?.keep ?? []);
    this.trim();
  }
}
