import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { openThreadBoardSystem } from './support/thread-board-system.ts';

let system: Awaited<ReturnType<typeof openThreadBoardSystem>>;
beforeAll(async () => {
  system = await openThreadBoardSystem();
}, 180_000);
afterAll(async () => {
  await system?.close();
}, 120_000);

function opening(title: string) {
  return {
    title,
    kind: 'discussion',
    subjectIds: [system.subjectId],
    body: fromPlainText('Persona matrix opening'),
    licence: 'CC-BY-4.0',
    visibility: 'published',
  };
}

test('anonymous, member, outsider and suspended see current Board disclosure and write authority', async () => {
  const published = await system.board('published');
  const protectedBoard = await system.board('protected');
  const publishedThread = await system.thread(published);
  const protectedThread = await system.thread(protectedBoard);
  await system.drain(published);
  await system.drain(protectedBoard);

  expect((await system.get(`/v1/threads/${publishedThread.id}`)).status).toBe(200);
  expect((await system.get(`/v1/threads/${publishedThread.id}`, system.author)).status).toBe(200);
  expect((await system.get(`/v1/threads/${publishedThread.id}`, system.member)).status).toBe(200);
  expect((await system.get(`/v1/threads/${publishedThread.id}`, system.outsider)).status).toBe(200);

  expect((await system.get(`/v1/threads/${protectedThread.id}`)).status).toBe(404);
  expect((await system.get(`/v1/threads/${protectedThread.id}`, system.outsider)).status).toBe(404);
  expect((await system.get(`/v1/threads/${protectedThread.id}`, system.member)).status).toBe(200);
  expect((await system.get(`/v1/threads/${protectedThread.id}`, system.author)).status).toBe(200);

  const denied = await system.request('POST', '/v1/threads', system.suspended, {
    ...opening('Suspended cannot publish'),
    boardId: published.id,
  });
  expect([401, 403]).toContain(denied.status);
  expect(await denied.text()).not.toContain('Suspended cannot publish');

  const authored = await system.request('POST', '/v1/threads', system.author, {
    ...opening('Author still publishes'),
    boardId: published.id,
  });
  expect(authored.status).toBe(201);
  const created = (await authored.json()) as { thread: { id: string } };
  expect(typeof created.thread.id).toBe('string');
}, 120_000);

test('board takedown conceals the thread from every later reader', async () => {
  const board = await system.board('published');
  const thread = await system.thread(board);
  await system.drain(board);
  expect((await system.get(`/v1/threads/${thread.id}`)).status).toBe(200);
  await system.takedown(board);
  for (const actor of [null, system.author, system.member, system.outsider, system.moderator])
    expect((await system.get(`/v1/threads/${thread.id}`, actor)).status).toBe(404);
  // A suspended bearer fails authentication before the resource is named, so it cannot
  // distinguish a taken-down thread from any other GET.
  expect([401, 403]).toContain((await system.get(`/v1/threads/${thread.id}`, system.suspended)).status);
}, 60_000);
