import { afterAll, expect, test } from 'bun:test';
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
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { cleanupAll, ownNodeProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';
import { documentText, documentVersion, normalizeDocument, type DocumentNode } from '@rezics/document';
import thread from '../src/kernel/recorded/thread.json';

let activeBrowser: Browser | undefined;
let activeStorybook: ProcessCustody | undefined;
let activeBrowserClose: Promise<void> | undefined;

function closeActiveBrowser(): Promise<void> {
  return (activeBrowserClose ??= activeBrowser?.close() ?? Promise.resolve());
}

afterAll(async () => {
  await cleanupAll([
    { label: 'Thread replies browser', run: closeActiveBrowser, timeoutMs: 5000 },
    { label: 'Thread replies Storybook group', run: () => activeStorybook?.close(), timeoutMs: 7000 },
  ]);
});

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

test('real composed reading Page and Pattern keep selected parent and keyboard draft until actual cancellation, and cancellation retains the draft through the sole real composer', async () => {
  const app = join(import.meta.dir, '..');
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') throw new Error('No Storybook test port');
      probe.close(() => resolve(address.port));
    });
  });
  const child = spawn(
    join(app, 'node_modules/.bin/storybook'),
    ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: app, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  const custody = (activeStorybook = ownNodeProcess(child, { label: 'Thread replies Storybook' }));
  const origin = `http://127.0.0.1:${port}`;
  await withCleanup(async () => {
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Storybook exited (${child.exitCode}): ${custody.diagnostics()}`);
      try {
        if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Storybook did not start: ${custody.diagnostics()}`);
      await Bun.sleep(200);
    }
    const browser = (activeBrowser = await chromium.launch());
    for (const tier of ['pages', 'patterns']) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: theme === 'light' ? 390 : 1280, height: 900 },
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await withCleanup(async () => {
          for (const state of ['selected-parent', 'cancelled-parent']) {
            const storyId = `${tier}-community-thread-reading--${state}`;
            await page.goto(`${origin}/iframe.html?id=${storyId}&globals=locale:en;theme:${theme}`);
            await page.locator('html[data-hydrated]').waitFor();
            await page.waitForFunction(
              (id) => {
                const render = (
                  globalThis as typeof globalThis & {
                    __STORYBOOK_PREVIEW__?: { currentRender?: { id?: string; phase?: string } };
                  }
                ).__STORYBOOK_PREVIEW__?.currentRender;
                return render?.id === id && (render.phase === 'finished' || render.phase === 'errored');
              },
              storyId,
              { timeout: 60_000 },
            );
            const composer = page.getByRole('region', { name: m.thread_reply_label() });
            const editor = composer.getByRole('textbox', { name: m.thread_reply_label() });
            await editor.waitFor();
            expect(await editor.getAttribute('class'), storyId).toContain('ProseMirror');
            expect(await page.getByRole('textbox', { name: m.thread_reply_label() }).count()).toBe(1);
            const editorNode = await editor.elementHandle();
            const formId = await composer.locator('form').getAttribute('id');
            const snapshot = async () =>
              normalizeDocument({
                version: documentVersion,
                profile: 'blocks',
                doc: (await editor.evaluate((element) => {
                  const node = (
                    element as HTMLElement & {
                      pmViewDesc?: { node?: { toJSON: () => unknown } };
                    }
                  ).pmViewDesc?.node;
                  if (!node) throw new Error('The mounted native editor document is missing');
                  return node.toJSON();
                })) as DocumentNode,
              });
            const before = await snapshot();
            expect(documentText(before), storyId).toBe('The relationship matters as much as the journey.');
            const cancel = composer.getByRole('button', { name: m.thread_reply_cancel_target() });
            const parent = composer.getByRole('link', { name: m.thread_reply_parent() });
            if (state === 'selected-parent') {
              expect(await cancel.isVisible(), storyId).toBe(true);
              expect(await parent.getAttribute('href')).toBe(`#post-${thread.thread.firstPost.id}`);
            } else {
              expect(await cancel.count(), storyId).toBe(0);
              expect(await parent.count()).toBe(0);
            }
            // Refetch the ordinary stale personal query, which returns a new initialization key.
            await page.evaluate(async () => {
              document.dispatchEvent(new Event('visibilitychange'));
              await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            });
            expect(await snapshot()).toEqual(before);
            expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);
            if (state === 'selected-parent') {
              expect(await parent.getAttribute('href')).toBe(`#post-${thread.thread.firstPost.id}`);
              await cancel.click();
              await page.waitForFunction((element) => document.activeElement === element, editorNode);
            }
            expect(await cancel.count()).toBe(0);
            expect(await parent.count()).toBe(0);
            expect(await snapshot()).toEqual(before);
            expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);
            expect(await composer.locator('form').getAttribute('id')).toBe(formId);
            expect(await page.getByRole('textbox', { name: m.thread_reply_label() }).count()).toBe(1);
            await editorNode?.dispose();
          }
        }, [{ label: 'Thread replies browser context', run: () => context.close(), timeoutMs: 5000 }]);
      }
    }
  }, [
    { label: 'Thread replies browser', run: closeActiveBrowser, timeoutMs: 5000 },
    { label: 'Thread replies Storybook group', run: () => custody.close(), timeoutMs: 7000 },
  ]);
}, 900_000);
