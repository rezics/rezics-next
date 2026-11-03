import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { BoardCommunity } = await import('../src/threads/board-community');
import boardRecording from '../src/kernel/recorded/board.json';
import threadRecording from '../src/kernel/recorded/board-threads.json';
import accountsRecording from '../src/kernel/recorded/accounts.json';

const root = join(import.meta.dir, '../src');
const board = await readFile(join(root, 'routes/boards/$id.tsx'), 'utf8');
const thread = await readFile(join(root, 'routes/threads/$id_.$slug.tsx'), 'utf8');
const threadCaller = await readFile(join(root, 'threads/thread-page-caller.tsx'), 'utf8');
const community = await readFile(join(root, 'threads/board-community.tsx'), 'utf8');
const feed = await readFile(join(root, 'threads/board-feed.tsx'), 'utf8');
const reading = await readFile(join(root, 'threads/thread-reading.tsx'), 'utf8');
const shell = await readFile(join(root, 'shell/shell.tsx'), 'utf8');

test('board and thread titles use the shared page heading size, not the display size', () => {
  expect(board).toContain('<BoardCommunity');
  expect(community).toMatch(/<PageHeading\b[^>]*>\{title\}<\/PageHeading>/);
  expect(thread).toContain('{title ? <PageHeading>{title}</PageHeading> : null}');
  expect(thread).toContain('renderHeader={(title, visiblePage) => (');
  expect(thread).toContain('<ThreadReadingHeader');
  expect(thread).toContain('boardReadingHref(boardReturn)');
  for (const source of [board, thread, community]) expect(source).not.toMatch(/text-5xl|text-6xl/);
});

test('a post shows edited only when it was revised after it was published', () => {
  expect(thread).toMatch(
    /post\.revisedAt\s*&&\s*new Date\(post\.revisedAt\)\.getTime\(\)\s*>\s*new Date\(post\.createdAt\)\.getTime\(\)/,
  );
});

test('the actual board feed uses heading-style titles and the available opening words for an untitled thread', async () => {
  const original = threadRecording.threads[0]!;
  const row = {
    ...original,
    title: null,
    firstPost: { ...original.firstPost, body: fromPlainText('The first words of this discussion.', 'blocks') },
  };
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path === `/v1/boards/${boardRecording.board.id}`) return Response.json(boardRecording);
      if (path === `/v1/boards/${boardRecording.board.id}/threads`)
        return Response.json({ threads: [row], next: null });
      if (path === '/v1/accounts') return Response.json(accountsRecording);
      throw new Error(`Unexpected board read: ${path}`);
    },
  });
  const page = await loadBoardPageWithAuthors(client, { id: boardRecording.board.id });
  const route = createRootRoute({ component: () => createElement(BoardCommunity, { page, sort: 'new' }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html).toMatch(/<h1\b[^>]*>Stories of the little prince<\/h1>/);
  expect(html).toMatch(/<h3\b[^>]*>The first words of this discussion\.<\/h3>/);
  expect(html).toMatch(/<h3\b(?=[^>]*data-content-item-slot="title")(?=[^>]*data-slot="board-feed-card")[^>]*>/u);
  expect(html).toContain(`href="/en/threads/${row.id}/thread"`);
  expect(html).not.toContain('Letters from B-612');
  expect(paths).toEqual([
    `/v1/boards/${boardRecording.board.id}`,
    `/v1/boards/${boardRecording.board.id}/threads`,
    '/v1/accounts',
  ]);
});

test('scrolling a thread at 390 shows the shell header once, at the top of the viewport', () => {
  expect(shell.match(/<header className="sticky top-0/g)).toHaveLength(1);
  expect(shell).toContain('sticky top-0');
});

test('each route has one initial page source; an explicit thread refresh preserves the current cursor and credentials', () => {
  const boardLoader = board.slice(board.indexOf('loader: async'), board.indexOf('head:'));
  const threadLoader = thread.slice(thread.indexOf('loader: async'), thread.indexOf('head:'));
  const refresh = thread.slice(
    thread.indexOf('async function refreshThreadPage('),
    thread.indexOf('function SharePost'),
  );
  expect(boardLoader.match(/boardPageQuery\(/g)).toHaveLength(1);
  expect(boardLoader).toContain('ensureQueryData(');
  expect(boardLoader).toContain('boardPageQuery(params.id, deps.cursor, deps.sort, context.credentialMode)');
  expect(threadLoader.match(/threadPageQuery\(/g)).toHaveLength(1);
  expect(threadLoader).toContain('runThreadPageQuery(context.queryClient, caller, query');
  expect(threadLoader).toContain('context.queryClient.ensureQueryData(guarded)');
  expect(threadCaller).toContain('const original = query.queryFn');
  expect(threadCaller).toContain('const value = await original(context)');
  expect(threadCaller).toContain('caller.finishQuery(query.queryKey, result, before, beforeTerminalRevision)');
  expect(thread.match(/threadPersonalQuery\(/g)).toHaveLength(1);
  expect(thread).toMatch(/enabled:\s*session === 'signed-in'/);
  expect(refresh.match(/threadPageQuery\(/g)).toHaveLength(1);
  expect(refresh).toContain('queryClient.fetchQuery(');
  expect(refresh).toContain("const mode = session === 'signed-in' ? 'session' : 'anonymous'");
  expect(refresh).toContain('threadPageQuery(id, cursor, mode, undefined, post)');
  expect(refresh).toContain('staleTime: 0');
  expect(refresh).toContain('onPageRefresh={refreshThreadPage}');
  expect(reading).toContain('threadLocation(getLocale(), { id: thread.id, title: displayTitle }, posts.next)');
  expect(reading).not.toMatch(/\b(?:useQuery|fetchQuery|readThreadPage)\(/);
});

test('the Board feed keeps its continuation route-owned and performs no per-card HTTP', () => {
  expect(board).toContain('<BoardCommunity');
  expect(community).toContain('<BoardFeed');
  expect(feed).toContain('search={{ cursor: ordinary.next,');
  expect(feed).not.toMatch(/\b(?:fetch|useQuery|useInfiniteQuery|kernelClient)\(/);
  expect(feed).not.toMatch(/divide-y|border-y/);
});

test('Page reading journeys explicitly bind the shared selected and cancelled parent plays', async () => {
  const pages = await readFile(join(root, 'stories/thread-reading.stories.tsx'), 'utf8');
  for (const state of ['SelectedParent', 'CancelledParent']) {
    const story = pages.split(`export const ${state}: Story = `)[1]?.split('export const ')[0];
    expect(story).toContain(`...Reading.${state}`);
    expect(story).toContain(`play: async (context) => Reading.${state}.play!(context)`);
  }
  expect(pages).toContain('args: { shell: true }');
});
