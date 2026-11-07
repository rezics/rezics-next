import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openThreadBoardSystem } from './support/thread-board-system.ts';

let system: Awaited<ReturnType<typeof openThreadBoardSystem>>;
beforeAll(async () => {
  system = await openThreadBoardSystem();
}, 180_000);
afterAll(async () => {
  await system?.close();
}, 120_000);

for (const visibility of ['published', 'protected'] as const) {
  test(`late-board-revocation-point-reads: ${visibility} authority is current on every reader surface`, async () => {
    for (const surface of ['thread', 'post', 'revision', 'subject', 'author-thread', 'author-post'] as const) {
      const board = await system.board(visibility);
      const thread = await system.thread(board);
      const reply = await system.reply(thread);
      await system.drain(board);
      const actor = visibility === 'protected' ? system.member : null;
      const post = surface === 'author-post' ? reply : thread.firstPost;
      const paths = {
        thread: `/v1/threads/${thread.id}`,
        post: `/v1/posts/${post.id}`,
        revision: `/v1/posts/${post.id}/revisions/${post.revisionId}`,
        subject: `/v1/subjects/${system.subjectId}/threads?place=${GLOBAL_CONTEXT}&kind=discussion&board=${board.id}`,
        'author-thread': `/v1/accounts/${system.author.id}/threads?kind=discussion&limit=20`,
        'author-post': `/v1/accounts/${system.author.id}/posts?limit=20`,
      };
      const path = paths[surface];
      const baseline = await system.get(path, actor);
      expect(baseline.status).toBe(200);
      expect(await baseline.text()).toContain(surface === 'author-post' ? reply.id : thread.id);
      if (visibility === 'protected') {
        const denied = await system.get(`/v1/threads/${thread.id}`, system.outsider);
        expect(denied.status).toBe(404);
        expect((await system.get(`/v1/threads/${thread.id}`, system.author)).status).toBe(200);
      }
      const key = surface === 'thread' || surface === 'subject' || surface === 'author-thread' ? thread.id : post.id;
      const held = await system.hold(path, actor, key, false);
      try {
        await held.reached;
        if (visibility === 'protected') await system.revoke(board);
        else await system.takedown(board);
      } finally {
        held.release();
      }
      const response = await held.response;
      expect(response.status).toBe(surface === 'subject' || surface.startsWith('author-') ? 200 : 404);
      const body = await response.text();
      expect(body).not.toContain(surface === 'author-post' ? reply.id : thread.id);
      expect(body).not.toContain(post.revisionId);
      expect(body).not.toContain('Controlled original opening');
      expect((await system.get(`/v1/threads/${thread.id}`, actor)).status).toBe(404);
    }
  }, 120_000);
}

test('native author edits retain exact immutable history, licence and reply ancestry', async () => {
  const board = await system.board();
  const thread = await system.thread(board);
  const reply = await system.reply(thread);
  const nested = await system.reply(thread, reply.id);
  const before = await (await system.get(`/v1/posts/${reply.id}/revisions/${reply.revisionId}`)).json();
  const edited = await system.revise(reply);
  expect(edited.revisionId).not.toBe(reply.revisionId);
  const exact = await system.get(`/v1/posts/${reply.id}/revisions/${reply.revisionId}`);
  expect(exact.status).toBe(200);
  const retained = (await exact.json()).post;
  for (const field of ['revisionId', 'body', 'sha256', 'licence', 'subjectIds', 'mediaIds'])
    expect(retained[field]).toEqual(before.post[field]);
  expect((await (await system.get(`/v1/posts/${reply.id}`)).json()).post.licence).toBe('MIT');
  expect((await (await system.get(`/v1/posts/${nested.id}`)).json()).post.parentId).toBe(reply.id);
}, 30_000);
