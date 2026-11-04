import { afterEach, beforeEach, expect, test } from 'bun:test';
import { newId, routeOf } from '../../src/route/route.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';
import {
  captureBoardWatchPageQueries,
  captureWatchAccess,
  interceptBoardSnapshot,
  watchPageByteEvidence,
} from './support/watch-management-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeEach(async () => {
  f = await replyNoticeFixture();
}, 120_000);
afterEach(async () => {
  await f?.close();
});

test('private Board companion admits exact revisions and keeps current state separate from original receipts', async () => {
  const account = f.accounts.principal;
  const watch = `/v1/boards/${f.boardId}/watch`;
  const page = `${watch}/page`;
  const read = () => f.call(account, 'GET', page);
  const initial = await read();
  expect(initial.headers.get('cache-control')).toBe('private, no-store');
  expect(Object.keys(initial.value).sort()).toEqual(['accountId', 'actions', 'boardId', 'source', 'viewer']);
  expect(initial).toMatchObject({
    status: 200,
    value: {
      boardId: f.boardId,
      accountId: account,
      viewer: { state: 'current', watching: false, revision: 0 },
      actions: { watch: 'available', unwatch: 'not-applicable' },
    },
  });
  const key = crypto.randomUUID();
  const input = { watching: true, expectedRevision: 0 };
  expect(await f.call(account, 'PUT', watch, input, key)).toMatchObject({
    status: 200,
    value: { watching: true, revision: 1 },
  });
  const firstEpisode = (
    await f.db.admin.query(
      'SELECT watch_id,created_at::text AS created_at FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3',
      [routeOf(account), account, f.boardId],
    )
  ).rows[0]!;
  expect(await read()).toMatchObject({
    status: 200,
    value: {
      viewer: { state: 'current', watching: true, revision: 1 },
      actions: { watch: 'not-applicable', unwatch: 'available' },
    },
  });
  expect(await f.call(account, 'PUT', watch, { watching: true, expectedRevision: 1 })).toMatchObject({
    status: 200,
    value: { revision: 1 },
  });
  expect((await f.call(account, 'PUT', watch, { watching: false, expectedRevision: 0 })).status).toBe(409);
  expect(await f.call(account, 'PUT', watch, { watching: false, expectedRevision: 1 })).toMatchObject({
    status: 200,
    value: { revision: 2 },
  });
  await f.db.admin.query(
    'UPDATE content.board_watch SET created_at=$4::timestamptz WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3',
    [routeOf(account), account, f.boardId, '2000-01-01T00:00:00Z'],
  );
  expect(await f.call(account, 'PUT', watch, input, key)).toMatchObject({
    status: 200,
    value: { watching: true, revision: 1 },
  });
  expect(await read()).toMatchObject({ status: 200, value: { viewer: { watching: false, revision: 2 } } });
  expect(await f.call(account, 'PUT', watch, { watching: true, expectedRevision: 2 })).toMatchObject({
    status: 200,
    value: { revision: 3 },
  });
  expect(await read()).toMatchObject({ status: 200, value: { viewer: { watching: true, revision: 3 } } });
  const nextEpisode = (
    await f.db.admin.query(
      'SELECT watch_id,created_at::text AS created_at FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3',
      [routeOf(account), account, f.boardId],
    )
  ).rows[0]!;
  expect(nextEpisode.watch_id).not.toBe(firstEpisode.watch_id);
  expect(Date.parse(nextEpisode.created_at)).toBeGreaterThan(Date.parse(firstEpisode.created_at));
});

test('watch-page advice stays read-only and revoked authority cannot create or replay a receipt', async () => {
  const account = f.accounts.principal;
  const watch = `/v1/boards/${f.boardId}/watch`;
  const command = { watching: true, expectedRevision: 0 };
  const key = crypto.randomUUID();
  await f.db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:update'",
    [routeOf(account), account, account],
  );
  expect(await f.call(account, 'GET', `${watch}/page`)).toMatchObject({
    status: 200,
    value: {
      viewer: { watching: false, revision: 0 },
      actions: { watch: 'denied', unwatch: 'not-applicable' },
    },
  });
  expect(await f.call(account, 'PUT', watch, command, key)).toMatchObject({ status: 403 });
  await f.accounts.grant(account, 'account:update', { route: routeOf(account)!, id: account });
  expect(await f.call(account, 'PUT', watch, command, key)).toMatchObject({ status: 200, value: { revision: 1 } });
  await f.db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:update'",
    [routeOf(account), account, account],
  );
  expect(await f.call(account, 'PUT', watch, command, key)).toMatchObject({ status: 403 });
});

