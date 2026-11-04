import { expect, test } from 'bun:test';
import { processBoardWatchNoticePage, BOARD_WATCH_RECIPIENT_BUDGET } from '../../src/content/board-watch-notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { eraseAccountNoticesPage } from '../../src/content/notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';
import {
  captureWatchAccess,
  interceptThreadSnapshot,
  watchPageByteEvidence,
} from './support/watch-management-fixture.ts';

test('watch management and delivery stay bounded across unrelated, selected, source and authority histories', async () => {
  // Each native request/page owns a bounded telemetry capture. Combining the whole journey in one
  // capture exhausts the harness's fixed native-plan budget before measuring its later operations.
  for (const step of [
    'read',
    'set-retry',
    'board-list',
    'thread-list',
    'board-remove',
    'thread-remove',
    'cold-thread-retry',
    'opening',
    'sparse-opening',
    'erase',
  ]) {
    const f = await replyNoticeFixture();
    const accessCounts = captureWatchAccess(f.accounts.access);
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
      const missingBoards = [newId(0x7865), newId(0x7865)];
      const missingBoardWatchIds = missingBoards.map(() => newId(ownerRoute));
      await f.db.admin.query(
        `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
         SELECT $1,$2,board,watch,true,1,clock_timestamp()+ordinal*interval '1 day'
         FROM unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY n(board,watch,ordinal)`,
        [ownerRoute, owner, missingBoards, missingBoardWatchIds],
      );
      const missingThreads = [newId(0x7865), newId(0x7865)];
      const missingThreadWatchIds = missingThreads.map(() => newId(ownerRoute));
      await f.db.admin.query(
        `INSERT INTO content.thread_watch(route,watcher_account_id,thread_id,watch_id,created_at)
         SELECT $1,$2,thread,watch,clock_timestamp()+ordinal*interval '1 day'
         FROM unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY n(thread,watch,ordinal)`,
        [ownerRoute, owner, missingThreads, missingThreadWatchIds],
      );
      const retryReader = f.accounts.principal;
      let retryTarget: string | undefined;
      let retryTargetPostId: string | undefined;
      let unrelatedSourceThreadId: string | undefined;
      let unrelatedSourcePostId: string | undefined;
      let retryCursor = '';
      if (step === 'cold-thread-retry') {
        const first = await f.thread();
        const later = await f.thread();
        retryTarget = later.id;
        retryTargetPostId = later.firstPost.id;
        for (const thread of [first, later])
          expect((await f.call(retryReader, 'PUT', `/v1/threads/${thread.id}/watch`)).status).toBe(204);
        await f.db.admin.query(
          `UPDATE content.thread_watch SET created_at=CASE thread_id WHEN $1 THEN '2026-11-01T00:00:00Z'::timestamptz
             ELSE '2026-11-02T00:00:00Z'::timestamptz END
           WHERE watcher_account_id=$2 AND thread_id=ANY($3::uuid[])`,
          [first.id, retryReader, [first.id, later.id]],
        );
      }
      if (step === 'thread-list') {
        const unrelatedSource = await f.thread();
        unrelatedSourceThreadId = unrelatedSource.id;
        unrelatedSourcePostId = unrelatedSource.firstPost.id;
      }
      const access = createContentWorkAccess(() => new Date(), f.db.pool);
      let source: CloudEvent;
      let commandKey = '';
      let hidden: { id: string; revision: number };
      async function prepare() {
        commandKey = crypto.randomUUID();
        if (step.endsWith('-remove')) {
          const watchId = step === 'board-remove' ? missingBoardWatchIds[0]! : missingThreadWatchIds[0]!;
          hidden = { id: watchId, revision: 1 };
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
        if (step === 'cold-thread-retry') {
          const first = await f.call(retryReader, 'GET', `/v1/accounts/${retryReader}/watches?kind=thread&limit=1`);
          expect(first.status).toBe(200);
          expect(first.value.next).toBeString();
          retryCursor = first.value.next as string;
        }
      }
      async function operation() {
        accessCounts.reset();
        let pageBytes = { materializedDtoBytes: 0, retainedItemBytes: 0, serializedUtf8Bytes: 0 };
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
          pageBytes = watchPageByteEvidence(result.value);
          expect(accessCounts.snapshot().preparations).toBeGreaterThan(0);
          expect(accessCounts.snapshot().evaluations).toBeGreaterThan(0);
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
        if (step === 'cold-thread-retry') {
          const retryPath = `/v1/accounts/${retryReader}/watches?kind=thread&limit=1&cursor=${encodeURIComponent(retryCursor)}`;
          const gate = interceptThreadSnapshot(f.db.pool, retryTarget!, 'fail');
          try {
            const pending = f.call(retryReader, 'GET', retryPath);
            await gate.reached;
            expect((await pending).status).toBe(503);
          } finally {
            gate.restore();
          }
          const retry = await f.call(retryReader, 'GET', retryPath);
          expect(retry.status).toBe(200);
          expect(retry.value.items.map((item: { state: string }) => item.state)).toEqual(['available']);
          expect(retry.value.next).toBeNull();
          pageBytes = watchPageByteEvidence(retry.value);
          expect(accessCounts.snapshot().preparations).toBeGreaterThan(0);
          expect(accessCounts.snapshot().evaluations).toBeGreaterThan(0);
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
          accessPreparations: accessCounts.snapshot().preparations,
          accessEvaluations: accessCounts.snapshot().evaluations,
          ...pageBytes,
          registeredRunnerPhases: 0,
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
            value as {
              recipientCandidates: number;
              residentRecipients: number;
              erasedSubscriptions: number;
              accessPreparations: number;
              accessEvaluations: number;
              materializedDtoBytes: number;
              retainedItemBytes: number;
              serializedUtf8Bytes: number;
              registeredRunnerPhases: number;
            },
          limits: {
            recipientCandidates: BOARD_WATCH_RECIPIENT_BUDGET,
            residentRecipients: BOARD_WATCH_RECIPIENT_BUDGET,
            erasedSubscriptions: 50,
            accessPreparations: 4096,
            accessEvaluations: 4096,
            materializedDtoBytes: 65_536,
            retainedItemBytes: 65_536,
            serializedUtf8Bytes: 65_536,
            registeredRunnerPhases: 0,
          },
          bounds: {
            recipientCandidates: 'constant',
            residentRecipients: 'constant',
            erasedSubscriptions: 'constant',
            accessPreparations: 'constant',
            accessEvaluations: 'constant',
            materializedDtoBytes: 'constant',
            retainedItemBytes: 'constant',
            serializedUtf8Bytes: 'constant',
            registeredRunnerPhases: 'constant',
          },
        },
        async grow(db, scale, previous) {
          const count = scale - previous;
          const resources = Array.from({ length: count }, () => newId(0x7865));
          const oldCreatedAt = "'2000-01-01T00:00:00Z'::timestamptz";
          const identityKind =
            step === 'board-list' || step === 'board-remove'
              ? 'board'
              : step === 'thread-list' || step === 'thread-remove' || step === 'cold-thread-retry'
                ? 'thread'
                : null;
          if (identityKind !== null) {
            const selectedAccount = step === 'cold-thread-retry' ? retryReader : owner;
            const unrelatedAccount = step === 'cold-thread-retry' ? owner : f.accounts.recipient;
            const selectedRoute = routeOf(selectedAccount)!;
            const unrelatedRoute = routeOf(unrelatedAccount)!;
            const selectedWatchIds = Array.from({ length: count }, () => newId(selectedRoute));
            const unrelatedWatchIds = Array.from({ length: count }, () => newId(unrelatedRoute));
            if (identityKind === 'board') {
              const insertBoardHistory = `
                INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
                SELECT $1,$2,board,watch,true,1,${oldCreatedAt}
                FROM unnest($3::uuid[],$4::uuid[]) n(board,watch)`;
              await db.admin.query(insertBoardHistory, [selectedRoute, selectedAccount, resources, selectedWatchIds]);
              await db.admin.query(insertBoardHistory, [unrelatedRoute, unrelatedAccount, resources, unrelatedWatchIds]);
            } else {
              const insertThreadHistory = `
                INSERT INTO content.thread_watch(route,watcher_account_id,thread_id,watch_id,created_at)
                SELECT $1,$2,thread,watch,${oldCreatedAt}
                FROM unnest($3::uuid[],$4::uuid[]) n(thread,watch)`;
              await db.admin.query(insertThreadHistory, [selectedRoute, selectedAccount, resources, selectedWatchIds]);
              await db.admin.query(insertThreadHistory, [unrelatedRoute, unrelatedAccount, resources, unrelatedWatchIds]);
            }
          }
          if (step === 'opening' || step === 'sparse-opening') {
            const recipients = Array.from({ length: count }, () => newId(0x7654));
            const recipientWatches = Array.from({ length: count }, () => newId(0x7654));
            await db.admin.query(
              `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
               SELECT $1,recipient,$2,watch,true,1,clock_timestamp()+interval '100 years'
               FROM unnest($3::uuid[],$4::uuid[]) n(recipient,watch)`,
              [0x7654, f.boardId, recipients, recipientWatches],
            );
          }
          if (step === 'erase')
            await db.admin.query(
              `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
               SELECT $1,$2,board,watch,false,2,${oldCreatedAt}
               FROM unnest($3::uuid[],$4::uuid[]) n(board,watch)`,
              [
                routeOf(erasing),
                erasing,
                resources,
                Array.from({ length: count }, () => newId(routeOf(erasing)!)),
              ],
            );
          const revisionPosts =
            step === 'thread-list'
              ? [watched.firstPost.id, unrelatedSourcePostId!]
              : step === 'cold-thread-retry'
                ? [retryTargetPostId!]
                : [];
          for (const postId of revisionPosts) {
            const revisionRoute = routeOf(postId)!;
            const historicalRevisions = Array.from({ length: count }, () => newId(revisionRoute));
            const historicalTransactions = historicalRevisions.map(() => newId(revisionRoute));
            await db.admin.query(
              `INSERT INTO content.revision(
                 route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,
                 availability,recorded_transaction_id,recorded_at,media_ids,vote_citation)
               SELECT source.route,source.thread_id,source.post_id,history.revision_id,source.body,source.body_sha256,
                      source.search_text,source.licence,source.subject_ids,source.board_id,source.availability,
                      history.transaction_id,source.recorded_at-history.ordinal*interval '1 second',
                      source.media_ids,source.vote_citation
               FROM (SELECT * FROM content.revision WHERE post_id=$1 ORDER BY recorded_at DESC LIMIT 1) source
               CROSS JOIN unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY history(revision_id,transaction_id,ordinal)`,
              [postId, historicalRevisions, historicalTransactions],
            );
          }
          const authority =
            step === 'board-list'
              ? [{ resourceId: f.boardId, route: routeOf(f.boardId)!, action: 'board:read', subject: owner },
                  { resourceId: f.boardId, route: routeOf(f.boardId)!, action: 'board:read', subject: f.accounts.recipient }]
              : step === 'thread-list'
                ? [{ resourceId: watched.id, route: routeOf(watched.id)!, action: 'thread:read', subject: owner },
                    { resourceId: unrelatedSourceThreadId!, route: routeOf(unrelatedSourceThreadId!)!, action: 'thread:read', subject: f.accounts.recipient }]
                : step === 'cold-thread-retry'
                  ? [{ resourceId: retryTarget!, route: routeOf(retryTarget!)!, action: 'thread:read', subject: retryReader }]
                  : [];
          for (const { resourceId, route: grantRoute, action, subject } of authority) {
            const transactions = Array.from({ length: count }, () => newId(grantRoute));
            await db.admin.query(
              `UPDATE access.resource_grant SET valid=tstzrange(clock_timestamp() - interval '1 day',NULL,'[)')
               WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4 AND valid @> clock_timestamp()`,
              [grantRoute, resourceId, subject, action],
            );
            await db.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
               SELECT $1,$2,$3,$4,
                      tstzrange('2000-01-01T00:00:00Z'::timestamptz - ($6 + ordinal)*interval '2 hours',
                                '2000-01-01T01:00:00Z'::timestamptz - ($6 + ordinal)*interval '2 hours','[)'),transaction_id
               FROM unnest($5::uuid[]) WITH ORDINALITY history(transaction_id,ordinal)`,
              [grantRoute, resourceId, subject, action, transactions, previous],
            );
          }
        },
        prepare,
        async warmup() {
          await prepare();
          return operation();
        },
        operation,
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      assertGrowthAccessPaths(report.name, report.samples, [
        'content.board_watch',
        'content.thread_watch',
        'content.revision',
        'access.resource_grant',
      ]);
      expect(report.samples.every((sample) => sample.cost.controlStatements > 0)).toBe(true);
      expect(
        report.samples.every(
          ({ cost }) =>
            cost.statements > 0 &&
            cost.rows > 0 &&
            typeof cost.requestBytes === 'number' &&
            typeof cost.responseBytes === 'number' &&
            (cost.backgroundStatements ?? 0) === 0,
        ),
      ).toBe(true);
      expect(report.counted).toHaveProperty('accessPreparations');
      expect(report.counted).toHaveProperty('materializedDtoBytes');
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
      // standingFixture owns this setup table; the next native operation creates its own fixture.
      accessCounts.restore();
      await f.db.admin.query('DROP TABLE public.standing_resource');
      await f.close();
    }
  }
}, 1_800_000);
