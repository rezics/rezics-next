import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { InvalidStructureObject, STRUCTURE_LIMITS, STRUCTURE_PAGE_FORMAT, checkStructurePage }
  from './format.ts';

// Copy-on-write B+tree over immutable pages. A change set rewrites only the
// leaves holding its keys and their ancestors; every other page is reused by
// digest. Resolution always starts at a complete root.

export type TreeKind = 'record' | 'order' | 'pin';
export interface TreeRoot { page: string; level: number; count: number }
/** Page reads and writes of one operation, reported as its measured local work. */
export interface TreeCost { pagesRead: number; pagesWritten: number }
interface Child { page: string; count: number; first: string }

export class StructureObjectUnavailable extends Error {}
export class StructureObjectCorrupt extends Error {}

export const newCost = (): TreeCost => ({ pagesRead: 0, pagesWritten: 0 });

export class StructureTree<T> {
  constructor(private readonly objects: ImmutableObjects, private readonly kind: TreeKind,
    private readonly keyOf: (entry: T) => string) {}

  private async load(page: string, cost: TreeCost): Promise<{ level: number; entries: unknown[] }> {
    if (!/^sha256:[0-9a-f]{64}$/.test(page)) throw new StructureObjectCorrupt('invalid page reference');
    let bytes: Uint8Array;
    try { bytes = await this.objects.get(page.slice(7)); }
    catch (error) {
      if (error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
      if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
      throw error;
    }
    cost.pagesRead++;
    let parsed: ReturnType<typeof checkStructurePage>;
    try { parsed = checkStructurePage(bytes); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (parsed.tree !== this.kind) throw new StructureObjectCorrupt('page belongs to another tree');
    return { level: parsed.level, entries: parsed.entries };
  }

  private async write(level: number, entries: readonly unknown[], cost: TreeCost): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify({ format: STRUCTURE_PAGE_FORMAT,
      tree: this.kind, level, entries }));
    checkStructurePage(bytes);
    cost.pagesWritten++;
    return `sha256:${await this.objects.put(bytes)}`;
  }

