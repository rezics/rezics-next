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

test.serial('the mounted opening page combines current Realm context and a disclosed discussion card', async () => {
  const createdBoard = await world.board();
  expect(createdBoard.response.status).toBe(201);
  const boardId = createdBoard.value.board.id as string;
  const createdThread = await world.checked('POST', '/v1/threads', {
    boardId,
    title: 'Opening page discussion',
    body: fromPlainText('A useful opening post.'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });

  const result = await world.call('GET', `/v1/boards/${boardId}/page`);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.value).sort()).toEqual(
    ['board', 'pinnedThreads', 'threads', 'next', 'rankRefreshedAt', 'reactionsAsOf', 'viewer', 'actions'].sort(),
  );
  expect(result.value.board).toMatchObject({
    id: boardId,
    realmId: world.realm.realmId,
    community: { realmId: world.realm.realmId, rules: { state: expect.any(String) } },
  });
  expect(result.value.pinnedThreads).toEqual([]);
  expect(result.value.threads).toHaveLength(1);
  expect(result.value.threads[0]).toMatchObject({
    thread: {
      id: createdThread.thread.id,
      title: 'Opening page discussion',
      firstPost: { availability: 'available' },
    },
    target: { kind: 'thread', id: createdThread.thread.id, boardId },
    authors: {
      thread: { state: 'available', id: world.owner.accountId },
      openingPost: { state: 'available', id: world.owner.accountId },
    },
    interaction: {
      target: { kind: 'thread', id: createdThread.thread.id },
      counts: { state: 'unavailable' },
      viewer: { state: 'current', reaction: null },
    },
    comments: { state: 'unavailable' },
    actions: { share: 'available' },
  });
  expect(result.value.next).toBeNull();
  const invalid = await world.call('GET', `/v1/boards/${boardId}/page?sort=oldest`);
  expect(invalid.response.status).toBe(400);
  expect(invalid.value.code).toBe('invalid_request');
});
