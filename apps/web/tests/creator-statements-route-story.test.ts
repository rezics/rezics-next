import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { CreatorStatement } from '../src/checkout/creator-statements';
import { CreatorStatementsPage } from '../src/checkout/creator-statements-page';
import {
  creatorStatementFixture,
  paidCreatorStatementFixture,
  routes,
  selectCreatorStatementStory,
} from '../src/kernel/fake/creator-statements';
import { m } from '../src/paraglide/messages.js';

const story = readFileSync(new URL('../src/stories/creator-statements.stories.tsx', import.meta.url), 'utf8');
const listPath = /^\/v1\/payoutStatements(?:\/([^/]+)(\/lines)?)?$/;

async function list(url: string) {
  const request = new Request(url);
  return routes[0]!.story!({
    request,
    match: listPath.exec(new URL(url).pathname),
    recordings: {},
  });
}

async function render(page: ReactElement) {
  const root = createRootRoute({ component: () => page });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('A later empty creator statement page keeps the actual route, first-page recovery and no-visible wording', async () => {
  expect(story).toContain('<PageStory visitor="Signed In" path="/creator/statements" />');
  expect(story).toContain('export const InspectAndBack: Story =');
  expect(story).toContain("render: () => render('later-empty')");
  expect(story).toContain("click(view.getByRole('link', { name: m.statements_next() }))");
  expect(story).toContain('m.statements_page_empty()');
  expect(story).toContain('m.statements_empty()');
  expect(story).toContain('click(restart)');
  expect(story).toContain('constructed presentation responses');
  expect(story).toContain('do not establish native authorization');

  selectCreatorStatementStory('later-empty');
  try {
    const first = (await list('https://kernel.test/v1/payoutStatements')) as {
      status: number;
      payoutStatements: CreatorStatement[];
      next: string | null;
    };
    const later = await list('https://kernel.test/v1/payoutStatements?cursor=story-statements-next');
    expect(first.status).toBe(200);
    expect(first.payoutStatements).toHaveLength(2);
    expect(first.payoutStatements[0]).toEqual(creatorStatementFixture);
    expect(first.payoutStatements[1]?.currency).toBe('eur');
    expect(first.next).toBe('story-statements-next');
    expect(later).toEqual({ status: 200, payoutStatements: [], next: 'story-statements-later' });
    const laterHtml = await render(
      createElement(CreatorStatementsPage, {
        locale: 'en',
        cursor: 'story-statements-next',
        page: { kind: 'ready', payoutStatements: [], next: 'story-statements-later' },
      }),
    );
    const firstHtml = await render(
      createElement(CreatorStatementsPage, {
        locale: 'en',
        page: { kind: 'ready', payoutStatements: first.payoutStatements, next: first.next },
      }),
    );
    expect(firstHtml).toContain('-$3.15');
    expect(firstHtml).toContain(m.statements_next());
    expect(firstHtml).not.toContain(m.statements_page_empty());
    expect(firstHtml).not.toContain(m.statements_restart());
    expect(laterHtml).toContain(m.statements_page_empty());
    expect(laterHtml).not.toContain(m.statements_empty());
    expect(laterHtml).toContain(m.statements_restart());
    expect(laterHtml).toContain(m.statements_next());
    expect(laterHtml).toContain('cursor=story-statements-later');
    expect(laterHtml).not.toContain('href="/creator/statements?cursor=story-statements-next"');
  } finally {
    selectCreatorStatementStory('creator');
  }

  const populated = await list('https://kernel.test/v1/payoutStatements?cursor=story-statements-next');
  expect(populated).toEqual({
    status: 200,
    payoutStatements: [paidCreatorStatementFixture],
    next: null,
  });
});
