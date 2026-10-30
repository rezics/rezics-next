import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import type { CreatedPost, WriteFailure } from '../src/threads/actions';
import { ReplyIntent, replyParentId } from '../src/threads/reply-context-intent';
import { replyToThreadRequest } from '../src/threads/reply-context-request';
import { ReplyContext } from '../src/threads/reply-context';
import { RemovedPost } from '../src/threads/post-removed';
import { m } from '../src/paraglide/messages.js';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const body = fromPlainText('Keep this selected-parent reply.', 'blocks');
const returned: CreatedPost = {
  id: id(4),
  threadId: id(1),
  parentId: id(2),
  boardId: id(6),
  authorId: id(7),
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-10-31T00:00:00.000Z',
  revisionId: id(5),
  licence: 'LicenseRef-rezics-terms',
  subjectIds: [],
  mediaIds: [],
  availability: 'available',
  body,
  sha256: 'a'.repeat(64),
  revisedAt: null,
  voteCitation: null,
};
const refusal = (status: number): WriteFailure => ({
  ok: false,
  reason: status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 422 ? 'invalid' : 'unavailable',
});

test('retry creates one reply to the selected parent, preserving the intent and current-authority refusals', async () => {
  const intent = new ReplyIntent(id(8));
  const draft = { title: '', body, mediaIds: [] };
  const calls: { key: string | null; body: string }[] = [];
  const receipts = new Map<string | null, CreatedPost>();
  let status = 201;
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe(`/v1/threads/${id(1)}/posts`);
        expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
        const call = { key: request.headers.get('idempotency-key'), body: await request.text() };
        calls.push(call);
        if (status !== 201) return Response.json({ code: 'refused' }, { status });
        if (receipts.has(call.key)) return Response.json({ post: receipts.get(call.key) }, { status: 201 });
        receipts.set(call.key, returned);
        throw new Error('Response lost after commit');
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const command = intent.prepare(draft, replyParentId({ parentId: id(2) }) ?? null);
  const send = () =>
    replyToThreadRequest(
      { ...intent.prepare(draft, id(2)), threadId: id(1) },
      client,
      'Bearer current-viewer',
      refusal,
    );
  expect(await send()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await send()).toEqual({ ok: true, post: returned });
  expect(calls[1]).toEqual(calls[0]);
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ parentId: id(2), body, licence: returned.licence });
  expect(receipts.size).toBe(1);
  for (const denied of [403, 404, 422]) {
    status = denied;
    expect(await send()).toEqual(refusal(denied));
    expect(calls.at(-1)?.key).toBe(JSON.stringify(command.idempotencyKey));
  }
  expect(receipts.size).toBe(1);
  expect(intent.prepare(draft, id(3)).idempotencyKey).not.toBe(command.idempotencyKey);
  const untargeted = intent.prepare(draft, null);
  expect(untargeted).not.toHaveProperty('parentId');
  expect(untargeted.body).toEqual(body);
  expect(() => replyParentId({ parentId: '../hidden' })).toThrow('Invalid reply parent id');
});

test('reload after parent deletion retains the relationship and tombstone without parent text', async () => {
  const erased = {
    id: id(2),
    threadId: id(1),
    route: 0,
    parentId: null,
    availability: 'erased',
    removed: true,
    body: null,
    sha256: null,
  } as const;
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(async () => Response.json({ posts: [erased, returned], next: null }), {
      preconnect: fetch.preconnect,
    }),
  });
  const result = await client.threads({ id: id(1) }).posts.get({});
  if (result.error) throw new Error('Page read failed');
  const parents = new Map(result.data.posts.map((post) => [post.id, post]));
  const reply = result.data.posts.find((post) => post.id === returned.id)!;
  expect(reply.parentId).toBe(erased.id);
  const context = renderToStaticMarkup(createElement(ReplyContext, { parentId: reply.parentId, parents }));
  expect(context).toContain(`href="#post-${erased.id}"`);
  expect(context).toContain(m.thread_reply_parent_deleted());
  const tombstone = renderToStaticMarkup(
    createElement(RemovedPost, {
      post: erased,
      authors: {},
      now: returned.createdAt,
      anchorId: `post-${erased.id}`,
      itemRef: null,
      menuButton: null,
      onCopyLink: () => undefined,
    }),
  );
  expect(tombstone).toContain(m.thread_post_deleted());
  expect(tombstone).not.toContain('Keep this selected-parent reply.');
  const unloaded = renderToStaticMarkup(createElement(ReplyContext, { parentId: reply.parentId, parents: new Map() }));
  expect(unloaded).toContain(m.thread_reply_parent());
  expect(unloaded).not.toContain('href=');
  const withheld = renderToStaticMarkup(
    createElement(ReplyContext, {
      parentId: erased.id,
      parents: new Map([[erased.id, { id: erased.id, availability: 'withheld' }]]),
    }),
  );
  expect(withheld).toContain(m.thread_reply_parent_unavailable());
});
