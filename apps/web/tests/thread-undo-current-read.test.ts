import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as contentActions from '@rezics/ui/content-actions';
import * as toasts from '@rezics/ui/undo-toast';
import { documentText } from '@rezics/document';
import type { ThreadPost } from '../src/threads/reads';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import owned from '../src/kernel/recorded/thread-owned.json';
import ownedPosts from '../src/kernel/recorded/thread-owned-posts.json';
import { m } from '../src/paraglide/messages.js';
import { findExistingReview } from '../src/threads/post-writes';
import { RemovedPost } from '../src/threads/post-removed';

mock.module('cloudflare:workers', () => ({ env: {} }));
const actions = await import('../src/threads/actions');
const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
const originalContentActions = contentActions.ContentActions;
afterEach(() => mock.restore());

const original = ownedPosts.posts[0] as ThreadPost;
const deadline = '2026-11-23T03:04:05.000Z';
const tombstone: ThreadPost = {
  id: original.id,
  threadId: original.threadId,
  route: original.route,
  parentId: original.parentId,
  availability: 'erased',
  removed: true,
  body: null,
  sha256: null,
  restorableUntil: deadline,
};
function currentPage(post: ThreadPost): ThreadReadingPage {
  return {
    thread: { ...owned.thread, title: null, firstPost: post } as ThreadReadingPage['thread'],
    posts: { posts: [post], next: null, reactionsAsOf: null },
    authors: null,
    viewerId: owned.thread.authorId,
    mentions: {},
    subjects: [],
    provenanceSubjects: [],
    verification: { sitekey: '', scriptUrl: '' },
    now: '2026-10-24T03:04:05.000Z',
  };
}

// Render the real post, then invoke the same delete and toast callbacks its controls receive.
// No DOM, native service or replacement restore implementation is involved.
async function controls(refresh: () => Promise<ThreadReadingPage | undefined>) {
  let remove: (() => Promise<void>) | undefined;
  let undo: (() => void) | undefined;
  const changes: ThreadPost[] = [];
  spyOn(contentActions, 'ContentActions').mockImplementation((props) => {
    remove = props.onDelete;
    return createElement(originalContentActions, props);
  });
  spyOn(toasts, 'undoToast').mockImplementation((_message, action) => {
    undo = action;
    return '';
  });
  const region = createElement(ThreadReadingPost, {
    post: original,
    authors: null,
    mentions: {},
    now: '2026-10-24T00:00:00.000Z',
    viewerId: owned.thread.authorId,
    personalReady: true,
    signedIn: true,
    onChange: (post) => changes.push(post),
    anchorId: `post-${original.id}`,
    target: { kind: 'thread', id: owned.thread.id },
    counts: {},
    value: null,
    returnTo: '/',
    verification: { sitekey: '', scriptUrl: '' },
    onMutation: async () => {},
    onPageRefresh: refresh,
    onOpeningPostChange: () => {},
    replyParents: new Map(),
    replyPending: false,
    onReply: () => {},
    subjects: [],
    currentVote: undefined,
    review: false,
  });
  const route = createRootRoute({ component: () => region });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
  );
  return {
    changes,
    delete: async () => {
      expect(remove).toBeDefined();
      await remove!();
    },
    undo: async () => {
      expect(undo).toBeDefined();
      undo!();
      // The toast callback intentionally returns void. Flush its bounded promise chain.
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    },
  };
}

function removedMarkup(post: ThreadPost, extra: Partial<ComponentProps<typeof RemovedPost>> = {}) {
  return renderToStaticMarkup(
    createElement(RemovedPost, {
      post,
      authors: null,
      now: '2026-10-24T00:00:00.000Z',
      viewerId: owned.thread.authorId,
      anchorId: `post-${post.id}`,
      itemRef: null,
      menuButton: null,
      onCopyLink: () => {},
      ...extra,
    }),
  );
}

