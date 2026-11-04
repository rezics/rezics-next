import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import {
  boardOpeningExample,
  boardOpeningCard,
  boardOpeningId,
  boardOpeningCursor,
} from '../src/threads/board-opening-fixtures';
import { receiveBoardOpeningPage, boardOpeningReaction } from '../src/threads/board-opening';
import { ordinaryBoardThreads, boardThreadPreview } from '../src/threads/board-feed-data';
import { boardReadingHref, captureBoardReadingReturn, parseBoardReadingReturn } from '../src/threads/board-reading';
import { RealmParticipationView } from '../src/community/realm-participation';
import { setLocale, locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { BoardCommunity } = await import('../src/threads/board-community');

async function render(page: ReturnType<typeof receiveBoardOpeningPage>) {
  const route = createRootRoute({ component: () => createElement(BoardCommunity, { page, sort: 'hot' }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('the installed typed opening supplies five pins, twenty ordinary cards, context and rules in one request', async () => {
  const response = boardOpeningExample();
  const calls: Request[] = [];
  const page = await loadBoardPageWithAuthors(
    createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json(response);
      },
    }),
    { id: boardOpeningId, sort: 'hot' },
    'Bearer reader',
  );
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/boards/${boardOpeningId}/page`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer reader');
  expect(page.threads.pinnedThreads).toHaveLength(5);
  expect(page.threads.threads).toHaveLength(20);
  expect(Object.keys(page.authors)).toHaveLength(3);
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    const html = await render(page);
    expect((html.match(/data-thread-id=/g) ?? []).length).toBe(25);
    expect(html).toContain('Mark spoilers. Respect other readers.');
    expect(html).toContain('Readers');
    expect(html).not.toContain('<output'); // No missing native reaction map becomes zero votes.
  }
  setLocale('en', { reload: false });
});

test('concealed and overlapping pins, unavailable authors and optional context never gain a fallback identity', async () => {
  const response = boardOpeningExample('concealed');
  // A later card discloses the same author; the withheld card must retain its own unavailable projection.
  response.threads[1]!.authors = boardOpeningCard(5).authors;
  const page = receiveBoardOpeningPage(response);
  expect(ordinaryBoardThreads(page.threads).threads).toHaveLength(20);
  const html = await render(page);
  expect((html.match(/data-thread-id=/g) ?? []).length).toBe(24);
  expect(html).not.toContain('Discussion 0');
  expect(html).toContain(m.thread_author_unknown());
  expect(html).toContain(m.board_community_source_unavailable());
  expect(html).not.toContain(m.board_community_global());
});

test('zero, unknown, lower bounds and denied advice keep their meaning at the mounted action port', async () => {
  const response = boardOpeningExample('interactions');
  const html = await render(receiveBoardOpeningPage(response));
  expect(html).toContain(`${m.feed_action_reply()} 0`);
  expect(html).toContain(`${m.feed_action_reply()} 4+`);
  expect(html).toContain(m.feed_action_votes_unavailable());
  expect((html.match(/<output/g) ?? []).length).toBe(1);
  const card = response.pinnedThreads[0]!;
  card.actions.react = 'denied';
  card.actions.reply = 'denied';
  const origin = { key: 'visit', isCurrent: () => true };
  const reaction = boardOpeningReaction(card, true, origin);
  expect(reaction.target).toEqual(card.interaction.target);
  expect(reaction.personalReady).toBe(false);
  expect(reaction.settleWithRead).toBe(false);
  expect(reaction.signInAllowed).toBe(false);
  const denied = await render(receiveBoardOpeningPage(boardOpeningExample('denied')));
  expect(denied).not.toContain('#reply');
  expect(denied).not.toContain(`return_to=${encodeURIComponent('/en/threads/')}`);
});

test('same-input retry, all native sorts, sparse continuation, exhaustion and explicit invalid-cursor restart', async () => {
  for (const sort of ['active', 'hot', 'new'] as const) {
    const calls: URL[] = [];
    let failures = 1;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        calls.push(url);
        if (failures-- > 0) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
        if (url.searchParams.get('cursor') === 'obsolete')
          return Response.json({ code: 'invalid_cursor' }, { status: 400 });
        const response = boardOpeningExample('sparse');
        if (url.searchParams.has('cursor')) response.next = null;
        return Response.json(response);
      },
    });
    const input = { id: boardOpeningId, ...(sort === 'active' ? {} : { sort }), cursor: boardOpeningCursor };
    await expect(loadBoardPageWithAuthors(client, input)).rejects.toThrow();
    const terminal = await loadBoardPageWithAuthors(client, input);
    expect(calls[0]!.href).toBe(calls[1]!.href);
    expect(calls[1]!.searchParams.get('sort')).toBe(sort);
    expect(terminal.threads.next).toBeNull();
    expect(terminal.threads.pinnedThreads).toEqual([]);
    await expect(loadBoardPageWithAuthors(client, { ...input, cursor: 'obsolete' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    const first = await loadBoardPageWithAuthors(client, {
      id: boardOpeningId,
      ...(sort === 'active' ? {} : { sort }),
    });
    expect(first.threads.next).toBe(boardOpeningCursor);
    const html = await render(first);
    expect(html).toContain(m.board_threads_page_empty());
    expect(html).not.toContain(m.board_threads_empty());
  }
});

test('advice does not invent Realm visibility or skip the membership owner', () => {
  const show = (state: 'none' | 'member', admittedAction?: 'join' | 'leave') =>
    renderToStaticMarkup(
      createElement(RealmParticipationView, {
        state,
        visibility: 'unknown',
        admittedAction,
        onChange() {},
        onRetry() {},
      }),
    );
  expect(show('none')).not.toContain(m.realm_join());
  expect(show('none', 'join')).toContain(m.realm_join());
  expect(show('member', 'leave')).toContain(m.realm_leave());
  expect(show('member', 'leave')).not.toContain('data-visibility="protected"');
});

test('a Board-to-thread return retains only its bounded source and surviving-row focus', () => {
  const reading = captureBoardReadingReturn({
    boardId: boardOpeningId,
    sort: 'hot',
    locale: 'de',
    cursor: boardOpeningCursor,
    focusThreadId: boardOpeningCard(8).thread.id,
  })!;
  expect(parseBoardReadingReturn(reading)).toEqual(reading);
  const href = new URL(boardReadingHref(reading), 'https://site.test');
  expect(href.searchParams.get('cursor')).toBe(boardOpeningCursor);
  expect(href.hash).toBe(`#board-thread-${reading.focusThreadId}`);
  expect(captureBoardReadingReturn({ ...reading, cursor: 'x'.repeat(4097) })?.cursor).toBeUndefined();
  const card = boardOpeningCard(1);
  if (card.thread.firstPost.availability !== 'available') throw new Error('Expected opening');
  card.thread = {
    ...card.thread,
    firstPost: {
      ...card.thread.firstPost,
      body: {
        version: 'rezics-document-v1',
        profile: 'blocks',
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hidden ending', marks: [{ type: 'spoiler' }] }] },
          ],
        },
      },
    },
  };
  expect(boardThreadPreview(card.thread)).toBeNull();
  expect(boardThreadPreview(card.thread, true)).toBe('Hidden ending');
});

test('consumer request, response and retained-page work follows selected cohorts, independent of unrelated prepared rows', async () => {
  const samples: object[] = [];
  for (const rows of [1, 10, 25]) {
    const response = boardOpeningExample('current', rows);
    const bytes = new TextEncoder().encode(JSON.stringify(response)).length;
    for (const unrelatedBoardRows of [256, 1024, 4096]) {
      let requests = 0;
      const client = createKernelClient('https://kernel.test', {
        fetch: async () => {
          requests++;
          return Response.json(response);
        },
      });
      const page = await loadBoardPageWithAuthors(client, { id: boardOpeningId });
      const retainedRows = Object.keys(page.openingCards).length;
      expect([requests, retainedRows]).toEqual([1, rows]);
      samples.push({ rows, unrelatedBoardRows, requests, bytes, retainedRows });
    }
  }
  // Prepared consumer measurements only. No source-side query, pool or physical-growth claim.
  console.info('Board opening consumer samples', JSON.stringify(samples));
});
