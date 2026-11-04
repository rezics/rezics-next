import { expect, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { nativeOwnDraftRequests } from '../src/threads/own-drafts/native-requests';
import type { OwnDraftNativePage, OwnDraftNativePost } from '../src/threads/own-drafts/model';
import { accountId, identity, mountOwnDrafts, row, threadId } from './own-drafts-fixture';

const entry = row();
const page: OwnDraftNativePage = {
  state: 'ready',
  viewer: { accountId, authnEpoch: 2 },
  drafts: [entry],
  next: 'opaque/+',
};
const post = {
  id: entry.id,
  threadId,
  authorId: accountId,
  revisionId: entry.revisionId,
  parentId: null,
  route: 0,
  boardId: entry.board.id,
  subjectIds: entry.subjectIds,
  licence: entry.licence,
  visibility: 'draft',
  availability: 'available',
  mediaIds: [],
  securityRevision: 'security',
  sha256: 'digest',
  voteCitation: null,
  createdAt: entry.savedAt,
  revisedAt: entry.savedAt,
  body: fromPlainText('Exact native selected body', 'blocks'),
} satisfies OwnDraftNativePost;
const response = (value: unknown, status = 200, etag: string | null = JSON.stringify(entry.revisionId)) =>
  Response.json(value, { status, headers: { 'cache-control': 'private, no-store', ...(etag ? { etag } : {}) } });

test('mounted generated reads retain exact retries, sparse continuation and explicit cursor restart', async () => {
  const calls: Request[] = [];
  let selectedAttempts = 0;
  let cursorAttempts = 0;
  const reader = nativeOwnDraftRequests(
    createKernelClient('https://kernel.test', {
      headers: { authorization: 'Bearer fixture' },
      async fetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        expect(request.cache).toBe('no-store');
        expect(request.headers.get('authorization')).toBe('Bearer fixture');
        const url = new URL(request.url);
        if (url.pathname.endsWith(`/${entry.id}`)) {
          expect(url.searchParams.get('threadId')).toBe(threadId);
          return ++selectedAttempts === 1 ? response({ code: 'dependency_unavailable' }, 503) : response({ post });
        }
        expect(url.searchParams.get('limit')).toBe('20');
        if (url.searchParams.get('cursor') === 'invalid') return response({ code: 'invalid_cursor' }, 400);
        if (url.searchParams.has('cursor')) {
          expect(url.searchParams.get('cursor')).toBe('opaque/+');
          return ++cursorAttempts === 1 ? response({}, 503) : response({ ...page, drafts: [], next: 'invalid' });
        }
        return response(page);
      },
    }),
  );
  const fixture = await mountOwnDrafts();
  try {
    await fixture.render({ identity, active: true, reader });
    expect(calls).toHaveLength(1);
    await fixture.click('Inspect draft privately');
    await fixture.click('Retry selected draft');
    expect(calls[1]?.url).toBe(calls[2]?.url);
    expect(fixture.host.textContent).toContain('Exact native selected body');
    await fixture.click('Return to drafts');
    expect(fixture.window.document.activeElement?.textContent).toBe('Inspect draft privately');
    await fixture.click('Continue to older drafts');
    await fixture.click('Retry this page');
    expect(calls[3]?.url).toBe(calls[4]?.url);
    expect(fixture.host.textContent).not.toContain('No server-saved drafts');
    expect(fixture.host.querySelectorAll('li')).toHaveLength(0);
    await fixture.click('Continue to older drafts');
    expect(fixture.host.textContent).toContain('no longer current');
    expect(fixture.host.textContent).not.toContain('Retry this page');
    await fixture.click('Restart inventory');
    expect(calls[6]?.url).toBe(calls[0]?.url);
    expect(fixture.window.localStorage.length).toBe(0);
    expect(fixture.window.sessionStorage.length).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('generated selection validates native author, resource, draft visibility and strong revision; abort drops late bytes', async () => {
  let payload: unknown = { post };
  let etag: string | null = JSON.stringify(entry.revisionId);
  let status = 200;
  let finish: (() => void) | undefined;
  const reader = nativeOwnDraftRequests(
    createKernelClient('https://kernel.test', {
      async fetch() {
        if (finish)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return response(payload, status, etag);
      },
    }),
  );
  const request = { accountId, id: entry.id, threadId };
  const controller = new AbortController();
  for (const invalid of [
    { authorId: threadId },
    { id: threadId },
    { threadId: accountId },
    { visibility: 'published' },
  ]) {
    payload = { post: { ...post, ...invalid } };
    expect(await reader.resume(request, controller.signal)).toBe('concealed');
  }
  payload = { post };
  for (etag of [null, `W/"${entry.revisionId}"`, '"invalid"'])
    expect(await reader.resume(request, controller.signal)).toBe('unavailable');
  etag = JSON.stringify(accountId);
  expect(await reader.resume(request, controller.signal)).toBe('stale');
  for (status of [401, 403, 404, 503])
    expect(await reader.resume(request, controller.signal)).toBe(
      status === 404 ? 'concealed' : status === 503 ? 'unavailable' : 'denied',
    );
  status = 200;
  etag = JSON.stringify(entry.revisionId);
  finish = () => {};
  const late = reader.resume(request, controller.signal);
  controller.abort();
  finish!();
  expect(await late).toBe('unavailable');
});

test('native conflict inspection retires replaced revision advice and erase review restores keyboard focus', async () => {
  const reader = nativeOwnDraftRequests(
    createKernelClient('https://kernel.test', {
      async fetch(input) {
        return response(String(input).includes(`/${entry.id}?`) ? { post } : page);
      },
    }),
  );
  const fixture = await mountOwnDrafts();
  try {
    await fixture.render({
      identity,
      active: true,
      reader,
      commands: {
        write: async () => ({ ok: false, reason: 'stale', currentPost: { ...post, revisionId: accountId } }),
        erase: async () => ({ ok: true }),
        readback: async () => 'unavailable',
      },
    });
    await fixture.click('Inspect draft privately');
    await fixture.click('Erase draft');
    expect(fixture.window.document.activeElement?.textContent).toBe('Cancel');
    await act(async () =>
      fixture.window.document.activeElement?.dispatchEvent(
        new fixture.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(fixture.window.document.activeElement?.textContent).toBe('Erase draft');
    await fixture.click('Use server-saved body in editor');
    await fixture.click('Save changes');
    await fixture.click('Review current version');
    expect(fixture.host.querySelector('[role="alertdialog"]')?.textContent).toContain('Exact native selected body');
    await fixture.click('Replace draft with current');
    expect(fixture.host.textContent).toContain('Restart the inventory');
    expect(fixture.host.textContent).not.toContain('Exact native selected body');
    expect(fixture.host.textContent).not.toContain('Save changes');
  } finally {
    await fixture.close();
  }
});
