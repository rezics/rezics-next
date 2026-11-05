import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createFacetDiscoveryStorage } from '../../src/search/facet-discovery-storage.ts';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(value) ?? '')
    .digest('hex');
const cost = () => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});

test('facet preparation expires only indexed live heads across retired history', async () => {
  const native = createPool(process.env.DATABASE_URL!);
  const queries: { sql: string; values: unknown[] }[] = [];
  const track =
    (execute: (sql: string, values: unknown[]) => Promise<QueryResult>) =>
    async <R extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return execute(sql, values) as Promise<QueryResult<R>>;
    };
  const pool = {
    query: track((sql, values) => native.query(sql, values as any[])),
    async connect() {
      const client = await native.connect();
      return {
        query: track((sql, values) => client.query(sql, values as any[])),
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const now = Date.now();
  const deadline = now + 60_000;
  const partition = 4095;
  const fixtures: { definition: string; observation: string; generation: string }[] = [];

  const key = (consumer: string, digest: string, observation: string) => {
    const definition = hash({ consumer, property: 'type', meaning: digest });
    const generation = hash({ observation, property: 'type' });
    fixtures.push({ definition, observation, generation });
    return { definition, generation };
  };
  const seed = async (
    definition: string,
    observation: string,
    heads: readonly { generation: string; state: 'building' | 'ready'; expires: number; lease: number }[],
  ) => {
    await native.query(
      `INSERT INTO search.facet_generation
       (partition_no,definition,generation,property,observation,state,phase,expires_at)
       SELECT $1,$2,'retired-'||n,'type',$3,'retired','population',$4 FROM generate_series(1,256) AS n`,
      [partition, definition, observation, now - 1],
    );
    for (const head of heads)
      await native.query(
        `INSERT INTO search.facet_generation
         (partition_no,definition,generation,property,observation,state,phase,expires_at,lease_until)
         VALUES ($1,$2,$3,'type',$4,$5,'population',$6,$7)`,
        [partition, definition, head.generation, observation, head.state, head.expires, head.lease],
      );
  };
  const prepare = async (consumer: string, digest: string, observation: string) => {
    const { generation } = key(consumer, digest, observation);
    const storage = createFacetDiscoveryStorage({
      pool,
      source: {} as never,
      binding: {
        join: async () => ({
          status: 'joined' as const,
          definition: {
            source: { partition },
            capture: { filterDocument: undefined, text: undefined },
            meaning: { digest },
            dependencyKeys: [{ kind: 'type' as const }],
            readDefinition: 'facet population' as never,
          },
          cost: cost(),
        }),
      } as never,
      population: {
        readFacetPopulationPage: async ({ capture }) => ({
          status: 'progress' as const,
          observation: capture.queried.snapshot.observation,
          subjects: [],
          frontier: 'next-frontier',
          cost: cost(),
        }),
      },
      subjects: {} as never,
      search: {} as never,
      clock: () => new Date(now),
    });
    await storage.prepareFacetStep(
      {
        filterDocument: undefined,
        text: undefined,
        property: 'type',
        valueKind: 'type',
        meaning: { digest } as never,
      },
      {
        consumer: consumer as never,
        snapshot: { kind: 'prepared', observation, build: 'build', generation: 1n },
      },
      { deadline },
      cost(),
    );
    return generation;
  };

  try {
    const first = key('consumer-building-expired', 'meaning-building-expired', 'observation-building-expired');
    await seed(first.definition, 'observation-building-expired', [
      { generation: 'expired-building', state: 'building', expires: now - 1, lease: 0 },
      { generation: 'retained-ready', state: 'ready', expires: now + 86_400_000, lease: 0 },
    ]);
    const created = await prepare(
      'consumer-building-expired',
      'meaning-building-expired',
      'observation-building-expired',
    );
    const firstRows = (
      await native.query(
        `SELECT generation,state,lease_until,version,frontier FROM search.facet_generation
         WHERE partition_no=$1 AND definition=$2`,
        [partition, first.definition],
      )
    ).rows;
    const firstByGeneration = new Map(firstRows.map((row) => [row.generation, row]));
    expect(firstByGeneration.get('expired-building')?.state).toBe('retired');
    expect(firstByGeneration.get('retained-ready')).toMatchObject({ state: 'ready', version: '1' });
    expect(firstByGeneration.get(created)).toMatchObject({
      state: 'building',
      version: '2',
      lease_until: '0',
      frontier: 'next-frontier',
    });
    expect(firstRows.filter((row) => row.state === 'retired')).toHaveLength(257);

    const second = key('consumer-ready-expired', 'meaning-ready-expired', 'observation-ready-expired');
    const leasedUntil = deadline + 60_000;
    await seed(second.definition, 'observation-ready-expired', [
      { generation: second.generation, state: 'building', expires: now + 86_400_000, lease: leasedUntil },
      { generation: 'expired-ready', state: 'ready', expires: now - 1, lease: 0 },
    ]);
    await prepare('consumer-ready-expired', 'meaning-ready-expired', 'observation-ready-expired');
    const secondRows = (
      await native.query(
        `SELECT generation,state,lease_until,version FROM search.facet_generation
         WHERE partition_no=$1 AND definition=$2`,
        [partition, second.definition],
      )
    ).rows;
    expect(secondRows.find((row) => row.generation === second.generation)).toMatchObject({
      state: 'building',
      lease_until: String(leasedUntil),
      version: '1',
    });
    expect(secondRows.find((row) => row.generation === 'expired-ready')?.state).toBe('retired');
    expect(secondRows.filter((row) => row.state === 'retired')).toHaveLength(257);

    const expiryQueries = queries.filter((query) =>
      /UPDATE search\.facet_generation SET state='retired'[\s\S]*expires_at<=\$3/.test(query.sql),
    );
    expect(expiryQueries).toHaveLength(4);
    expect(expiryQueries.map(({ sql }) => sql.match(/AND state='(building|ready)'/)?.[1])).toEqual([
      'building',
      'ready',
      'building',
      'ready',
    ]);
    for (const { sql } of expiryQueries) {
      expect(sql).toContain('WHERE partition_no=$1 AND definition=$2');
      expect(sql).not.toContain("state<>'retired'");
    }
  } finally {
    for (const fixture of fixtures)
      await native.query('DELETE FROM search.facet_generation WHERE partition_no=$1 AND definition=$2', [
        partition,
        fixture.definition,
      ]);
    await native.end();
  }
});