test('Undo uses current native body and deadline, never a stale local snapshot as disclosure permission', async () => {
  for (const outcome of ['withheld', 'erased', 'missing', 'denied', 'source-unavailable'] as const) {
    spyOn(actions, 'erasePost').mockResolvedValue({ ok: true });
    spyOn(actions, 'restorePost').mockResolvedValue({ ok: true });
    let reads = 0;
    let disclosed: ThreadPost | undefined;
    const ui = await controls(async () => {
      reads++;
      if (reads === 1) return currentPage(tombstone);
      if (outcome === 'denied' || outcome === 'source-unavailable') throw new Error(outcome);
      if (outcome === 'missing')
        return { ...currentPage(tombstone), posts: { ...currentPage(tombstone).posts, posts: [] } };
      disclosed =
        outcome === 'erased'
          ? tombstone
          : {
              ...original,
              availability: 'withheld',
              removed: true,
              body: null,
              sha256: null,
            };
      return currentPage(disclosed);
    });
    await ui.delete();
    await ui.undo();
    expect(reads).toBe(2);
    expect(ui.changes).toHaveLength(1);
    expect(ui.changes[0]?.body).toBeNull();
    expect(ui.changes[0]?.sha256).toBeNull();
    if (disclosed) {
      const html = removedMarkup(disclosed);
      if (original.availability === 'available') {
        for (const text of documentText(original.body).split('\n').filter(Boolean)) expect(html).not.toContain(text);
      }
    }
    mock.restore();
  }
});

test('delete 204 keeps a byte-free tombstone and reads the native deadline despite a fake browser clock', async () => {
  spyOn(Date, 'now').mockReturnValue(Date.parse('2035-01-01T00:00:00Z'));
  spyOn(actions, 'erasePost').mockResolvedValue({ ok: true });
  let reads = 0;
  const ui = await controls(async () => {
    reads++;
    return currentPage(tombstone);
  });
  await ui.delete();
  expect(reads).toBe(1);
  expect(ui.changes[0]).not.toHaveProperty('restorableUntil');
  expect(ui.changes[0]).not.toHaveProperty('authorId');
  expect(ui.changes[0]).not.toHaveProperty('mediaIds');
  expect(currentPage(tombstone).posts.posts[0]).toHaveProperty('restorableUntil', deadline);
  const unknown = removedMarkup(ui.changes[0]!, { deadlineUnknown: true, onRestore: () => {} });
  expect(unknown).toContain(m.thread_post_restore_deadline_unknown());
  expect(unknown).not.toContain('<time');
});

test('a known restore 204 followed by a failed read retries the read without repeating the write', async () => {
  spyOn(actions, 'erasePost').mockResolvedValue({ ok: true });
  const restore = spyOn(actions, 'restorePost').mockResolvedValue({ ok: true });
  let reads = 0;
  const ui = await controls(async () => {
    if (++reads === 1) return currentPage(tombstone);
    throw new Error('Current source unavailable');
  });
  await ui.delete();
  await ui.undo();
  await ui.undo();
  expect(reads).toBe(3);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(ui.changes.every((post) => post.body === null)).toBe(true);
  const html = removedMarkup(tombstone, {
    restored: true,
    restoreError: m.thread_post_restore_read_failure(),
    onRefresh: () => {},
  });
  expect(html).toContain(m.thread_post_restore_read_failure());
  expect(html).toContain(m.thread_post_refresh());
  expect(html).not.toContain(m.thread_post_deleted());
});

test('an uncertain restore checks current eligibility and reuses its original key', async () => {
  spyOn(actions, 'erasePost').mockResolvedValue({ ok: true });
  const restore = spyOn(actions, 'restorePost')
    .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    .mockResolvedValueOnce({ ok: true });
  let reads = 0;
  const ui = await controls(async () => {
    reads++;
    return currentPage(tombstone);
  });
  await ui.delete();
  await ui.undo();
  await ui.undo();
  expect(reads).toBe(3);
  expect(restore).toHaveBeenCalledTimes(2);
  expect(restore.mock.calls[1]?.[0].data.idempotencyKey).toBe(restore.mock.calls[0]?.[0].data.idempotencyKey);
  expect(ui.changes.every((post) => post.body === null)).toBe(true);
});

test('only a real optional native review hint produces the ordinary existing-review link', () => {
  for (const problem of [
    {},
    { existingReviewId: owned.thread.id },
    { existingThreadId: 'unknown' },
    { existingThreadId: owned.thread.id },
  ]) {
    const existingReviewId = findExistingReview(problem);
    const html = removedMarkup(tombstone, { restoreError: m.thread_post_restore_conflict(), existingReviewId });
    expect(html.includes(`/threads/${owned.thread.id}`)).toBe(
      'existingThreadId' in problem && problem.existingThreadId === owned.thread.id,
    );
    expect(html).not.toContain('A newer review took this slot');
  }
});
