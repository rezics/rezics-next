import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  ASSESSMENT_HISTORY_SQL,
  readVerificationAssessmentHistory,
} from '../../../services/main/src/modules/access/assessment-history.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const action = 'verification.claim-assess';
const scope = 'verification:assess:global';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const receipt = (admission: string) =>
  `urn:rezics:receipt:${createHash('sha256').update(`${admission}\0claim-assess`).digest('hex')}`;

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated QA integration');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access']);
  const pool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const principal = randomUUID(),
    subject = `https://rezics.com/id/${randomUUID()}`;
  try {
    await pool.query(
      `INSERT INTO access.principal (id,account_issuer,account_subject,active)
      VALUES ($1,'https://assessment-history.test',$2,false)`,
      [principal, randomUUID()],
    );
    await pool.query(
      "INSERT INTO access.authority_subject (id,kind,active) VALUES ($1,'agent',false)",
      [subject],
    );
    await pool.query(
      `INSERT INTO access.scope_gate (id,authority_epoch)
      VALUES ($1,99),('verification:assess:unexpected',99) ON CONFLICT DO NOTHING`,
      [scope],
    );
  } catch (error) {
    await pool.end();
    await databases.close();
    throw error;
  }
  const insert = async (
    ids: string[],
    state: 'registered' | 'claimed' | 'sealed' = 'sealed',
    rowScope = scope,
  ) => {
    await pool.query(
      `INSERT INTO access.admission
      (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
        authority_epoch,registered_at,expires_at,state,claimed_at,
        graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
      SELECT i,$2,$3,$4,$5,i::text,repeat('a',64),0,
        '2020-01-01'::timestamptz,'2020-01-02'::timestamptz,$6,
        CASE WHEN $6 <> 'registered' THEN '2020-01-01'::timestamptz END,
        CASE WHEN $6 = 'sealed' THEN r END,
        CASE WHEN $6 = 'sealed' THEN 'succeeded' END,
        CASE WHEN $6 = 'sealed' THEN 'historical-graph' END,
        CASE WHEN $6 = 'sealed' THEN '1' END,
        CASE WHEN $6 = 'sealed' THEN '2020-01-01'::timestamptz END
      FROM unnest($1::uuid[],$7::text[]) AS seed(i,r)`,
      [ids, principal, subject, rowScope, action, state, ids.map(receipt)],
    );
  };
  return {
    pool,
    url: databases.urls.access,
    principal,
    subject,
    insert,
    close: async () => {
      await pool.end();
      await databases.close();
    },
  };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function waitsOnLock(pool: Pool, pid: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = await pool.query<{ waiting: boolean }>(
      "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (status.rows[0]?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error('History operation did not wait on the held owner row');
}

test('Assessment history includes expired sealed admissions and claimed native identities without original custody', async () => {
  const f = await fixture();
  try {
    const sealed = Array.from({ length: 32 }, (_, n) => id(n + 1)),
      claimed = id(33);
    await f.insert(sealed);
    await f.insert([claimed], 'claimed');
    const first = await transaction(f.pool, (client) => readVerificationAssessmentHistory(client));
    expect(first.rows.map((row) => row.id)).toEqual(sealed);
    expect(first.next).toEqual({ after: sealed.at(-1)!, recoveryGeneration: null });
    expect(first.windowExhausted).toBe(false);
    expect(first.endOfHistory).toBe(false);
    for (const row of first.rows) {
      expect(row).toMatchObject({
        originalCustody: 'unknown',
        unresolved: [],
        nativeReceipt: receipt(row.id),
        facts: {
          principalId: f.principal,
          actingSubject: f.subject,
          authorityEpoch: '0',
          state: 'sealed',
        },
      });
      expect(Object.keys(row.facts!)).not.toContain('accountIssuer');
      expect(Object.keys(row.facts!)).not.toContain('accountSubject');
      expect(Object.keys(row.facts!)).not.toContain('authorityWitness');
    }
    const last = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { cursor: first.next! }),
    );
    expect(last.rows).toHaveLength(1);
    expect(last.rows[0]).toMatchObject({
      id: claimed,
      nativeReceipt: receipt(claimed),
      originalCustody: 'unknown',
      unresolved: ['in-flight'],
      facts: { state: 'claimed', graphReceipt: null },
    });
    expect(last).toMatchObject({
      next: null,
      windowExhausted: true,
      endOfHistory: false,
      cut: { state: 'unresolved', reason: 'access-not-quiesced' },
    });
  } finally {
    await f.close();
  }
}, 30_000);

