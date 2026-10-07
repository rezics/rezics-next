import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { verificationLimits } from '../../../services/main/src/modules/verification/schema.ts';
import {
  VerificationStore,
  nativeId,
} from '../../../services/main/src/modules/verification/store.ts';

interface Plan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
}

const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const visits = (plan: Plan) =>
  (plan['Actual Rows'] +
    (plan['Rows Removed by Filter'] ?? 0) +
    (plan['Rows Removed by Index Recheck'] ?? 0)) *
  plan['Actual Loops'];

test('summary pending probes stay local under completed dependency history and unrelated pending growth', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 3 });
  try {
    await migrateContent(pool);
    expect(await migrateContent(pool)).toEqual([]);
    const index = (
      await pool.query(`SELECT i.indisvalid, i.indisready,
      pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i WHERE i.indexrelid = 'verification.invalidation_pending_dependency'::regclass`)
    ).rows[0];
    expect(index).toMatchObject({ indisvalid: true, indisready: true });
    expect(index.definition).toContain('(kind, reference)');
    expect(index.predicate).toBe("(state = 'pending'::text)");

    const started = performance.now();
    const prefix = `urn:rezics:pending-probe:${randomUUID()}`;
    const references = Array.from(
      { length: verificationLimits.summaryDependencies },
      (_, i) => `${prefix}:${i}`,
    );
    const context = `${prefix}:context`;
    const store = new VerificationStore(pool);
    const fixtures = [];
    for (const count of new Set([80, verificationLimits.summaryDependencies])) {
      const target = nativeId(randomUUID());
      const activated = await store.activateSummary({
        target,
        context,
        claim: target,
        claimRevision: nativeId(randomUUID()),
        adoptedRevision: null,
        assessment: nativeId(randomUUID()),
        policyRevision: `${prefix}:policy`,
        support: 'supported',
        review: 'reviewed',
        coverage: 'complete',
        dependence: 'established',
        reasons: ['source-reviewed'],
        ownerPositions: {},
        dependencies: references.slice(0, count).map((reference) => ({
          owner: 'graph' as const,
          kind: 'source-assessment',
          reference,
          expectedHead: nativeId(randomUUID()),
        })),
        operationKey: `pending-probe:${randomUUID()}`,
        expectedActive: null,
        observedDemand: null,
        openChallenges: 0,
        resolvedChallenges: 0,
      });
      expect(activated.status).toBe('activated');
      fixtures.push({ target, count });
    }

    // Capture the production adapter's SQL and bindings, rather than keeping a
    // lookalike query whose plan could diverge from the actual summary reader.
    let captured: { sql: string; values: unknown[] }[] = [];
    const measured = new VerificationStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => {
            if (/FROM verification\.invalidation i/.test(sql))
              captured.push({ sql, values: values ?? [] });
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool);
    const evidence: object[] = [];
    let originalSql: string | undefined;
    async function explain(
      client: Pool | PoolClient,
      statement: { sql: string; values: unknown[] },
      count: number,
      pending: boolean,
      history: number,
      unrelated: number,
    ) {
      const plan = (
        await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${statement.sql}`,
          statement.values,
        )
      ).rows[0]!['QUERY PLAN'][0]!.Plan;
      const scans = nodes(plan).filter((node) => node['Relation Name'] === 'invalidation');
      const rows = scans.reduce((sum, node) => sum + visits(node), 0);
      const buffers = (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
      const metrics = {
        count,
        pending,
        history,
        unrelated,
        rows,
        buffers,
        scans: scans.map((node) => ({
          type: node['Node Type'],
          index: node['Index Name'],
          condition: node['Index Cond'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
          filtered: node['Rows Removed by Filter'] ?? 0,
          rechecked: node['Rows Removed by Index Recheck'] ?? 0,
        })),
      };
      evidence.push(metrics);
      console.info('summary-pending-plan', JSON.stringify(metrics));
      expect(plan['Actual Rows']).toBe(Number(pending));
      if (history + unrelated < 4_096) {
        // EXPLAIN rounds per-loop filter averages: 79/80 becomes 1 while
        // returned rows remain fractional. The one-row baseline has an exact
        // population-times-loops bound instead of summing rounded averages.
        const population = Number(
          (await client.query('SELECT count(*)::int AS rows FROM verification.invalidation'))
            .rows[0].rows,
        );
        expect(population).toBeLessThanOrEqual(1);
        expect(
          scans.reduce((sum, node) => sum + population * node['Actual Loops'], 0),
        ).toBeLessThanOrEqual(count);
      } else expect(rows).toBeLessThanOrEqual(count);
      expect(buffers).toBeLessThanOrEqual(count * 8 + 32);
      const dependencyScans = nodes(plan).filter(
        (node) => node['Relation Name'] === 'summary_dependency',
      );
      expect(dependencyScans.reduce((sum, node) => sum + visits(node), 0)).toBeLessThanOrEqual(
        count,
      );
      for (const scan of scans.filter((node) => node['Actual Loops'] > 0)) {
        expect(scan['Actual Loops']).toBeLessThanOrEqual(count);
        if (unrelated + history >= 4_096) {
          expect(scan['Index Name']).toBe('invalidation_pending_dependency');
          expect(scan['Index Cond']).toMatch(/kind.*reference/s);
          expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
          expect(scan['Rows Removed by Index Recheck'] ?? 0).toBe(0);
        }
      }
    }
    async function read(pending: boolean, history: number, unrelated: number) {
      for (const fixture of fixtures) {
        captured = [];
        const state = await measured.readSummary(fixture.target, context);
        expect(state).toMatchObject({
          support: 'supported',
          review: 'reviewed',
          pendingWork: pending,
        });
        expect(state?.dependencies).toHaveLength(fixture.count);
        expect(captured).toHaveLength(1);
        const statement = captured[0]!;
        originalSql ??= statement.sql;
        expect(statement.sql).toBe(originalSql);
        await explain(pool, statement, fixture.count, pending, history, unrelated);
      }
    }
    async function analyze() {
      await pool.query('ANALYZE verification.invalidation');
      await pool.query('ANALYZE verification.summary_dependency');
      await pool.query('ANALYZE verification.reassessment_request');
    }
    let completed = 0;
    let historyEvents = 0;
    let unrelated = 0;
    // These are growth checkpoints, not an admitted corpus ceiling. Bulk rows
    // retain the production constraints and triggers; no indexes are forced.
    for (const point of [
      { completed: 0, unrelated: 0 },
      { completed: 0, unrelated: 4_096 },
      { completed: 0, unrelated: 65_536 },
      { completed: 4_096, unrelated: 65_536 },
      { completed: 65_536, unrelated: 65_536 },
    ]) {
      await pool.query(
        `INSERT INTO verification.invalidation
        (id, producer, event_key, kind, reference, state, completed_at)
        SELECT gen_random_uuid(), 'graph', $1 || ':history:' || n, 'source-assessment',
          ($2::text[])[(n % 80) + 1], 'complete', clock_timestamp()
        FROM generate_series($3::int + 1, $4::int) n`,
        [
          prefix,
          references,
          historyEvents,
          historyEvents + Math.max(0, point.completed - completed),
        ],
      );
      await pool.query(
        `INSERT INTO verification.invalidation (id, producer, event_key, kind, reference)
        SELECT gen_random_uuid(), 'graph', $1 || ':unrelated:' || n, 'source-assessment',
          $1 || ':unrelated-reference:' || n FROM generate_series($2::int + 1, $3::int) n`,
        [prefix, unrelated, point.unrelated],
      );
      historyEvents += Math.max(0, point.completed - completed);
      completed = Math.max(completed, point.completed);
      unrelated = point.unrelated;
      await analyze();
      expect((performance.now() - started) / 1000).toBeLessThan(600);
      await read(false, completed, unrelated);
      const event = `${prefix}:selected:${completed}:${unrelated}`;
      await store.recordGraphInvalidation(
        event,
        'source-assessment',
        references[79]!,
        nativeId(randomUUID()),
        { dataEpoch: randomUUID(), sequence: '1' },
      );
      await analyze();
      await read(true, completed, unrelated);
      // Removing a completed row from the partial index preserves its durable
      // history. A rolled-back completion must restore its pending visibility.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE verification.invalidation SET state = 'complete', completed_at = clock_timestamp()
          WHERE producer = 'graph' AND event_key = $1`,
          [event],
        );
        captured = [];
        await measured.readSummary(fixtures[0]!.target, context);
        await explain(client, captured[0]!, fixtures[0]!.count, false, completed, unrelated);
        expect((await measured.readSummary(fixtures[0]!.target, context))?.pendingWork).toBe(true);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      await read(true, completed, unrelated);
      await pool.query(
        `UPDATE verification.invalidation SET state = 'complete', completed_at = clock_timestamp()
        WHERE producer = 'graph' AND event_key = $1`,
        [event],
      );
      completed++;
      await analyze();
      await read(false, completed, unrelated);
      expect(
        (
          await pool.query(
            `SELECT state FROM verification.invalidation
        WHERE producer = 'graph' AND event_key = $1`,
            [event],
          )
        ).rows[0]?.state,
      ).toBe('complete');
    }
    console.info(
      'summary-pending-query',
      createHash('sha256').update(originalSql!).digest('hex'),
      JSON.stringify({
        checkpoints: evidence.length,
        preparationSeconds: (performance.now() - started) / 1000,
      }),
    );
  } finally {
    await pool.end();
  }
}, 90_000);
