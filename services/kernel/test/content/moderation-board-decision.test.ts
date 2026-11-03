import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { encodeReceiptKey } from '../../src/command/receipt-key.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { checkGrowth, assertGrowthAccessPaths } from '../support/growth.ts';
import { createGrowthAppealBoundariesFixture } from './support/growth-appeal-boundaries-fixture.ts';

let f: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;
beforeAll(async () => {
  f = await createGrowthAppealBoundariesFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});
const reason = { reason: 'Retained board policy statement' };
const authority = ['moderation:takedown'];
const path = (board: string) => `/v1/boards/${board}:takeDown`;
const history = (board: string, selection = 'all') =>
  `/v1/boards/${board}/moderation-history?limit=1&targetKind=${selection}`;
async function act(board: string, key: string = randomUUID()) {
  const result = await f.call('POST', path(board), { bearer: f.people.decider.bearer, key, body: reason });
  expect(result.response.status).toBe(200);
  return { ...result, key };
}
async function read(url: string, bearer = f.people.reviewer.bearer) {
  return f.call('GET', url, { bearer });
}
async function source(target: string, key: string, kind: 'board' | 'thread' = 'board', board = target) {
  const { rows } = await f.db.admin.query(
    `SELECT d.*, r.partition_no, r.epoch, r.position, o.id AS event_id, o.type, o.data
     FROM content.moderation_decision d
     JOIN core.receipt r ON r.transaction_id=d.recorded_transaction_id
     JOIN core.outbox o ON o.partition_no=r.partition_no AND o.position=r.position
       AND o.type='com.rezics.content.moderation.takedown.v1'
     WHERE d.route=$1 AND d.target_id=$2 AND r.idempotency_key=$3`,
    [
      routeOf(target),
      target,
      encodeReceiptKey(
        testReceiptKeys(),
        'content.moderation:takedown',
        { kind: 'account', id: f.people.decider.accountId },
        key,
      ),
    ],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.board_id).toBe(board);
  expect(row.data).toMatchObject({ targetKind: kind, targetId: target, securityRevision: row.security_revision });
  const event: CloudEvent = {
    specversion: '1.0',
    id: row.event_id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    time: new Date(row.decided_at).toISOString(),
    datacontenttype: 'application/json',
    sequence: String(row.position).padStart(19, '0'),
    data: row.data,
  };
  return { row, event, exact: `/v1/moderation-decisions/${row.decision_id}` };
}

test('native board action, authorized replay, durable projection and private inspection share one retained decision', async () => {
  const board = f.base.mainBoardId;
  for (const who of [f.people.decider, f.people.reviewer]) await f.grant(board, who.accountId, authority);
  const first = await act(board);
  expect((await act(board, first.key)).body).toEqual(first.body);
  const { row, event, exact } = await source(board, first.key);
  await f.completeRegisteredCommand(f.people.decider.accountId, first.key);
  await f.completeRegisteredCommand(f.people.decider.accountId, first.key);
  await f.moderationEffect.run(event); // A duplicate delivery also converges at the native projector.
  const detail = await read(exact);
  expect(detail.response.status).toBe(200);
  expect(detail.response.headers.get('cache-control')).toBe('private, no-store');
  expect(detail.body).toMatchObject({
    targetKind: 'board',
    targetId: board,
    statement: reason.reason,
    appealDeadline: null,
    appeal: null,
  });
  expect(detail.body).not.toHaveProperty('deciderAccountId');
  const page = await read(history(board, 'board'));
  expect(page.response.status).toBe(200);
  expect(page.response.headers.get('cache-control')).toBe('private, no-store');
  expect(page.body).toEqual({ entries: [detail.body], nextCursor: null });
  expect((await f.call('GET', exact)).response.status).toBe(404);
  expect((await read(exact, f.people.reporter.bearer)).response.status).toBe(404);
  expect((await read(`/v1/boards/${board}`, f.people.reporter.bearer)).response.status).toBe(404);
  expect(
    (await f.db.admin.query('SELECT 1 FROM content.notice WHERE decision_id=$1', [row.decision_id])).rowCount,
  ).toBe(0);
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM content.moderation_decision_board WHERE route=$1 AND board_id=$2', [
        routeOf(board),
        board,
      ])
    ).rowCount,
  ).toBe(1);
  // Simulate the retained native erasure disposition; delayed expiry cleanup must not disclose the old bytes.
  await f.db.admin.query(
    'UPDATE content.moderation_decision SET decider_account_id=NULL WHERE route=$1 AND decision_id=$2',
    [routeOf(board), row.decision_id],
  );
  expect((await read(exact)).body?.statement).toBe(reason.reason);
  await f.db.admin.query(
    "UPDATE content.moderation_decision SET decided_at=now()-interval '184 days' WHERE route=$1 AND decision_id=$2",
    [routeOf(board), row.decision_id],
  );
  expect((await read(exact)).body?.statement).toBe('');
  expect((await read(history(board))).body?.entries[0].statement).toBe('');
  await f.revokeTargetModeration(board, f.people.reviewer.accountId);
  expect((await read(exact)).response.status).toBe(404);
  expect((await read(history(board))).response.status).toBe(404);
  await f.revokeTargetModeration(board, f.people.decider.accountId);
  expect(
    (await f.call('POST', path(board), { bearer: f.people.decider.bearer, key: first.key, body: reason })).response
      .status,
  ).toBe(403);
}, 180_000);

