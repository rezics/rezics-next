import { expect, test } from 'bun:test';
import { processBoardWatchNoticePage, BOARD_WATCH_RECIPIENT_BUDGET } from '../../src/content/board-watch-notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { eraseAccountNoticesPage } from '../../src/content/notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

test('native watch commands, both management selections and durable sparse opening pages keep their physical bounds at three scales', async () => {
  // Each native request/page owns a bounded telemetry capture. Combining the whole journey in one
  // capture exhausts the harness's fixed native-plan budget before measuring its later operations.
  for (const step of [
    'read',
    'set-retry',
    'board-list',
    'thread-list',
    'board-remove',
    'thread-remove',
    'opening',
    'sparse-opening',
    'erase',
  ]) {
    const f = await replyNoticeFixture();
    try {
      const owner = f.accounts.actor;
      const ownerRoute = routeOf(owner)!;
      const erasing = newId(0x7655);
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
      let commandKey = '';
      let hidden: { id: string; revision: number };
      async function prepare() {
        commandKey = crypto.randomUUID();
        if (step.endsWith('-remove')) {
          const kind = step.split('-')[0];
          hidden = (await f.call(owner, 'GET', `/v1/accounts/${owner}/watches?kind=${kind}&limit=2`)).value.items[1];
        }
        if (step === 'opening' || step === 'sparse-opening') {
          const thread = await f.thread();
          source = (await f.envelope(thread.firstPost.id)).events.find(Boolean)!;
          if (step === 'sparse-opening')
            expect(await processBoardWatchNoticePage(f.db.pool, access, source)).toEqual({
              done: false,
              scanned: BOARD_WATCH_RECIPIENT_BUDGET,
            });
        }
      }
      async function operation() {
        let recipientCandidates = 0;
        let erasedSubscriptions = 0;
        if (step === 'set-retry')
          for (let retry = 0; retry < 2; retry++)
            expect(
              (await f.call(owner, 'PUT', boardPath, { watching: true, expectedRevision: 1 }, commandKey)).status,
            ).toBe(200);
        if (step === 'read')
          expect((await f.call(owner, 'GET', boardPath)).value).toEqual({ watching: true, revision: 1 });
        if (step.endsWith('-list')) {
          const kind = step.split('-')[0];
          const result = await f.call(owner, 'GET', `/v1/accounts/${owner}/watches?kind=${kind}&limit=2`);
          expect(result.status).toBe(200);
          expect(result.value.items.map((item: { state: string }) => item.state)).toEqual(['available', 'unavailable']);
          expect(result.value.next).toBeString();
        }
        if (step.endsWith('-remove')) {
          const kind = step.split('-')[0];
          for (let retry = 0; retry < 2; retry++)
            expect(
              (
                await f.call(
                  owner,
                  'DELETE',
                  `/v1/accounts/${owner}/watches/${hidden.id}?kind=${kind}`,
                  { expectedRevision: hidden.revision },
                  commandKey,
                )
              ).status,
            ).toBe(200);
        }
        if (step === 'opening' || step === 'sparse-opening') {
          const page = await processBoardWatchNoticePage(f.db.pool, access, source!);
          expect(page).toEqual({ done: false, scanned: BOARD_WATCH_RECIPIENT_BUDGET });
          recipientCandidates = page.scanned;
        }
        if (step === 'erase') {
          const erased = await eraseAccountNoticesPage(
            { pool: f.db.pool },
            erasing,
            JSON.stringify({
              version: 1,
              accountId: erasing,
              stage: 'board-watches',
              noticeAfter: null,
              finalizationAfter: null,
            }),
          );
          expect(erased).toMatchObject({ found: 50, pending: 1, next: expect.any(String) });
          erasedSubscriptions = erased.found;
        }
        return {
          recipientCandidates,
          residentRecipients: recipientCandidates,
          erasedSubscriptions,
        };
      }
      const report = await checkGrowth(f.db, {
        name: `native watch management and opening delivery: ${step}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        repetitions: 1,
        warmups: 1,
        counted: {
          read: (value) =>
            value as { recipientCandidates: number; residentRecipients: number; erasedSubscriptions: number },
          limits: {
            recipientCandidates: BOARD_WATCH_RECIPIENT_BUDGET,
            residentRecipients: BOARD_WATCH_RECIPIENT_BUDGET,
            erasedSubscriptions: 50,
          },
          bounds: { recipientCandidates: 'constant', residentRecipients: 'constant', erasedSubscriptions: 'constant' },
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
          await db.admin.query(
            `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
          SELECT $1,$2,board,watch,false,2,clock_timestamp() FROM unnest($3::uuid[],$4::uuid[]) n(board,watch)`,
            [routeOf(erasing), erasing, resources, Array.from({ length: count }, () => newId(routeOf(erasing)!))],
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
      if (step === 'opening' || step === 'sparse-opening') {
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
      }
    } finally {
      await f.close();
    }
  }
}, 1_800_000);
