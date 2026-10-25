import { expect, test } from 'bun:test';
import type { PoolClient, QueryConfig } from 'pg';
import { attemptFixture } from './rate-limit.test.ts';
import { attemptStatement, pruneAuthAttempts } from '../src/rate-limit.ts';

type Statement = { text: string; values: unknown[] };
type Plan = {
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: Plan[];
};
function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function examinedRows(node: Plan): number {
  return (
    (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) *
    node['Actual Loops']
  );
}

function boundedWork(plan: Plan): { blocks: number; rows: number } {
  const all = nodes(plan);
  for (const node of all) {
    expect(node['Actual Loops']).toBeLessThanOrEqual(32);
    if (node['Node Type'] === 'Seq Scan') {
      // PostgreSQL may scan an empty reduction table. Only truly empty work
      // is free: filtered rows and repeated loops must not hide a growing scan.
      expect(examinedRows(node)).toBe(0);
      expect(node['Actual Loops']).toBeLessThanOrEqual(1);
      expect(node['Shared Hit Blocks'] + node['Shared Read Blocks']).toBe(0);
    }
  }
  const rows = all.reduce((sum, node) => sum + examinedRows(node), 0);
  expect(rows).toBeLessThanOrEqual(32);
  return { blocks: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'], rows };
}

if (process.env.AUTH_ATTEMPT_TEST_CHILD === '1') {
  test('native handler statements and counter plans stay bounded at common 1x/8x/64x seeds', async () => {
    const fixture = await attemptFixture();
    const { pool } = fixture;
    const query = pool.query.bind(pool);
    const records: Statement[] = [];
    let measuring = false;
    const instrumented = new WeakSet<PoolClient>();
    pool.on('acquire', (client) => {
      if (instrumented.has(client)) return;
      instrumented.add(client);
      const execute = client.query;
      client.query = ((...args: unknown[]) => {
        if (measuring) {
          const statement = args[0] as string | QueryConfig;
          const text = typeof statement === 'string' ? statement : statement.text;
          const values = Array.isArray(args[1])
            ? args[1]
            : typeof statement === 'string'
              ? []
              : (statement.values ?? []);
          records.push({ text, values });
        }
        return Reflect.apply(execute, client, args);
      }) as typeof client.query;
    });
    const samples: Array<{
      statements: number;
      counterBlocks: number;
      rows: number;
      handlerBlocks: number;
      handlerRows: number;
      successStatements: number;
      successBlocks: number;
      successRows: number;
    }> = [];
    let seeded = 0;
    try {
      // Same active login family, unrelated peers; plus unrelated recovery keys.
      // Native owners, credentials, client and session history grow on the same scale.
      for (const scale of [1, 8, 64]) {
        const size = 1024 * scale;
        await query(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
          SELECT 'cost-owner-'||i, '', 'cost-'||i||'@example.test', false, now(), now()
          FROM generate_series($1::integer, $2::integer) i`,
          [seeded + 1, size],
        );
        await query(
          `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
          SELECT 'cost-account-'||i, 'cost-owner-'||i, 'credential', 'cost-owner-'||i, 'unused-cost-hash', now(), now()
          FROM generate_series($1::integer, $2::integer) i`,
          [seeded + 1, size],
        );
        await query(
          `INSERT INTO auth_client
          SELECT 'cost-client-'||i, true, ARRAY['read'] FROM generate_series($1::integer, $2::integer) i`,
          [seeded + 1, size],
        );
        await query(
          `INSERT INTO session (id, token, "userId", "createdAt", "updatedAt", "expiresAt",
          "clientId", "grantedScope", "authnEpoch", "authTime", "authMethods")
          SELECT 'cost-session-'||i, 'cost-token-'||i, 'cost-owner-'||i, now(), now(), now()+interval '1 day',
            'cost-client-'||i, 'read', 1, 1, 'pwd' FROM generate_series($1::integer, $2::integer) i`,
          [seeded + 1, size],
        );
        // Grow history for the actual subject/client too, so an accidental
        // history scan cannot pass using only unrelated owners' sessions.
        await query(
          `INSERT INTO session (id, token, "userId", "createdAt", "updatedAt", "expiresAt",
          "clientId", "grantedScope", "authnEpoch", "authTime", "authMethods")
          SELECT 'cost-history-'||i, 'cost-history-token-'||i, $3, now(), now(), now()-interval '1 day',
            'attempt-web', 'read', 1, 1, 'pwd' FROM generate_series($1::integer, $2::integer) i`,
          [seeded + 1, size, fixture.account.accountId],
        );
        // Exercise the empty-table plan at 1x, then growing nonempty reductions.
        if (scale > 1) {
          await query(
            `INSERT INTO auth_client_reduction
            SELECT 'cost-client-'||i, 'cost-reduction-'||i, ARRAY['read'], true
            FROM generate_series($1::integer, $2::integer) i`,
            [seeded + 1, size],
          );
        }
        const keys: string[] = [];
        for (let i = seeded + 1; i <= size; i++) {
          fixture.setPeer(`10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`);
          keys.push(fixture.counterKey('/sign-in/email'), fixture.counterKey('/request-password-reset'));
        }
        await query(
          `INSERT INTO auth_attempt_counter
          SELECT key, 1, statement_timestamp(), true FROM unnest($1::text[]) key`,
          [keys],
        );
        seeded = size;
        await query('ANALYZE');
        fixture.setPeer(`198.51.100.${scale}`);
        records.length = 0;
        measuring = true;
        const response = await fixture.signin(fixture.first, 'wrong password');
        measuring = false;
        expect(response.status).toBe(401);
        const captured = [...records];
        const counters = captured.filter((statement) => statement.text === attemptStatement);
        expect(counters).toHaveLength(1);
        expect(captured.length).toBeGreaterThan(1);
        expect(captured.length).toBeLessThanOrEqual(5);
        // Explain exactly the statements emitted by the actual handler/adapter,
        // including native credential and registered-client reads.
        let handlerBlocks = 0;
        let handlerRows = 0;
        let counterBlocks = 0;
        let rows = 0;
        for (const statement of captured) {
          const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
          const plan = result.rows[0]['QUERY PLAN'][0].Plan as Plan;
          const work = boundedWork(plan);
          const blocks = work.blocks;
          handlerBlocks += blocks;
          handlerRows += work.rows;
          if (statement.text === attemptStatement) {
            counterBlocks = blocks;
            rows = plan['Actual Rows'];
            expect(rows).toBe(1);
            expect(
              nodes(plan).filter((node) => node['Relation Name'] === 'auth_attempt_counter' && node['Actual Rows'] > 1),
            ).toEqual([]);
          }
        }
        expect((await fixture.signin(fixture.first, 'wrong password')).status).toBe(401);
        fixture.setPeer(`203.0.113.${scale}`);
        records.length = 0;
        measuring = true;
        expect((await fixture.signin(fixture.first)).status).toBe(200);
        measuring = false;
        const successStatements = records.length;
        expect(records.filter((record) => record.text === attemptStatement)).toHaveLength(1);
        expect(successStatements).toBeGreaterThan(captured.length);
        expect(successStatements).toBeLessThanOrEqual(15);
        // Replay the exact successful statements in a rolled-back transaction.
        // Remove only the just-created session by its native INSERT id so its
        // original INSERT can run again without a primary-key conflict.
        const success = [...records];
        let successBlocks = 0;
        let successRows = 0;
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          for (const statement of success) {
            const columns = /^insert into "session" \(([^)]+)\)/i.exec(statement.text)?.[1];
            if (columns) {
              const idIndex = columns.split(',').findIndex((column) => column.trim() === '"id"');
              expect(idIndex).toBeGreaterThanOrEqual(0);
              await connection.query('DELETE FROM session WHERE id=$1', [statement.values[idIndex]]);
            }
          }
          for (const statement of success) {
            const result = await connection.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
              statement.values,
            );
            const work = boundedWork(result.rows[0]['QUERY PLAN'][0].Plan as Plan);
            successBlocks += work.blocks;
            successRows += work.rows;
          }
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
        samples.push({
          statements: captured.length,
          counterBlocks,
          rows,
          handlerBlocks,
          handlerRows,
          successStatements,
          successBlocks,
          successRows,
        });
        fixture.setPeer(`198.51.100.${scale}`);
        // Rejected admission does no credential/client/session query at all.
        records.length = 0;
        measuring = true;
        expect((await fixture.signin(fixture.first)).status).toBe(429);
        measuring = false;
        expect(records.map((record) => record.text)).toEqual([attemptStatement]);
      }
      expect(new Set(samples.map((sample) => sample.statements)).size).toBe(1);
      expect(new Set(samples.map((sample) => sample.successStatements)).size).toBe(1);
      for (let index = 0; index < samples.length; index++) {
        const sample = samples[index]!;
        // Generous B-tree height envelope, independent of wall-clock timing.
        expect(sample.counterBlocks).toBeLessThanOrEqual(samples[0]!.counterBlocks + 12 * index + 16);
        expect(sample.handlerBlocks).toBeLessThanOrEqual(samples[0]!.handlerBlocks + 20 * index + 24);
        expect(sample.handlerRows).toBeLessThanOrEqual(samples[0]!.handlerRows);
        expect(sample.successBlocks).toBeLessThanOrEqual(samples[0]!.successBlocks + 40 * index + 48);
        expect(sample.successRows).toBeLessThanOrEqual(samples[0]!.successRows);
      }
      console.info('Auth attempt cost (1x/8x/64x):', JSON.stringify(samples));
      // Maintenance has an indexed cutoff and a hard batch bound; no handler sweep.
      await query("UPDATE auth_attempt_counter SET last_request=statement_timestamp()-interval '49 hours'");
      await query('ANALYZE auth_attempt_counter');
      records.length = 0;
      measuring = true;
      expect(await pruneAuthAttempts(pool, 7)).toBe(7);
      measuring = false;
      expect(records).toHaveLength(1);
      const maintenance = records[0]!;
      const plan = (await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${maintenance.text}`, maintenance.values))
        .rows[0]['QUERY PLAN'][0].Plan as Plan;
      expect(nodes(plan).filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
      expect(nodes(plan).some((node) => node['Node Type'] === 'Index Scan')).toBe(true);
      expect(nodes(plan).find((node) => node['Node Type'] === 'Limit')?.['Actual Rows']).toBe(7);
    } finally {
      measuring = false;
      await fixture.close();
    }
  }, 60000);
}
