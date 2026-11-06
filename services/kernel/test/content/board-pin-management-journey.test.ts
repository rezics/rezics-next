import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { realmBoardWorld } from './realm-board-create-support.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;

beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
});

test.serial('selected pin advice uses the admitted Board generation and opens that thread reading page', async () => {
  const created = await world.board();
  expect(created.response.status).toBe(201);
  const boardId = created.value.board.id as string;
  const threads: Array<{ id: string; firstPost: { id: string; revisionId: string } }> = [];
  for (let index = 0; index < 3; index++) {
    const createdThread = await world.checked('POST', '/v1/threads', {
      boardId,
      title: `Pin journey ${index}`,
      body: fromPlainText(`Opening ${index}`),
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
    });
    threads.push(createdThread.thread);
  }
  const target = threads[0]!;
  await world.checked('POST', `/v1/boards/${boardId}/threads/${target.id}/pin`, { pinned: true }, 200);

  const first = await world.call('GET', `/v1/boards/${boardId}/page?sort=new`);
  expect(first.response.status, first.text).toBe(200);
  expect(first.value.pinRevision).toBe('1');
  expect(first.value.pinnedThreads.map((card: { thread: { id: string } }) => card.thread.id)).toEqual([target.id]);
  const selected = [
    ...first.value.pinnedThreads,
    ...first.value.threads,
  ].map((card: { thread: { id: string; firstPost: { revisionId: string } } }) => ({
    threadId: card.thread.id,
    placeId: boardId,
    sourceRevisionId: card.thread.firstPost.revisionId,
  }));
  const advice = await world.call('POST', `/v1/boards/${boardId}/pin-advice`, {
    selected,
    pinRevision: first.value.pinRevision,
  });
  expect(advice.response.status, advice.text).toBe(200);
  expect(advice.value).toMatchObject({
    state: 'ready',
    boardId,
    pinRevision: '1',
    management: 'allowed',
    viewer: { kind: 'account', id: world.owner.accountId },
  });
  expect(advice.value.threads[0]).toEqual({ threadId: target.id, pinned: true, actions: ['unpin'] });

  const reading = await world.call('GET', `/v1/threads/${target.id}/reading-page`);
  expect(reading.response.status, reading.text).toBe(200);
  expect(reading.value.thread.id).toBe(target.id);
  expect(reading.value.thread.firstPost.id).toBe(target.firstPost.id);
  expect(reading.value.documentMedia).toMatchObject({ state: 'available' });
  expect(Object.hasOwn(reading.value, 'mentions')).toBe(true);
  expect(Object.hasOwn(reading.value, 'conversationActivity')).toBe(true);
  expect(reading.value.thread.firstPost.body).toBeDefined();

  const continuedPath = first.value.next
    ? `/v1/boards/${boardId}/page?sort=new&cursor=${encodeURIComponent(first.value.next)}`
    : undefined;
  await world.checked('POST', `/v1/boards/${boardId}/threads/${target.id}/pin`, { pinned: false }, 200);
  const after = await world.call('GET', `/v1/boards/${boardId}/page?sort=new`);
  expect(after.response.status, after.text).toBe(200);
  expect(after.value.pinRevision).toBe('2');
  expect(after.value.pinnedThreads).toEqual([]);
  const staleAdvice = await world.call('POST', `/v1/boards/${boardId}/pin-advice`, {
    selected,
    pinRevision: first.value.pinRevision,
  });
  expect(staleAdvice.response.status, staleAdvice.text).toBe(200);
  expect(staleAdvice.value).toEqual({ state: 'stale' });
  if (continuedPath) {
    const stalePage = await world.call('GET', continuedPath);
    expect(stalePage.response.status).toBe(400);
    expect(stalePage.value.code).toBe('invalid_cursor');
  }

  const currentReading = await world.call('GET', `/v1/threads/${target.id}/reading-page`);
  expect(currentReading.response.status, currentReading.text).toBe(200);
  expect(currentReading.value.thread.firstPost.id).toBe(target.firstPost.id);
}, 240_000);
