import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, type SaveDraftCommand } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';

let cluster: Awaited<ReturnType<typeof startPostgresCluster>>;
let pool: Pool;
let core: ContentCore;
const queries: Array<{ client: PoolClient; text: string }> = [];

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  pool.on('connect', client => {
    client.query = new Proxy(client.query, {
      apply(target, receiver, args) {
        const input = args[0] as string | { text: string };
        queries.push({ client, text: typeof input === 'string' ? input : input.text });
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await migrateContent(pool);
  await pool.query('CREATE TABLE public.fence_probe (operation_id text PRIMARY KEY)');
  core = new ContentCore(pool);
}, 60_000);

afterAll(async () => {
  try { await pool?.end(); }
  finally { cluster?.remove(); }
});

function command(): SaveDraftCommand {
  const id = randomUUID();
  return { operationId: `save-${id}`, expectedHead: null,
    variant: { id: `urn:rezics:variant:${id}`, resourceId: `urn:rezics:work:${id}`,
      language: { kind: 'zxx' }, direction: 'none' },
    model: 'content-shape-v1', sourceRevision: null, provenance: {},
    serializedJson: '{"body":"fenced draft"}' };
}

function expectFirstTransactionAction(client: PoolClient) {
  expect(queries).toHaveLength(1);
  expect(queries[0]?.client).toBe(client);
  expect(queries[0]?.text).toStartWith('BEGIN;');
}

async function expectNoSave(command: SaveDraftCommand) {
  for (const table of ['receipt', 'revision', 'outbox']) {
    expect((await pool.query(`SELECT count(*)::int AS n FROM content.${table}
      WHERE operation_id = $1`, [command.operationId])).rows[0].n).toBe(0);
  }
}

test('draft fence runs once before owner queries and commits on the save transaction client', async () => {
  const draft = command();
  let calls = 0;
  let transactionClient: PoolClient | undefined;
  queries.length = 0;
  const saved = await core.saveDraft(draft, async client => {
    calls++;
    transactionClient = client;
    expectFirstTransactionAction(client);
    // SAVEPOINT fails outside a transaction; the marker proves the awaited work commits with it.
    await client.query('SAVEPOINT owner_fence');
    await client.query('SELECT pg_advisory_xact_lock(81723, 1)');
    await client.query('INSERT INTO public.fence_probe VALUES ($1)', [draft.operationId]);
  });
  expect(calls).toBe(1);
  expect(saved.outcome).toBe('succeeded');
  const commit = queries.findIndex(query => query.text === 'COMMIT');
  expect(commit).toBeGreaterThan(0);
  expect(queries.slice(0, commit + 1).every(query => query.client === transactionClient)).toBe(true);
  expect((await pool.query('SELECT operation_id FROM public.fence_probe WHERE operation_id = $1',
    [draft.operationId])).rows).toEqual([{ operation_id: draft.operationId }]);
  expect((await pool.query(`SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND classid = 81723 AND objid = 1`)).rows[0].n).toBe(0);
});

test('a throwing draft fence rolls back its owner work and creates no receipt or draft', async () => {
  const draft = command();
  const denied = new Error('owner lifecycle changed');
  let calls = 0;
  queries.length = 0;
  await expect(core.saveDraft(draft, async client => {
    calls++;
    expectFirstTransactionAction(client);
    await client.query('INSERT INTO public.fence_probe VALUES ($1)', [draft.operationId]);
    throw denied;
  })).rejects.toBe(denied);
  expect(calls).toBe(1);
  expect(queries.map(query => query.text)).toEqual([
    "BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'",
    'INSERT INTO public.fence_probe VALUES ($1)', 'ROLLBACK',
  ]);
  expect((await pool.query('SELECT * FROM public.fence_probe WHERE operation_id = $1',
    [draft.operationId])).rows).toHaveLength(0);
  expect((await pool.query('SELECT * FROM content.variant WHERE id = $1',
    [draft.variant.id])).rows).toHaveLength(0);
  await expectNoSave(draft);
});

test('receipt replay runs the draft fence once and a denied replay preserves the prior save', async () => {
  const draft = command();
  const saved = await core.saveDraft(draft);
  let calls = 0;
  queries.length = 0;
  const replay = await core.saveDraft(draft, async client => {
    calls++;
    expectFirstTransactionAction(client);
    await client.query('SAVEPOINT replay_fence');
  });
  expect(calls).toBe(1);
  expect(replay).toEqual({ ...saved, replayed: true });
  queries.length = 0;
  await expect(core.saveDraft(draft, async client => {
    calls++;
    expectFirstTransactionAction(client);
    throw new Error('owner now denies replay');
  })).rejects.toThrow('owner now denies replay');
  expect(calls).toBe(2);
  expect(queries.map(query => query.text)).toEqual([
    "BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'", 'ROLLBACK',
  ]);
  expect(await core.saveDraft(draft)).toEqual(replay);
  expect((await pool.query('SELECT count(*)::int AS n FROM content.revision WHERE operation_id = $1',
    [draft.operationId])).rows[0].n).toBe(1);
});

test('stale-head saves also run the fence before retaining their outcome', async () => {
  const initial = command();
  const saved = await core.saveDraft(initial);
  const stale = { ...initial, operationId: `stale-${randomUUID()}` };
  let calls = 0;
  queries.length = 0;
  const result = await core.saveDraft(stale, async client => {
    calls++;
    expectFirstTransactionAction(client);
    expect((await client.query('SELECT draft_head FROM content.variant WHERE id = $1',
      [stale.variant.id])).rows[0].draft_head).toBe(saved.revisionId);
  });
  expect(calls).toBe(1);
  expect(result.outcome).toBe('stale_head');
  expect((await pool.query('SELECT outcome FROM content.receipt WHERE operation_id = $1',
    [stale.operationId])).rows[0].outcome).toBe('stale_head');
  expect((await core.saveDraft(stale)).replayed).toBe(true);
});