test('Malformed and oversized admissions consume the full raw window and unexpected scope remains visible', async () => {
  const f = await fixture();
  try {
    const rawIds = Array.from({ length: 33 }, (_, n) => id(n + 1));
    await f.insert(rawIds.slice(0, 31));
    await f.insert([rawIds[31]!], 'sealed', 'verification:assess:unexpected');
    await f.insert([rawIds[32]!]);
    // PostgreSQL admits infinity timestamps; they are not exact finite admission facts.
    await f.pool.query(
      "UPDATE access.admission SET registered_at='infinity' WHERE id = ANY($1::uuid[])",
      [rawIds.slice(0, 16)],
    );
    await f.pool.query(
      "UPDATE access.admission SET graph_data_epoch=repeat('x',17000) WHERE id = ANY($1::uuid[])",
      [rawIds.slice(16, 31)],
    );
    const page = await transaction(f.pool, (client) => readVerificationAssessmentHistory(client));
    expect(page.rows.map((row) => row.id)).toEqual(rawIds.slice(0, 32));
    expect(page.next).toEqual({ after: rawIds[31]!, recoveryGeneration: null });
    expect(page.windowExhausted).toBe(false);
    expect(
      page.rows
        .slice(0, 16)
        .every((row) => row.facts === null && row.unresolved.includes('malformed-fields')),
    ).toBe(true);
    expect(
      page.rows
        .slice(16, 31)
        .every((row) => row.facts === null && row.unresolved.includes('oversized-fields')),
    ).toBe(true);
    expect(page.rows[31]).toMatchObject({
      id: rawIds[31],
      originalCustody: 'unknown',
      facts: { scope: 'verification:assess:unexpected' },
      unresolved: ['unexpected-scope'],
    });
    const next = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { cursor: page.next! }),
    );
    expect(next.rows.map((row) => row.id)).toEqual([rawIds[32]!]);
    expect(next.endOfHistory).toBe(false);
    const oversized = await transaction(f.pool, (client) =>
      client.query(ASSESSMENT_HISTORY_SQL.continuation, [rawIds[15]!]),
    );
    expect(oversized.rows[0]).toMatchObject({
      id: rawIds[16],
      oversized_fields: true,
      graph_data_epoch: null,
      acting_subject: null,
      scope_id: null,
    });
  } finally {
    await f.close();
  }
}, 30_000);

test('History waits for the first raw admission and retains SHARE locks on emitted rows and lookahead', async () => {
  const f = await fixture();
  const writer = await f.pool.connect(),
    reader = await f.pool.connect(),
    probe = await f.pool.connect();
  let pending: ReturnType<typeof readVerificationAssessmentHistory> | undefined;
  try {
    const ids = Array.from({ length: 33 }, (_, n) => id(n + 1));
    await f.insert(ids);
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM access.admission WHERE id=$1 FOR UPDATE', [ids[0]]);
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const pid = (await reader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    pending = readVerificationAssessmentHistory(reader);
    await waitsOnLock(f.pool, pid);
    await writer.query('COMMIT');
    const page = await pending;
    expect(page.rows.map((row) => row.id)).toEqual(ids.slice(0, 32));
    for (const locked of [ids[0], ids[32]]) {
      await probe.query('BEGIN');
      await expect(
        probe.query('SELECT id FROM access.admission WHERE id=$1 FOR UPDATE NOWAIT', [locked]),
      ).rejects.toMatchObject({ code: '55P03' });
      await probe.query('ROLLBACK');
    }
  } finally {
    await writer.query('ROLLBACK');
    await pending?.catch(() => undefined);
    await reader.query('ROLLBACK');
    await probe.query('ROLLBACK');
    writer.release();
    reader.release();
    probe.release();
    await f.close();
  }
}, 30_000);

test('An unfenced traversal retains uncertainty after a pending row seals and an admission is inserted behind its cursor', async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 33 }, (_, n) => id((n + 1) * 2));
    await f.insert(ids, 'claimed');
    // A scope-only pause is not an action-wide Access recovery cut.
    await f.pool.query('UPDATE access.scope_gate SET open=false,dispatch_open=false WHERE id=$1', [
      scope,
    ]);
    const first = await transaction(f.pool, (client) => readVerificationAssessmentHistory(client));
    expect(first.rows[0]).toMatchObject({
      id: ids[0],
      unresolved: ['in-flight'],
      originalCustody: 'unknown',
    });
    await f.pool.query(
      `UPDATE access.admission SET state='sealed',graph_receipt=$2,
      graph_outcome='succeeded',graph_data_epoch='later-graph',graph_sequence='2',sealed_at=clock_timestamp()
      WHERE id=$1`,
      [ids[0], receipt(ids[0]!)],
    );
    const behind = id(3);
    await f.insert([behind]);
    const last = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { cursor: first.next! }),
    );
    expect(last.rows.map((row) => row.id)).toEqual([ids[32]!]);
    expect(last).toMatchObject({
      next: null,
      windowExhausted: true,
      endOfHistory: false,
      cut: { state: 'unresolved', reason: 'access-not-quiesced' },
    });
    expect(first.rows[0]!.unresolved).toEqual(['in-flight']);
    const rechecked = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client),
    );
    expect(rechecked.rows[0]).toMatchObject({
      id: ids[0],
      facts: { state: 'sealed' },
      originalCustody: 'unknown',
    });
    expect(rechecked.rows.some((row) => row.id === behind)).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test('A one-connection caller retains transaction identity and settings; autocommit, repeatable read and read-only are rejected', async () => {
  const f = await fixture(),
    owner = new Pool({ connectionString: f.url, max: 1, connectionTimeoutMillis: 1500 });
  const client = await owner.connect();
  try {
    await f.insert([id(1)]);
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const identity = async () =>
      (
        await client.query(`SELECT pg_backend_pid() AS pid,txid_current()::text AS xid,
      current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
      current_setting('transaction_isolation') AS isolation`)
      ).rows[0];
    const before = await identity();
    await client.query('SAVEPOINT caller_work');
    await readVerificationAssessmentHistory(client);
    expect(await identity()).toEqual(before);
    await client.query('ROLLBACK TO SAVEPOINT caller_work');
    await client.query('COMMIT');
    await expect(readVerificationAssessmentHistory(client)).rejects.toMatchObject({
      code: '25P01',
    });
    expect((await client.query('SELECT 1 AS alive')).rows[0]).toEqual({ alive: 1 });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(readVerificationAssessmentHistory(client)).rejects.toThrow('READ COMMITTED');
    await client.query('ROLLBACK');
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await expect(readVerificationAssessmentHistory(client)).rejects.toMatchObject({
      code: '25006',
    });
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await owner.end();
    await f.close();
  }
}, 30_000);

