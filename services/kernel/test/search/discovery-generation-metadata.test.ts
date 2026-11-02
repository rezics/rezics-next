import { expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import type { DiscoveryRegistry } from '../../src/search/discovery.ts';
import {
  allocateDiscovery,
  discoveryConsumer,
  discoveryGenerations,
  DISCOVERY_GENERATION_HIGH_WATER_SQL,
  DISCOVERY_LIVE_GENERATIONS_SQL,
} from '../../src/search/generations.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the check database');

const registry = { entries: [{ kind: 'account' }] } as DiscoveryRegistry;
type Plan = {
  'Node Type'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
};

function nodes(value: unknown): Plan[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Plan;
  return [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];
}

test('discovery allocation admits a keyed high water and bounded live inventory over retired history', async () => {
  const pool = createPool(databaseUrl);
  const prefix = `meta-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}-`;
  const other = `meta-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}-`;
  const insert = (owned: string, generation: number, state: string) =>
    withConnection(pool, (client) =>
      client.query(
        `INSERT INTO search.discovery_generation(prefix,generation,incarnation,kinds,state)
         VALUES ($1,$2,$3,ARRAY['account'],$4)`,
        [owned, generation, crypto.randomUUID(), state],
      ),
    );
  const count = (sql: string, values: unknown[]) =>
    withConnection(pool, async (client) => (await client.query<{ n: number }>(sql, values)).rows[0]!.n);
  const cleanup = () =>
    withConnection(pool, async (client) => {
      for (const owned of [prefix, other]) {
        await client.query('DELETE FROM search.discovery_population WHERE prefix=$1', [owned]);
        await client.query('DELETE FROM search.discovery_generation WHERE prefix=$1', [owned]);
        await client.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [
          `search_${owned.replaceAll('-', '_')}discovery_g%`,
        ]);
      }
    });
  try {
    for (let generation = 1; generation <= 48; generation++) {
      await insert(prefix, generation, 'retired');
      await insert(other, generation, 'retired');
    }
    await insert(prefix, 49, 'active');
    await insert(prefix, 50, 'retiring');
    expect((await discoveryGenerations(pool, prefix)).map(({ generation, state }) => [generation, state])).toEqual([
      [49, 'active'],
      [50, 'retiring'],
    ]);
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const [sql, index, rows] of [
        [DISCOVERY_GENERATION_HIGH_WATER_SQL, 'discovery_generation_pkey', 1],
        [DISCOVERY_LIVE_GENERATIONS_SQL, 'discovery_generation_live', 2],
      ] as const) {
        const explained = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          [prefix],
        );
        const scans = nodes(explained.rows[0]!['QUERY PLAN']).filter(
          (node) => node['Relation Name'] === 'discovery_generation',
        );
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(['Index Scan', 'Index Only Scan']).toContain(scan['Node Type']);
          expect(scan['Index Name']).toBe(index);
          expect(String(scan['Index Cond'])).toContain('prefix');
          expect(Number(scan['Actual Rows'])).toBe(rows);
          expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
        }
      }
      await client.query('ROLLBACK');
    });
    await allocateDiscovery(pool, prefix, registry);
    expect((await discoveryGenerations(pool, prefix)).map(({ generation, state }) => [generation, state])).toEqual([
      [49, 'active'],
      [50, 'retiring'],
      [51, 'allocated'],
    ]);
    expect(
      await count('SELECT count(*)::int AS n FROM search.discovery_population WHERE prefix=$1 AND generation=51', [
        prefix,
      ]),
    ).toBe(8192);
    await allocateDiscovery(pool, prefix, registry);
    expect((await discoveryGenerations(pool, prefix)).map(({ generation }) => generation)).toEqual([49, 50, 51]);
    await withConnection(pool, (client) =>
      client.query("UPDATE search.discovery_generation SET state='quarantined' WHERE prefix=$1 AND generation=51", [
        prefix,
      ]),
    );
    await expect(allocateDiscovery(pool, prefix, registry)).rejects.toThrow('Discovery live generation limit reached');
    await cleanup();
    for (const [generation, state] of [
      [1, 'active'],
      [2, 'retiring'],
      [3, 'quarantined'],
      [4, 'populating'],
    ] as const)
      await insert(prefix, generation, state);
    await expect(discoveryGenerations(pool, prefix)).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(allocateDiscovery(pool, prefix, registry)).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(await count('SELECT count(*)::int AS n FROM search.discovery_generation WHERE prefix=$1', [prefix])).toBe(4);
    await cleanup();
    await insert(prefix, Number.MAX_SAFE_INTEGER, 'retired');
    await expect(allocateDiscovery(pool, prefix, registry)).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(await discoveryGenerations(pool, prefix)).toEqual([]);
    expect(
      await count('SELECT count(*)::int AS n FROM search.discovery_generation WHERE prefix=$1 AND generation<>$2', [
        prefix,
        Number.MAX_SAFE_INTEGER,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int AS n FROM core.consumer_checkpoint WHERE consumer=$1', [
        discoveryConsumer(prefix, Number.MAX_SAFE_INTEGER),
      ]),
    ).toBe(0);
  } finally {
    await cleanup();
    await pool.end();
  }
}, 60_000);