test('suspended watch owners and failing native Board dependencies never become revision zero', async () => {
  const account = f.accounts.recipient;
  const path = `/v1/boards/${f.boardId}/watch/page`;
  await suspendAccount(f.db.pool, account);
  expect(await f.call(account, 'GET', path)).toMatchObject({ status: 403 });

  const gate = interceptBoardSnapshot(f.db.pool, f.boardId, 1, 'fail');
  try {
    const response = await f.call(f.accounts.principal, 'GET', path);
    expect(response.status).toBe(503);
    expect(response.value).not.toMatchObject({ viewer: { watching: false, revision: 0 } });
  } finally {
    gate.restore();
  }
});

test('watch-page revision and Board concealment changes between source observations fail closed', async () => {
  const account = f.accounts.principal;
  const path = `/v1/boards/${f.boardId}/watch/page`;
  const revisionGate = interceptBoardSnapshot(f.db.pool, f.boardId, 3, 'pause');
  try {
    const pending = f.call(account, 'GET', path);
    await revisionGate.reached;
    await f.db.admin.query(
      "UPDATE content.board SET title='Changed during watch read',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [routeOf(f.boardId), f.boardId],
    );
    revisionGate.release();
    expect(await pending).toMatchObject({ status: 409 });
  } finally {
    revisionGate.restore();
  }

  const concealGate = interceptBoardSnapshot(f.db.pool, f.boardId, 3, 'pause');
  try {
    const pending = f.call(account, 'GET', path);
    await concealGate.reached;
    await f.db.admin.query(
      "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='board:read'",
      [routeOf(f.boardId), f.boardId, account],
    );
    concealGate.release();
    expect(await pending).toMatchObject({ status: 404 });
  } finally {
    concealGate.restore();
  }
});