test('Only the matching closed Access recovery generation establishes EOF and its lock prevents reopening', async () => {
  const f = await fixture(),
    reader = await f.pool.connect(),
    writer = await f.pool.connect();
  let changing: Promise<unknown> | undefined;
  try {
    await f.insert([id(1)], 'sealed', 'verification:assess:unexpected');
    await f.pool.query(
      'UPDATE access.recovery_fence SET open=false,generation=generation+1 WHERE id',
    );
    const generation = (
      await f.pool.query<{ generation: string }>(
        'SELECT generation::text AS generation FROM access.recovery_fence WHERE id',
      )
    ).rows[0]!.generation;
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const held = await readVerificationAssessmentHistory(reader, {
      recoveryGeneration: generation,
    });
    expect(held).toMatchObject({
      windowExhausted: true,
      endOfHistory: true,
      cut: { state: 'held', recoveryGeneration: generation },
    });
    expect(held.rows[0]).toMatchObject({
      unresolved: ['unexpected-scope'],
      originalCustody: 'unknown',
    });
    await writer.query('BEGIN');
    const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    changing = writer.query(
      'UPDATE access.recovery_fence SET open=true,generation=generation+1 WHERE id',
    );
    await waitsOnLock(f.pool, pid);
    await reader.query('ROLLBACK');
    await changing;
    await writer.query('COMMIT');
    await expect(
      transaction(f.pool, (client) =>
        readVerificationAssessmentHistory(client, { recoveryGeneration: generation }),
      ),
    ).rejects.toThrow('Access cut changed');
    await f.pool.query('UPDATE access.recovery_fence SET open=false WHERE id');
    await expect(
      transaction(f.pool, (client) =>
        readVerificationAssessmentHistory(client, { recoveryGeneration: generation }),
      ),
    ).rejects.toThrow('Access cut changed');
    const empty = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, {
        cursor: { after: id(1), recoveryGeneration: null },
      }),
    );
    expect(empty).toMatchObject({
      rows: [],
      windowExhausted: true,
      endOfHistory: false,
      cut: { state: 'unresolved', reason: 'access-not-quiesced' },
    });
  } finally {
    await reader.query('ROLLBACK');
    await changing?.catch(() => undefined);
    await writer.query('ROLLBACK');
    reader.release();
    writer.release();
    await f.close();
  }
}, 30_000);

