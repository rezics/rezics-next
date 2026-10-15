import { AsyncLocalStorage } from 'node:async_hooks';

// Transport evidence stays outside the SPARQL JSON and public read positions.
const graphVersions = new WeakMap<object, string>();
export function noteGraphReadVersion(result: object, version: string): void { graphVersions.set(result, version); }
export function graphReadVersion(result: object): string | undefined { return graphVersions.get(result); }

/** Request-local graph inputs, reusable only between two equal live version
 * probes. SQL authority, native indexes and time-dependent queries stay live. */
export class GraphReadFence {
  constructor(private readonly client: object) {}
  private used = false;
  get reused() { return this.used; }
  private readonly values = new Map<string, unknown>();
  has(client: object, key: string): boolean {
    return client === this.client && this.values.has(key);
  }
  capture<T>(operation: () => Promise<T>): Promise<T> {
    return graphReads.run({ fence: this, replay: false }, operation);
  }
  verify<T>(operation: () => Promise<T>): Promise<T> {
    return graphReads.run({ fence: this, replay: true }, operation);
  }
  async read<T>(client: object, key: string, replay: boolean, read: () => Promise<T>): Promise<T> {
    if (client !== this.client) return read();
    if (replay && this.values.has(key)) {
      this.used = true;
      return structuredClone(this.values.get(key)) as T;
    }
    const value = await read();
    // Retain the first observation: a later query must not repair a mixed read.
    if (!this.values.has(key)) this.values.set(key, structuredClone(value));
    return value;
  }
}
const graphReads = new AsyncLocalStorage<{ fence: GraphReadFence; replay: boolean }>();
const separatelyChanging = /\b(?:SERVICE|NOW|RAND|UUID|STRUUID|BNODE)\b|\btext:|jena\.apache\.org/i;

/** Cost meters count transport calls, including fallback reads, rather than retained inputs. */
export function isRetainedGraphQuery(client: object, query: string, maxBytes?: number, nativePhase?: string): boolean {
  const scope = graphReads.getStore();
  return !nativePhase && !separatelyChanging.test(query) && !!scope?.replay
    && scope.fence.has(client, JSON.stringify([query, maxBytes]));
}

export function fencedGraphQuery<T>(client: object, query: string, maxBytes: number | undefined,
  read: () => Promise<T>): Promise<T> {
  const scope = graphReads.getStore();
  // Index readiness and external/time-dependent functions have a separate
  // basis. False positives here only retain an extra read.
  if (!scope || separatelyChanging.test(query)) return read();
  return scope.fence.read(client, JSON.stringify([query, maxBytes]), scope.replay, read);
}
