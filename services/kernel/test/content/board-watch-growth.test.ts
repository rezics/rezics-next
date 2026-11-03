import { expect, test } from 'bun:test';
import { processBoardWatchNoticePage, BOARD_WATCH_RECIPIENT_BUDGET } from '../../src/content/board-watch-notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('native watch commands, both management selections and durable sparse opening pages keep their physical bounds at three scales', async () => {
  const f = await replyNoticeFixture();
  try {
    const owner = f.accounts.actor;
    const ownerRoute = routeOf(owner)!;
    const boardPath = `/v1/boards/${f.boardId}/watch`;
    for (const account of [owner, f.accounts.principal, f.accounts.recipient])
      expect((await f.call(account, 'PUT', boardPath, { watching: true, expectedRevision: 0 })).status).toBe(200);
    expect(
      (
        await f.call(f.accounts.principal, 'PATCH', `/v1/accounts/${f.accounts.principal}/preferences`, {
          expectedVersion: 0,
          notifications: { board_activity: false },
        })
      ).status,
    ).toBe(200);
    const watched = await f.thread();
    expect((await f.call(owner, 'PUT', `/v1/threads/${watched.id}/watch`)).status).toBe(204);
    const access = createContentWorkAccess(() => new Date(), f.db.pool);
    let source: CloudEvent;
    async function prepare() {
      const thread = await f.thread();
      source = (await f.envelope(thread.firstPost.id)).events.find(Boolean)!;
    }
    async function operation() {
      const key = crypto.randomUUID();
      const input = { watching: true, expectedRevision: 1 };
      for (let retry = 0; retry < 2; retry++)
        expect((await f.call(owner, 'PUT', boardPath, input, key)).status).toBe(200);
      expect((await f.call(owner, 'GET', boardPath)).value).toEqual({ watching: true, revision: 1 });
      for (const kind of ['board', 'thread']) {
        const result = await f.call(owner, 'GET', `/v1/accounts/${owner}/watches?kind=${kind}&limit=2`);
        expect(result.status).toBe(200);
        expect(result.value.items.map((item: { state: string }) => item.state)).toEqual(['available', 'unavailable']);
        expect(result.value.next).toBeString();
      }
      const first = await processBoardWatchNoticePage(f.db.pool, access, source!);
      const second = await processBoardWatchNoticePage(f.db.pool, access, source!);
      expect(first).toEqual({ done: false, scanned: BOARD_WATCH_RECIPIENT_BUDGET });
      expect(second).toEqual({ done: false, scanned: BOARD_WATCH_RECIPIENT_BUDGET });
      return {
        recipientCandidates: first.scanned + second.scanned,
        residentRecipients: Math.max(first.scanned, second.scanned),
      };
    }
    const report = await checkGrowth(f.db, {
      name: 'native watch management and opening delivery',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      repetitions: 1,
      warmups: 1,
      counted: {
        read: (value) => value as { recipientCandidates: number; residentRecipients: number },
        limits: {
          recipientCandidates: 2 * BOARD_WATCH_RECIPIENT_BUDGET,
          residentRecipients: BOARD_WATCH_RECIPIENT_BUDGET,
        },
        bounds: { recipientCandidates: 'constant', residentRecipients: 'constant' },
      },
      async grow(db, scale, previous) {
        const count = scale - previous;
        const ownIds = Array.from({ length: count }, () => newId(ownerRoute));
        const resources = Array.from({ length: count }, () => newId(0x7865));
        const recipients = Array.from({ length: count }, () => newId(0x7654));
        const recipientWatches = Array.from({ length: count }, () => newId(0x7654));
        await db.admin.query(
          `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
          SELECT $1,$2,board,watch,true,1,clock_timestamp() FROM unnest($3::uuid[],$4::uuid[]) n(board,watch)`,
          [ownerRoute, owner, resources, ownIds],
        );
        await db.admin.query(
          `INSERT INTO content.thread_watch(route,watcher_account_id,thread_id,watch_id,created_at)
          SELECT $1,$2,thread,watch,clock_timestamp() FROM unnest($3::uuid[],$4::uuid[]) n(thread,watch)`,
          [ownerRoute, owner, resources, ownIds],
        );
        // Missing recipients exercise both native current authority and terminal recipient finalization.
        await db.admin.query(
          `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
          SELECT $1,recipient,$2,watch,true,1,clock_timestamp() FROM unnest($3::uuid[],$4::uuid[]) n(recipient,watch)`,
          [0x7654, f.boardId, recipients, recipientWatches],
        );
      },
      prepare,
      async warmup() {
        await prepare();
        return operation();
      },
      operation,
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    assertGrowthAccessPaths(report.name, report.samples, ['content.board_watch', 'content.thread_watch']);
    expect(report.samples.every((sample) => sample.cost.controlStatements > 0)).toBe(true);
    expect(
      (await f.notices((source!.data as { itemId: string }).itemId)).filter(
        (notice) => notice.kind === 'board_activity',
      ),
    ).toMatchObject([{ recipient_id: owner }]);
    const progress = (
      await f.db.admin.query(
        `SELECT cursor_created_at IS NOT NULL AS advanced,done
      FROM content.board_watch_notice_work WHERE post_id=$1`,
        [(source!.data as { itemId: string }).itemId],
      )
    ).rows;
    expect(progress).toEqual([{ advanced: true, done: false }]);
  } finally {
    await f.close();
  }
}, 600_000);
