import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openThreadBoardSystem, type Reader } from './support/thread-board-system.ts';

let system: Awaited<ReturnType<typeof openThreadBoardSystem>>;
beforeAll(async () => {
  system = await openThreadBoardSystem();
}, 90_000);
afterAll(async () => {
  await system?.close();
});

async function page(path: string, actor: Reader) {
  const response = await system.get(path, actor);
  expect(response.status).toBe(200);
  return response.json();
}
function continuation(path: string, cursor: string) {
  return `${path}&cursor=${encodeURIComponent(cursor)}`;
}

for (const visibility of ['published', 'protected'] as const) {
  for (const sort of ['hot', 'active', 'newest', 'posts'] as const) {
    test(`late-board-revocation-pages: ${visibility} ${sort} first and continuing pages use final Board authority`, async () => {
      for (const continuing of [false, true]) {
        const board = await system.board(visibility);
        const threads = [await system.thread(board), await system.thread(board), await system.thread(board)];
        const thread = threads[0]!;
        for (let index = 0; index < 3; index++) await system.reply(thread);
        await system.drain(board);
        const actor = visibility === 'protected' ? system.member : null;
        const field = sort === 'posts' ? 'posts' : 'threads';
        const path =
          sort === 'posts'
            ? `/v1/threads/${thread.id}/posts?limit=2`
            : `/v1/boards/${board.id}/threads?sort=${sort}&limit=2`;
        const first = await page(path, actor);
        expect(first[field]).toHaveLength(2);
        expect(typeof first.next).toBe('string');
        const following = continuation(path, first.next);
        const next = await page(following, actor);
        expect(next[field].length).toBeGreaterThan(0);
        const ids = new Set(first[field].map((item: { id: string }) => item.id));
        for (const item of next[field]) expect(ids.has(item.id)).toBe(false);
        const selected = continuing ? following : path;
        // The seam follows enrichment and releases every source connection. Mutation uses the real command.
        const held = await system.hold(selected, actor, sort === 'posts' ? thread.id : board.id, true);
        try {
          await held.reached;
          if (visibility === 'protected') await system.revoke(board);
          else await system.takedown(board);
        } finally {
          held.release();
        }
        const response = await held.response;
        expect(response.status).toBe(404);
        const text = await response.text();
        for (const thread of threads) expect(text).not.toContain(thread.id);
        expect(text).not.toContain('reactionCounts');
        expect(text).not.toContain('Controlled original opening');
        expect((await system.get(selected, actor)).status).toBe(404);
      }
    }, 120_000);
  }
}

test('unchanged eligible pages stay complete and a replaced post head cannot reuse earlier page bytes', async () => {
  const board = await system.board('protected');
  const thread = await system.thread(board);
  const reply = await system.reply(thread);
  await system.reply(thread);
  await system.drain(board);
  const path = `/v1/threads/${thread.id}/posts?limit=2`;
  const baseline = await page(path, system.member);
  const unchanged = await system.hold(path, system.member, thread.id, true);
  await unchanged.reached;
  unchanged.release();
  const same = await unchanged.response;
  expect(same.status).toBe(200);
  expect((await same.json()).posts).toEqual(baseline.posts);
  const held = await system.hold(path, system.member, thread.id, true);
  let revisionId: string;
  try {
    await held.reached;
    revisionId = (await system.revise(reply)).revisionId;
  } finally {
    held.release();
  }
  const response = await held.response;
  expect(response.status).toBe(200);
  const changed = await response.json();
  expect(changed.posts.map((post: { id: string }) => post.id)).not.toContain(reply.id);
  expect(typeof changed.next).toBe('string');
  const current = await page(path, system.member);
  expect(current.posts.find((post: { id: string }) => post.id === reply.id).revisionId).toBe(revisionId!);
  const exact = await system.get(`/v1/posts/${reply.id}/revisions/${reply.revisionId}`, system.member);
  expect(exact.status).toBe(200);
  expect((await exact.json()).post.revisionId).toBe(reply.revisionId);
}, 60_000);