test('watch-page indexed work, authority and retained bytes stay fixed across independent native populations', async () => {
  const populations = [
    'unrelated watches',
    'Board subscribers',
    'tombstone and rewatch history',
    'publications',
    'Access and Accounts',
  ] as const;
  for (const population of populations) {
    const f = await replyNoticeFixture();
    const access = captureWatchAccess(f.accounts.access);
    const queries = captureBoardWatchPageQueries(f.db.pool, f.boardId);
    try {
      const owner = f.accounts.actor;
      const ownerRoute = routeOf(owner)!;
      const boardRoute = routeOf(f.boardId)!;
      const path = `/v1/boards/${f.boardId}/watch/page`;
      expect(
        await f.call(owner, 'PUT', `/v1/boards/${f.boardId}/watch`, { watching: true, expectedRevision: 0 }),
      ).toMatchObject({ status: 200, value: { watching: true, revision: 1 } });
      const report = await checkGrowth(f.db, {
        name: `mounted Board watch companion: ${population}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        repetitions: 1,
        warmups: 1,
        counted: {
          read: (value) =>
            value as {
              boardPointReads: number;
              boardPointRows: number;
              selectedWatchReads: number;
              selectedWatchRows: number;
              accessPreparations: number;
              accessEvaluations: number;
              materializedDtoBytes: number;
              retainedItemBytes: number;
              copiedDtoBytes: number;
              serializedUtf8Bytes: number;
            },
          limits: {
            boardPointReads: 4,
            boardPointRows: 4,
            selectedWatchReads: 2,
            selectedWatchRows: 2,
            accessPreparations: 1024,
            accessEvaluations: 1024,
            materializedDtoBytes: 16_384,
            retainedItemBytes: 16_384,
            copiedDtoBytes: 16_384,
            serializedUtf8Bytes: 16_384,
          },
          bounds: {
            boardPointReads: 'constant',
            boardPointRows: 'constant',
            selectedWatchReads: 'constant',
            selectedWatchRows: 'constant',
            accessPreparations: 'constant',
            accessEvaluations: 'constant',
            materializedDtoBytes: 'constant',
            retainedItemBytes: 'constant',
            copiedDtoBytes: 'constant',
            serializedUtf8Bytes: 'constant',
          },
        },
        async grow(db, scale, previous) {
          const count = scale - previous;
          if (population === 'unrelated watches' || population === 'tombstone and rewatch history') {
            const boards = Array.from({ length: count }, () => newId(ownerRoute));
            const watches = Array.from({ length: count }, () => newId(ownerRoute));
            const watching = Array.from({ length: count }, (_, index) =>
              population === 'unrelated watches' ? true : index % 2 === 1,
            );
            await db.admin.query(
              `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
               SELECT $1,$2,board,watch,watching,CASE WHEN watching THEN 3 ELSE 2 END,
                      clock_timestamp()+ordinal*interval '1 microsecond'
               FROM unnest($3::uuid[],$4::uuid[],$5::boolean[]) WITH ORDINALITY n(board,watch,watching,ordinal)`,
              [ownerRoute, owner, boards, watches, watching],
            );
          } else if (population === 'Board subscribers') {
            const subscribers = Array.from({ length: count }, () => newId(boardRoute));
            const watches = Array.from({ length: count }, () => newId(boardRoute));
            await db.admin.query(
              `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
               SELECT $1,subscriber,$2,watch,true,1,clock_timestamp()+ordinal*interval '1 microsecond'
               FROM unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY n(subscriber,watch,ordinal)`,
              [boardRoute, f.boardId, subscribers, watches],
            );
          } else if (population === 'publications') {
            const posts = Array.from({ length: count }, () => newId(boardRoute));
            const threads = Array.from({ length: count }, () => newId(boardRoute));
            const sources = Array.from({ length: count }, () => newId(boardRoute));
            await db.admin.query(
              `INSERT INTO content.board_watch_notice_work
                 (route,post_id,board_id,thread_id,source_epoch,source_position,source_id,published_at)
               SELECT $1,post,$2,thread,1,ordinal,source,clock_timestamp()
               FROM unnest($3::uuid[],$4::uuid[],$5::uuid[]) WITH ORDINALITY n(post,thread,source,ordinal)`,
              [boardRoute, f.boardId, posts, threads, sources],
            );
          } else {
            const accounts = Array.from({ length: count }, () => newId(ownerRoute));
            const transactions = Array.from({ length: count }, () => newId(ownerRoute));
            await db.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
               SELECT $1,account,'actor','active',transaction_id
               FROM unnest($2::uuid[],$3::uuid[]) n(account,transaction_id)`,
              [ownerRoute, accounts, transactions],
            );
            const grantTransactions = Array.from({ length: count }, () => newId(boardRoute));
            await db.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
               SELECT $1,$2,$3,'board:read',
                      tstzrange('2000-01-01T00:00:00Z'::timestamptz-ordinal*interval '2 hours',
                                '2000-01-01T01:00:00Z'::timestamptz-ordinal*interval '2 hours','[)'),transaction_id
               FROM unnest($4::uuid[]) WITH ORDINALITY n(transaction_id,ordinal)`,
              [boardRoute, f.boardId, owner, grantTransactions],
            );
          }
        },
        async operation() {
          access.reset();
          queries.reset();
          const response = await f.call(owner, 'GET', path);
          expect(response.status).toBe(200);
          expect(response.value).toMatchObject({
            boardId: f.boardId,
            accountId: owner,
            viewer: { state: 'current', watching: true, revision: 1 },
            actions: { watch: 'not-applicable', unwatch: 'available' },
          });
          const accessWork = access.snapshot();
          const queryWork = queries.snapshot();
          expect(queryWork).toEqual({
            boardPointReads: 4,
            boardPointRows: 4,
            selectedWatchReads: 2,
            selectedWatchRows: 2,
          });
          expect(accessWork.preparations).toBeGreaterThan(0);
          expect(accessWork.evaluations).toBeGreaterThan(0);
          const byteWork = watchPageByteEvidence(response.value, response.responseBytes);
          return { ...queryWork, ...accessWork, ...byteWork };
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      const growingRelations =
        population === 'publications'
          ? ['content.board_watch_notice_work']
          : population === 'Access and Accounts'
            ? ['access.account', 'access.resource_grant']
            : ['content.board_watch'];
      assertGrowthAccessPaths(report.name, report.samples, growingRelations);
      expect(
        report.samples.every(
          ({ cost }) =>
            cost.controlStatements > 0 &&
            cost.statements > 0 &&
            cost.rows > 0 &&
            typeof cost.requestBytes === 'number' &&
            typeof cost.responseBytes === 'number' &&
            (cost.backgroundStatements ?? 0) === 0,
        ),
      ).toBe(true);
    } finally {
      queries.restore();
      access.restore();
      await f.close();
    }
  }
});
