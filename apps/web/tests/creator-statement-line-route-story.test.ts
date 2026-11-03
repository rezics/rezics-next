import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  creatorLineFixture,
  creatorStatementFixture,
  paidCreatorStatementFixture,
  routes,
  selectCreatorStatementStory,
} from '../src/kernel/fake/creator-statements';
import type { KernelRecording } from '../src/kernel/fake';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { loadCreatorStatement } = await import('../src/checkout/creator-statements');
const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');
const { m } = await import('../src/paraglide/messages.js');

const laterCursor = 'story-lines-next';
const listFrom = 'story-statements-next';
const request = () =>
  new Request('https://site.test/en/creator/statements', { headers: { authorization: 'Bearer exact-current-viewer' } });

async function answer(path: string): Promise<KernelRecording | undefined> {
  const route = routes[0]!;
  const url = new URL(path, 'https://kernel.test');
  if (typeof route.path === 'string') return;
  route.path.lastIndex = 0;
  const match = route.path.exec(url.pathname);
  if (!match) return;
  return route.story?.({ request: new Request(url), match, recordings: {} }) ?? undefined;
}

function client() {
  return createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      const recording = await answer(`${new URL(call.url).pathname}${new URL(call.url).search}`);
      if (!recording) return new Response(null, { status: 404 });
      const { status, ...body } = recording;
      return Response.json(body, { status });
    }) as typeof fetch,
  });
}

async function html(page: ReactElement): Promise<string> {
  const root = createRootRoute({ component: () => page });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('later line stale and empty keep the admitted paid statement while global point refusal stays refused', async () => {
  try {
    selectCreatorStatementStory('stale');
    expect(await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}`)).toEqual({
      status: 409,
      code: 'stale_cursor',
    });
    expect(await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}/lines?cursor=${laterCursor}`)).toEqual({
      status: 409,
      code: 'stale_cursor',
    });

    selectCreatorStatementStory('later-stale-lines');
    expect(await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}`)).toEqual({
      status: 200,
      statement: paidCreatorStatementFixture,
    });
    const firstLines = await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}/lines`);
    expect(firstLines).toMatchObject({
      status: 200,
      next: laterCursor,
      lines: [{ balanceTransactionId: creatorLineFixture.balanceTransactionId }],
    });
    expect(await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}/lines?cursor=${laterCursor}`)).toEqual({
      status: 409,
      code: 'stale_cursor',
    });
    const stalePage = await loadCreatorStatement(client(), request(), {}, {
      id: paidCreatorStatementFixture.id,
      cursor: laterCursor,
    });
    expect(stalePage).toEqual({
      kind: 'ready',
      statement: paidCreatorStatementFixture,
      lines: { kind: 'stale' },
    });
    const staleHtml = await html(
      createElement(CreatorStatementPage, {
        page: stalePage,
        id: paidCreatorStatementFixture.id,
        locale: 'en',
        cursor: laterCursor,
        from: listFrom,
      }),
    );
    expect(staleHtml).toContain(paidCreatorStatementFixture.id);
    expect(staleHtml).toContain(paidCreatorStatementFixture.paidReference);
    expect(staleHtml).toContain('$6.75');
    expect(staleHtml).toContain(m.statements_stale());
    expect(staleHtml).toContain(
      `href="/en/creator/statements/${paidCreatorStatementFixture.id}?from=${encodeURIComponent(listFrom)}"`,
    );
    expect(staleHtml).not.toContain(m.statements_lines_empty());

    selectCreatorStatementStory('later-empty-lines');
    expect(await answer('/v1/payoutStatements')).toMatchObject({
      status: 200,
      payoutStatements: [{ id: creatorStatementFixture.id }],
      next: listFrom,
    });
    expect(await answer(`/v1/payoutStatements?cursor=${listFrom}`)).toEqual({
      status: 200,
      payoutStatements: [paidCreatorStatementFixture],
      next: null,
    });
    expect(await answer(`/v1/payoutStatements/${paidCreatorStatementFixture.id}/lines?cursor=${laterCursor}`)).toEqual({
      status: 200,
      lines: [],
      next: null,
    });
    const emptyPage = await loadCreatorStatement(client(), request(), {}, {
      id: paidCreatorStatementFixture.id,
      cursor: laterCursor,
    });
    expect(emptyPage).toEqual({
      kind: 'ready',
      statement: paidCreatorStatementFixture,
      lines: { kind: 'ready', lines: [], next: null },
    });
    const emptyHtml = await html(
      createElement(CreatorStatementPage, {
        page: emptyPage,
        id: paidCreatorStatementFixture.id,
        locale: 'en',
        cursor: laterCursor,
        from: listFrom,
      }),
    );
    expect(emptyHtml).toContain(paidCreatorStatementFixture.paidReference);
    expect(emptyHtml).toContain('$6.75');
    expect(emptyHtml).toContain(m.statement_line_page_reader_page_empty());
    expect(emptyHtml).toContain(m.statements_lines_empty());
    expect(emptyHtml).not.toContain(m.statement_line_page_reader_first_empty());
    expect(emptyHtml).toContain(
      `href="/en/creator/statements/${paidCreatorStatementFixture.id}?from=${encodeURIComponent(listFrom)}"`,
    );

    selectCreatorStatementStory('lines-unavailable');
    expect(await loadCreatorStatement(client(), request(), {}, { id: paidCreatorStatementFixture.id })).toEqual({
      kind: 'ready',
      statement: paidCreatorStatementFixture,
      lines: { kind: 'unavailable' },
    });
  } finally {
    selectCreatorStatementStory('creator');
  }
});

test('detail page stories map later line recovery through PageStory without rewriting point refusal', () => {
  const story = readFileSync(new URL('../src/stories/creator-statement.stories.tsx', import.meta.url), 'utf8');
  expect(story).toContain('<PageStory visitor="Signed In" path={`/creator/statements/${id}${search}`} />');
  expect(story).toContain("render('later-stale-lines', paidCreatorStatementFixture.id, laterLineSearch)");
  expect(story).toContain("render('later-empty-lines', paidCreatorStatementFixture.id, laterLineSearch)");
  expect(story).toContain("cursor=story-lines-next&from=story-statements-next");
  expect(story).toContain("export const Stale: Story = { render: () => render('stale'), play: stateReady(m.statements_stale) }");
  expect(story).toContain("render('denied')");
  expect(story).toContain("render('unavailable')");
  expect(story).toContain("render('lines-unavailable')");
});