  /** Split entries into pages bounded by both entry count and serialized bytes. */
  private chunks<E>(entries: readonly E[]): E[][] {
    const pages: E[][] = [];
    let current: E[] = [];
    let bytes = 96;
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (current.length && (current.length === STRUCTURE_LIMITS.pageEntries
        || bytes + size > STRUCTURE_LIMITS.pageBytes)) {
        pages.push(current);
        current = [];
        bytes = 96;
      }
      current.push(entry);
      bytes += size;
    }
    if (current.length) pages.push(current);
    return pages;
  }

  private async writeLeaves(entries: readonly T[], cost: TreeCost): Promise<Child[]> {
    const children: Child[] = [];
    for (const chunk of this.chunks(entries)) {
      children.push({ page: await this.write(0, chunk, cost), count: chunk.length,
        first: this.keyOf(chunk[0]!) });
    }
    return children;
  }

  private async writeInterior(level: number, children: readonly Child[], cost: TreeCost): Promise<Child[]> {
    const parents: Child[] = [];
    for (const chunk of this.chunks(children)) {
      parents.push({ page: await this.write(level, chunk, cost),
        count: chunk.reduce((total, child) => total + child.count, 0), first: chunk[0]!.first });
    }
    return parents;
  }

  async empty(cost: TreeCost): Promise<TreeRoot> {
    return { page: await this.write(0, [], cost), level: 0, count: 0 };
  }

  private childIndex(children: readonly Child[], key: string): number {
    let index = 0;
    while (index + 1 < children.length && children[index + 1]!.first <= key) index++;
    return index;
  }

  private async rewrite(page: string, changes: readonly [string, T | null][],
    cost: TreeCost): Promise<Child[]> {
    const node = await this.load(page, cost);
    if (node.level === 0) {
      const entries = new Map((node.entries as T[]).map(entry => [this.keyOf(entry), entry]));
      for (const [key, entry] of changes) {
        if (entry === null) entries.delete(key);
        else entries.set(key, entry);
      }
      const sorted = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry);
      return this.writeLeaves(sorted, cost);
    }
    const children = node.entries as Child[];
    const grouped = new Map<number, [string, T | null][]>();
    for (const change of changes) {
      const index = this.childIndex(children, change[0]);
      grouped.set(index, [...grouped.get(index) ?? [], change]);
    }
    const next: Child[] = [];
    for (const [index, child] of children.entries()) {
      const own = grouped.get(index);
      next.push(...own ? await this.rewrite(child.page, own, cost) : [child]);
    }
    return next.length ? this.writeInterior(node.level, next, cost) : [];
  }

  /** Apply puts (entry) and deletes (null) by key and return the new complete root. */
  async apply(root: TreeRoot, changes: ReadonlyMap<string, T | null>, cost: TreeCost): Promise<TreeRoot> {
    if (!changes.size) return root;
    const sorted = [...changes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    let level = root.level;
    let children = await this.rewrite(root.page, sorted, cost);
    if (!children.length) return this.empty(cost);
    while (children.length > 1) {
      level++;
      if (level >= STRUCTURE_LIMITS.treeLevels) throw new StructureObjectCorrupt('Structure tree is too deep');
      children = await this.writeInterior(level, children, cost);
    }
    let top = { page: children[0]!.page, level, count: children[0]!.count };
    while (top.level > 0) {
      const node = await this.load(top.page, cost);
      if (node.entries.length !== 1) break;
      const only = (node.entries as Child[])[0]!;
      top = { page: only.page, level: top.level - 1, count: only.count };
    }
    return top;
  }

  /** Exact entries for a bounded key set, reading only the pages on their paths. */
  async lookup(root: TreeRoot, keys: readonly string[], cost: TreeCost): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    const visit = async (page: string, wanted: readonly string[]): Promise<void> => {
      const node = await this.load(page, cost);
      if (node.level === 0) {
        const wantedSet = new Set(wanted);
        for (const entry of node.entries as T[]) {
          const key = this.keyOf(entry);
          if (wantedSet.has(key)) found.set(key, entry);
        }
        return;
      }
      const children = node.entries as Child[];
      const grouped = new Map<number, string[]>();
      for (const key of wanted) {
        const index = this.childIndex(children, key);
        grouped.set(index, [...grouped.get(index) ?? [], key]);
      }
      for (const [index, own] of grouped) await visit(children[index]!.page, own);
    };
    if (keys.length) await visit(root.page, [...new Set(keys)]);
    return found;
  }

  /** Number of entries before a key, using subtree counts rather than scanning siblings. */
  async countBefore(root: TreeRoot, key: string, cost: TreeCost): Promise<number> {
    let page = root.page;
    let count = 0;
    for (;;) {
      const node = await this.load(page, cost);
      if (node.level === 0) {
        return count + (node.entries as T[]).filter(entry => this.keyOf(entry) < key).length;
      }
      const children = node.entries as Child[];
      const index = this.childIndex(children, key);
      for (let i = 0; i < index; i++) count += children[i]!.count;
      page = children[index]!.page;
    }
  }

  /** Ordered entries with from <= key < to, stopping after `limit`. */
  async range(root: TreeRoot, from: string, to: string, limit: number, cost: TreeCost,
    reverse = false): Promise<T[]> {
    const out: T[] = [];
    const visit = async (page: string): Promise<void> => {
      const node = await this.load(page, cost);
      if (node.level === 0) {
        const entries = node.entries as T[];
        for (const entry of reverse ? entries.slice().reverse() : entries) {
          const key = this.keyOf(entry);
          if (out.length >= limit || (reverse ? key < from : key >= to)) return;
          if (key >= from && key < to) out.push(entry);
        }
        return;
      }
      const children = node.entries as Child[];
      for (let step = 0; step < children.length; step++) {
        const index = reverse ? children.length - step - 1 : step;
        const child = children[index]!;
        if (out.length >= limit) return;
        if (child.first >= to) { if (reverse) continue; return; }
        const next = children[index + 1];
        if (next && next.first <= from) { if (reverse) return; continue; }
        await visit(child.page);
      }
    };
    if (limit > 0) await visit(root.page);
    return out;
  }
}
