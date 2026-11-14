import { afterAll, beforeAll, expect, test } from 'bun:test';
import { removeWatch } from '../../src/content/watch-management.ts';
import type { CommandTransaction } from '../../src/command/command.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { relayEffects } from '../../src/events/effects.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  HistoryRegistry,
  COMMAND_HISTORY_KINDS,
  decodeLocator,
  type HistoryBarrier,
} from '../../src/history/contract/index.ts';
import { minimizeHistoryOutbox } from '../../src/history/adapters/outbox.ts';
import { minimizeHistoryReceipt, RECEIPT_OWNER_DISPOSITIONS } from '../../src/history/adapters/receipt.ts';
import { registerWatchHistoryConsumers } from '../../src/history/adapters/watch-consumers.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { custodyFixture, type CustodyFixture } from './command-custody-fixture.ts';

let f: CustodyFixture;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
beforeAll(async () => {
  f = await custodyFixture();
  client = await createWorkClient(f.db.url);
  const module = KERNEL_WORK_MODULES.find(({ name }) => name === 'shared_history');
  expect(module).toBeDefined();
  work = await composeWork([module!], { pool: f.db.pool, client, databaseUrl: f.db.url });
}, 180_000);
afterAll(async () => {
  try {
    await work?.shutdown();
  } finally {
    try {
      await client?.close();
    } finally {
      await f?.close();
    }
  }
});

async function watchRemoval(person: Awaited<ReturnType<CustodyFixture['auth']['person']>>) {
  const route = routeOf(person.accountId)!;
  const boardId = newId(route);
  const watchId = newId(route);
  const key = crypto.randomUUID();
  const deps = { pool: f.db.pool, access: f.auth.access, tokens: {} as never, clock: () => new Date() };
  const ctx = await f.context(person);
  const input = { kind: 'board' as const, watchId, expectedRevision: 1 };
  await f.db.admin.query(
    `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
     VALUES($1,$2,$3,$4,true,1,clock_timestamp())`,
    [route, person.accountId, boardId, watchId],
  );
  const request = { idempotencyKey: key, deadline: ctx.deadline, requestId: crypto.randomUUID() };
  const result = await removeWatch(deps, ctx.actor, person.accountId, input, request);
  const replay = await removeWatch(deps, ctx.actor, person.accountId, input, request);
  expect(replay).toMatchObject({ value: { removed: true }, replayed: true });
  return { route, result, watchId };
}

