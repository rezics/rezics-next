import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { subjectIndexName } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { SubjectListingSource, SubjectSource } from '../../src/search/source.ts';

type Stage = 'allocation' | 'rating' | 'metadata' | 'alias';
type Fault = { stage: Stage; commit: boolean; loseResponse: boolean; malformedObservation?: boolean };
type NativeIndex = { mappings: Record<string, unknown>; aliases: Set<string> };
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the check database');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class NativeSearch {
  readonly indices = new Map<string, NativeIndex>();
  readonly writes = new Map<Stage, number>();
  fault: Fault | undefined;
  malformedResolveReads = 0;

  get active(): string | undefined {
    for (const [name, index] of this.indices) if (index.aliases.has(this.alias)) return name;
    return undefined;
  }

  constructor(readonly alias: string) {}

  failNext(stage: Stage, fault: Omit<Fault, 'stage'>): void {
    this.fault = { stage, ...fault };
  }

  private async write(stage: Stage, effect: () => void) {
    this.writes.set(stage, (this.writes.get(stage) ?? 0) + 1);
    const fault = this.fault?.stage === stage ? this.fault : undefined;
    if (fault) this.fault = undefined;
    if (!fault || fault.commit) effect();
    if (fault?.malformedObservation) this.malformedResolveReads = 1;
    if (fault?.loseResponse) throw new Error('lost native response');
    return { status: 200, body: { acknowledged: !fault } };
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (method === 'GET' && path.startsWith('/_resolve/index/')) {
      if (this.malformedResolveReads > 0) {
        this.malformedResolveReads--;
        return { status: 200, body: { indices: null, aliases: [], data_streams: [] } };
      }
      const indices = [...this.indices].map(([name, index]) => ({
        name,
        attributes: ['open'],
        aliases: [...index.aliases],
      }));
      const aliases = indices.flatMap((index) => index.aliases.map((name) => ({ name, indices: [index.name] })));
      return { status: 200, body: { indices, aliases, data_streams: [] } };
    }

    const mapping = /^\/([^/]+)\/_mapping$/.exec(path);
    if (method === 'GET' && mapping) {
      const index = this.indices.get(mapping[1]!);
      if (!index) return { status: 404, body: { error: { type: 'index_not_found_exception' } } };
      const observed = structuredClone(index.mappings);
      const properties = observed.properties as Record<string, unknown>;
      for (const field of ['rating_score', 'rating_prior_epoch']) {
        const value = properties[field];
        if (object(value) && value.doc_values === true) delete value.doc_values;
      }
      return { status: 200, body: { [mapping[1]!]: { mappings: observed } } };
    }

    if (method === 'PUT' && mapping) {
      const index = this.indices.get(mapping[1]!);
      if (!index) return { status: 404, body: { error: { type: 'index_not_found_exception' } } };
      const patch = body as Record<string, unknown>;
      const stage: Stage = object(patch.properties) ? 'rating' : 'metadata';
      return this.write(stage, () => {
        if (object(patch.properties)) {
          const properties = index.mappings.properties as Record<string, unknown>;
          Object.assign(properties, structuredClone(patch.properties));
        }
        if (object(patch._meta))
          index.mappings._meta = { ...(object(index.mappings._meta) ? index.mappings._meta : {}), ...patch._meta };
      });
    }

    if (method === 'PUT' && /^\/[^/]+$/.test(path)) {
      const name = path.slice(1);
      return this.write('allocation', () => {
        const definition = structuredClone(body as Record<string, unknown>);
        const mappings = definition.mappings as Record<string, unknown>;
        const properties = mappings.properties as Record<string, unknown>;
        delete properties.rating_score;
        delete properties.rating_prior_epoch;
        this.indices.set(name, {
          mappings,
          aliases: new Set(Object.keys(definition.aliases as Record<string, unknown>)),
        });
      });
    }

    if (method === 'POST' && path === '/_aliases') {
      return this.write('alias', () => {
        const actions = (body as { actions: { add: { index: string; alias: string } }[] }).actions;
        for (const { add } of actions) this.indices.get(add.index)?.aliases.add(add.alias);
      });
    }

    return { status: 200, body: {} };
  }
}

function deployment() {
  const prefix = `bootstrap-${crypto.randomUUID().slice(0, 8)}-`;
  const alias = `${prefix}subjects`;
  const search = new NativeSearch(alias);
  const counts = { checkouts: 0 };
  const pool = createPool(databaseUrl!);
  const connect = pool.connect.bind(pool);
  pool.connect = (() => {
    counts.checkouts++;
    return connect();
  }) as Pool['connect'];
  const start = () =>
    startSearchIndexing({
      pool,
      search: search as unknown as OpenSearch,
      source: {} as SubjectSource,
      listing: {} as SubjectListingSource,
      prefix,
      intervalMs: 60_000,
      discoverMs: 60_000,
    });
  return { prefix, search, pool, counts, start };
}

test('uncommitted allocation, rating mapping, and activation writes keep relay checkpoints stopped', async () => {
  for (const stage of ['allocation', 'rating', 'metadata', 'alias'] as const) {
    const current = deployment();
    current.search.failNext(stage, { commit: false, loseResponse: false });
    const runner = await current.start();
    try {
      expect(current.counts.checkouts).toBe(0);
      expect(current.search.active).toBeUndefined();
      await runner.refresh();
      await Bun.sleep(0);
      expect(current.counts.checkouts).toBeGreaterThan(0);
      expect(current.search.active).toBe(subjectIndexName(current.prefix, 1));
    } finally {
      await runner.stop();
      await current.pool.end();
    }
  }
});

test('committed lost responses are observed once at each bootstrap write boundary', async () => {
  for (const stage of ['allocation', 'rating', 'metadata', 'alias'] as const) {
    const current = deployment();
    current.search.failNext(stage, { commit: true, loseResponse: true });
    const runner = await current.start();
    try {
      await Bun.sleep(0);
      expect(current.search.writes.get(stage)).toBe(1);
      expect(current.search.active).toBe(subjectIndexName(current.prefix, 1));
      expect(current.counts.checkouts).toBeGreaterThan(0);
    } finally {
      await runner.stop();
      await current.pool.end();
    }
  }
});

test('a later explicit refresh recovers from committed allocation after malformed readback without replaying it', async () => {
  const current = deployment();
  current.search.failNext('allocation', {
    commit: true,
    loseResponse: true,
    malformedObservation: true,
  });
  const runner = await current.start();
  try {
    expect(current.counts.checkouts).toBe(0);
    expect(current.search.active).toBeUndefined();
    expect(current.search.writes.get('allocation')).toBe(1);
    await runner.refresh();
    await Bun.sleep(0);
    expect(current.search.writes.get('allocation')).toBe(1);
    expect(current.search.active).toBe(subjectIndexName(current.prefix, 1));
    expect(current.counts.checkouts).toBeGreaterThan(0);
  } finally {
    await runner.stop();
    await current.pool.end();
  }
});

test('a normal bootstrap starts relays only after native allocation, mapping and alias are observed', async () => {
  const current = deployment();
  const runner = await current.start();
  try {
    await Bun.sleep(0);
    expect([...current.search.writes.entries()]).toEqual([
      ['allocation', 1],
      ['rating', 1],
      ['metadata', 1],
      ['alias', 1],
    ]);
    expect(current.search.active).toBe(subjectIndexName(current.prefix, 1));
    expect(current.counts.checkouts).toBeGreaterThan(0);
  } finally {
    await runner.stop();
    await current.pool.end();
  }
});