test('native board journey keeps physical work fixed across retained history at 256/1024/4096', async () => {
  const board = await f.createBoard('History growth');
  for (const who of [f.people.decider, f.people.reviewer]) await f.grant(board, who.accountId, authority);
  const denied = await f.createThread(board, 'Withheld history target');
  await f.grant(denied.threadId, f.people.decider.accountId, authority);
  const first = await act(board);
  await f.completeRegisteredCommand(f.people.decider.accountId, first.key);
  const { event, exact } = await source(board, first.key);
  // Real thread/post targets share the board, but grant no moderation authority to this reviewer.
  const samples = await checkGrowth(f.db, {
    name: 'native board decision and sparse scoped history',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      for (let index = previous; index < scale; index++) {
        // Dataset construction can outlive native credentials; renew through Auth outside measurement.
        if (index % 256 === 0) {
          for (const person of [f.people.decider, f.people.reviewer]) {
            person.bearer = (
              await f.base.system.auth.issue({
                accountId: person.accountId,
                clientId: f.base.system.auth.ordinaryClient.id,
                scopes: f.base.system.auth.ordinaryScopes,
              })
            ).bearer;
          }
        }
        const key = `retained-thread-${index}`;
        const action = await f.call('POST', `/v1/threads/${denied.threadId}:takeDown`, {
          bearer: f.people.decider.bearer,
          key,
          body: { reason: 'Retained source' },
        });
        expect(action.response.status, action.text).toBe(200);
        const { event } = await source(denied.threadId, key, 'thread', board);
        await f.moderationEffect.run(event);
      }
    },
    async operation(_db, scale, repetition) {
      const action = await act(board, `board-history-${scale}-${repetition}`);
      expect((await act(board, action.key)).body).toEqual(action.body);
      await f.moderationEffect.run(event);
      expect((await read(exact)).response.status).toBe(200);
      const sparse = await read(history(board));
      expect(sparse.response.status).toBe(200);
      expect(sparse.body?.entries).toEqual([]);
      expect(typeof sparse.body?.nextCursor).toBe('string');
      const filtered = await read(history(board, 'board'));
      expect(filtered.response.status).toBe(200);
      expect(filtered.body?.entries).toHaveLength(1);
      expect(filtered.body?.nextCursor).toBeNull();
      const cursor = encodeURIComponent(sparse.body!.nextCursor);
      expect((await read(`${history(board)}&cursor=${cursor}`)).body?.entries).toEqual([]);
      expect((await read(`${history(board, 'board')}&cursor=${cursor}`)).response.status).toBe(400);
    },
  });
  assertGrowthAccessPaths('native retained history', samples.samples, [
    'content.moderation_decision',
    'content.moderation_decision_board',
  ]);
}, 1_800_000);
