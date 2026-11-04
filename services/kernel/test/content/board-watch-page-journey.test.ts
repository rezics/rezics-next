import { afterAll, beforeAll, expect, test } from 'bun:test';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeAll(async () => { f = await replyNoticeFixture(); }, 120_000);
afterAll(async () => { await f?.close(); });

test('private Board companion admits exact revisions and keeps current state separate from original receipts', async () => {
  const account = f.accounts.principal;
  const watch = `/v1/boards/${f.boardId}/watch`;
  const page = `${watch}/page`;
  const read = () => f.call(account, 'GET', page);
  expect(await read()).toMatchObject({ status: 200, value: {
    boardId: f.boardId, accountId: account,
    viewer: { state: 'current', watching: false, revision: 0 },
    actions: { watch: 'available', unwatch: 'not-applicable' },
  } });
  const key = crypto.randomUUID();
  const input = { watching: true, expectedRevision: 0 };
  expect(await f.call(account, 'PUT', watch, input, key)).toMatchObject({ status: 200, value: { watching: true, revision: 1 } });
  expect(await read()).toMatchObject({ status: 200, value: {
    viewer: { state: 'current', watching: true, revision: 1 },
    actions: { watch: 'not-applicable', unwatch: 'available' },
  } });
  expect(await f.call(account, 'PUT', watch, { watching: true, expectedRevision: 1 })).toMatchObject({ status: 200, value: { revision: 1 } });
  expect((await f.call(account, 'PUT', watch, { watching: false, expectedRevision: 0 })).status).toBe(409);
  expect(await f.call(account, 'PUT', watch, { watching: false, expectedRevision: 1 })).toMatchObject({ status: 200, value: { revision: 2 } });
  expect(await f.call(account, 'PUT', watch, input, key)).toMatchObject({ status: 200, value: { watching: true, revision: 1 } });
  expect(await read()).toMatchObject({ status: 200, value: { viewer: { watching: false, revision: 2 } } });
  expect(await f.call(account, 'PUT', watch, { watching: true, expectedRevision: 2 })).toMatchObject({ status: 200, value: { revision: 3 } });
  expect(await read()).toMatchObject({ status: 200, value: { viewer: { watching: true, revision: 3 } } });
});
