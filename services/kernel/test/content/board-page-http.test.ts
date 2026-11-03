import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { realmBoardWorld } from './realm-board-create-support.ts';
import {
  projectBoardOpeningComments,
  projectBoardOpeningReactionCounts,
  type BoardOpeningActivityWitness,
} from '../../src/content/board-page.ts';
import type { Actor } from '../../src/request/access.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;

beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
});

test('Board comments require a current matching cohort witness and reaction zero differs from unavailable', () => {
  const threadId = 'thread-one';
  const publicZero: BoardOpeningActivityWitness = {
    state: 'current',
    threadId,
    cohort: { kind: 'public' },
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
    source: { epoch: 2, position: '10' },
  };
  const privateActivity: BoardOpeningActivityWitness = {
    ...publicZero,
    cohort: { kind: 'viewer', accountId: 'account-one' },
    count: { kind: 'lower-bound', value: 2 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  };
  const anonymous = { kind: 'anonymous' } as Actor;
  const account = { kind: 'account', accountId: 'account-one' } as Actor;

  expect(projectBoardOpeningComments(threadId, publicZero, anonymous)).toMatchObject({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  });
  expect(projectBoardOpeningComments(threadId, privateActivity, anonymous)).toEqual({ state: 'unavailable' });
  expect(projectBoardOpeningComments(threadId, privateActivity, account)).toMatchObject({
    state: 'current',
    cohort: 'viewer',
    count: { kind: 'lower-bound', value: 2 },
  });
  expect(projectBoardOpeningComments('other-thread', publicZero, anonymous)).toEqual({ state: 'unavailable' });

  const selected = projectBoardOpeningComments(threadId, publicZero, anonymous);
  // A producer may refresh a retained summary object while the page hydrates.
  Object.assign(publicZero.count, { value: 1 });
  Object.assign(publicZero.source, { position: '11' });
  const refreshed = projectBoardOpeningComments(threadId, publicZero, anonymous);
  expect(selected).toMatchObject({ count: { value: 0 }, source: { position: '10' } });
  expect(refreshed).toMatchObject({ count: { value: 1 }, source: { position: '11' } });
  expect(selected).not.toEqual(refreshed);

  expect(projectBoardOpeningReactionCounts(true, {}, { epoch: 2, position: '10' })).toEqual({
    state: 'as-of',
    values: {},
    source: { epoch: 2, position: '10' },
  });
  expect(projectBoardOpeningReactionCounts(true, undefined, undefined)).toEqual({ state: 'unavailable' });
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