async function transaction<T>(body: (tx: CommandTransaction) => Promise<T>): Promise<T> {
  const db = await f.db.pool.connect();
  try {
    await db.query('BEGIN');
    const result = await body(db as unknown as CommandTransaction);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

test('watch copies minimize only after the real account barrier and effects settlement, preserving applied replay', async () => {
  const owner = await f.auth.person('history-watch-erased');
  const other = await f.auth.person('history-watch-other');
  const command = await watchRemoval(owner);
  await watchRemoval(other);
  const partition = partitionOf(command.route);
  const receiptBefore = (
    await f.db.admin.query(
      `SELECT response,payload_state,epoch,position::text,transaction_id,request_digest,idempotency_key
       FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind='content.watch.remove'`,
      [partition, owner.accountId],
    )
  ).rows[0]!;
  const sourceLocators = await f.db.admin.query<{
    artifact_type: 'command-receipt/v1' | 'outbox-event/v1';
    locator: Buffer;
  }>(
    `SELECT artifact_type,locator FROM core.history_locator
     WHERE partition_no=$1 AND account_id=$2 AND artifact_type IN ('command-receipt/v1','outbox-event/v1')`,
    [partition, owner.accountId],
  );
  const receipt = sourceLocators.rows.find(
    (row) =>
      row.artifact_type === 'command-receipt/v1' &&
      decodeLocator('command-receipt/v1', row.locator).artifactType === 'command-receipt/v1' &&
      decodeLocator('command-receipt/v1', row.locator).commandKindId === COMMAND_HISTORY_KINDS['content.watch.remove'],
  )!;
  const event = sourceLocators.rows.find((row) => {
    if (row.artifact_type !== 'outbox-event/v1') return false;
    const locator = decodeLocator('outbox-event/v1', row.locator);
    return locator.artifactType === 'outbox-event/v1' && locator.position === command.result.position;
  })!;

  const registry = new HistoryRegistry();
  registerWatchHistoryConsumers({ history: registry });
  expect([
    registry.owner('command-receipt/v1', 'content.board.watch')?.name,
    registry.owner('command-receipt/v1', 'content.watch.remove')?.name,
    registry.owner('outbox-event/v1', 'com.rezics.content.board.watch.changed.v1')?.name,
    registry.owner('outbox-event/v1', 'com.rezics.content.watch.removed.v1')?.name,
  ]).toEqual([
    'content.board.watch',
    'content.watch.remove',
    'com.rezics.content.board.watch.changed.v1',
    'com.rezics.content.watch.removed.v1',
  ]);
  expect(RECEIPT_OWNER_DISPOSITIONS['content.board.watch'].commandKindId).toBe(
    COMMAND_HISTORY_KINDS['content.board.watch'],
  );
  expect(RECEIPT_OWNER_DISPOSITIONS['content.watch.remove'].commandKindId).toBe(
    COMMAND_HISTORY_KINDS['content.watch.remove'],
  );
  expect(registry.owner('outbox-event/v1', 'com.rezics.content.post.published.v1')).toBeUndefined();
  await deletePersona({ pool: f.db.pool, auth: f.auth }, owner);
  const erasure = (
    await f.db.admin.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [command.route, owner.accountId],
    )
  ).rows[0]!;
  const barrier: HistoryBarrier = { accountId: owner.accountId, accountRoute: command.route, ...erasure };
  const job = { partition_no: partition, account_route: command.route, account_id: owner.accountId };

  expect(await transaction((tx) => minimizeHistoryOutbox(tx, job, event.locator, registry, barrier))).toBe(
    'outbox-effects-not-dispatched',
  );
  expect(await transaction((tx) => minimizeHistoryReceipt(tx, job, receipt.locator, registry, barrier))).toBeNull();
  let delivered: Awaited<ReturnType<typeof relayEffects>>;
  do delivered = await relayEffects(f.db.pool, work.effects, partition);
  while (delivered.status === 'read' && delivered.envelopes > 0);
  expect(delivered.status).toBe('read');
  expect(
    (await f.db.admin.query('SELECT 1 FROM core.preference_history_job WHERE account_id=$1', [owner.accountId])).rows,
  ).toHaveLength(1);
  expect(await transaction((tx) => minimizeHistoryOutbox(tx, job, event.locator, registry, barrier))).toBeNull();

  const receiptAfter = (
    await f.db.admin.query(
      `SELECT response,payload_state,epoch,position::text,transaction_id,request_digest,idempotency_key
       FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind='content.watch.remove'`,
      [partition, owner.accountId],
    )
  ).rows[0]!;
  expect(receiptAfter).toMatchObject({
    response: null,
    payload_state: 'minimized',
    epoch: receiptBefore.epoch,
    position: receiptBefore.position,
    transaction_id: receiptBefore.transaction_id,
    request_digest: receiptBefore.request_digest,
    idempotency_key: receiptBefore.idempotency_key,
  });
  expect(
    (
      await f.db.admin.query(
        'SELECT payload_state,data,subject FROM core.outbox WHERE partition_no=$1 AND position=$2',
        [partition, command.result.position.toString()],
      )
    ).rows,
  ).toEqual([{ payload_state: 'minimized', data: {}, subject: null }]);
  expect(
    (
      await f.db.admin.query('SELECT watching,revision FROM content.board_watch WHERE route=$1 AND watch_id=$2', [
        command.route,
        command.watchId,
      ])
    ).rows,
  ).toEqual([{ watching: false, revision: 2 }]);
  expect(
    (
      await f.db.admin.query(
        `SELECT h.state,r.payload_state FROM core.history_locator h JOIN core.receipt r
       ON r.partition_no=h.partition_no AND r.principal_id=h.account_id AND r.command_kind='content.watch.remove'
     WHERE h.account_id=$1 AND h.artifact_type='command-receipt/v1'`,
        [other.accountId],
      )
    ).rows,
  ).toEqual([{ state: 'pending', payload_state: 'present' }]);
}, 180_000);