test('Continuation retains its original cut and cannot upgrade an unfenced prefix or switch recovery generations', async () => {
  const f = await fixture();
  try {
    await f.insert(Array.from({ length: 33 }, (_, n) => id(n + 1)));
    const uncut = await transaction(f.pool, (client) => readVerificationAssessmentHistory(client));
    expect(uncut.next?.recoveryGeneration).toBeNull();
    await f.pool.query(
      'UPDATE access.recovery_fence SET open=false,generation=generation+1 WHERE id',
    );
    const generation = (
      await f.pool.query<{ generation: string }>(
        'SELECT generation::text AS generation FROM access.recovery_fence WHERE id',
      )
    ).rows[0]!.generation;
    const suffix = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { cursor: uncut.next! }),
    );
    expect(suffix).toMatchObject({
      windowExhausted: true,
      endOfHistory: false,
      cut: { state: 'unresolved', reason: 'access-not-quiesced' },
    });
    const upgraded = {
      cursor: uncut.next!,
      recoveryGeneration: generation,
    } as unknown as Parameters<typeof readVerificationAssessmentHistory>[1];
    await expect(
      transaction(f.pool, (client) => readVerificationAssessmentHistory(client, upgraded)),
    ).rejects.toThrow('Invalid assessment history position');
    const held = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { recoveryGeneration: generation }),
    );
    expect(held.next?.recoveryGeneration).toBe(generation);
    const final = await transaction(f.pool, (client) =>
      readVerificationAssessmentHistory(client, { cursor: held.next! }),
    );
    expect(final).toMatchObject({
      windowExhausted: true,
      endOfHistory: true,
      cut: { state: 'held', recoveryGeneration: generation },
    });
    await f.pool.query('UPDATE access.recovery_fence SET generation=generation+1 WHERE id');
    await expect(
      transaction(f.pool, (client) =>
        readVerificationAssessmentHistory(client, { cursor: held.next! }),
      ),
    ).rejects.toThrow('Access cut changed');
    const switched = {
      cursor: held.next!,
      recoveryGeneration: String(BigInt(generation) + 1n),
    } as unknown as Parameters<typeof readVerificationAssessmentHistory>[1];
    await expect(
      transaction(f.pool, (client) => readVerificationAssessmentHistory(client, switched)),
    ).rejects.toThrow('Invalid assessment history position');
  } finally {
    await f.close();
  }
}, 30_000);

interface Plan {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

test('Generic prepared history plans seek the partial UUID index across sparse admissions and unrelated growth', async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 80 }, (_, n) => id((n + 1) * 400));
    await f.insert(ids, 'claimed');
    await transaction(f.pool, async (client) => {
      await client.query('SET LOCAL plan_cache_mode=force_generic_plan');
      for (const [name, sql] of Object.entries(ASSESSMENT_HISTORY_SQL)) {
        await client.query(`PREPARE assessment_history_${name}(uuid) AS ${sql}`);
      }
      for (const count of [2000, 20000]) {
        await client.query(
          `INSERT INTO access.admission
          (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
            authority_epoch,registered_at,expires_at,state)
          SELECT (lpad(to_hex(n),8,'0')||'-0000-4000-8000-000000000000')::uuid,
            $1,$2,$3,'assessment-history.unrelated',n::text,repeat('b',64),0,
            '2020-01-01'::timestamptz,'2020-01-02'::timestamptz,'registered'
          FROM generate_series(1,$4::int) AS n WHERE n % 400 <> 0 ON CONFLICT DO NOTHING`,
          [f.principal, f.subject, scope, count],
        );
        await client.query('ANALYZE access.admission');
        for (const [name, after] of [
          ['initial', '00000000-0000-0000-0000-000000000000'],
          ['continuation', ids[39]!],
        ] as const) {
          const explained = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)
            EXECUTE assessment_history_${name}('${after}'::uuid)`);
          const plan = explained.rows[0]['QUERY PLAN'][0].Plan as Plan;
          const all = nodes(plan);
          expect(
            all.some((node) =>
              ['Seq Scan', 'Sort', 'Bitmap Heap Scan'].includes(node['Node Type']),
            ),
          ).toBe(false);
          const seek = all.find(
            (node) => node['Index Name'] === 'admission_verification_assessment_history',
          );
          expect(seek).toBeDefined();
          expect(seek!['Index Cond']).toContain(name === 'initial' ? 'id >= $1' : 'id > $1');
          expect(seek!['Actual Rows']).toBe(33);
          expect(seek!['Rows Removed by Filter'] ?? 0).toBe(0);
          expect(plan['Actual Rows']).toBe(33);
        }
      }
    });
  } finally {
    await f.close();
  }
}, 30_000);
