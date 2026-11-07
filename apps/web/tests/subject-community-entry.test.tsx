import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { SubjectCommunityRegion } = await import('../src/features/pages/subject-community-view');
const { composedCommunityRegion } = await import('../src/features/pages/subject-community');
const { GLOBAL } = await import('../src/features/pages/subject-ratings');
const { communityCurrentEntry, communitySubject, communityThread, communityThreadPage } =
  await import('../src/kernel/fake/subject-community');
const { m } = await import('../src/paraglide/messages.js');

test('hydrated Subject creation follows native entry.current Board, not a card boardId', async () => {
  const thread = communityThread('review');
  const entry = communityCurrentEntry('review', communitySubject);
  const expected = {
    kind: 'subjectThreads' as const,
    id: communitySubject.id,
    place: GLOBAL,
    threadKind: 'review' as const,
    board: entry.board.id,
    limit: 20,
  };
  const region = composedCommunityRegion(
    { status: 200, body: communityThreadPage('review', communitySubject, [thread], null, GLOBAL, entry) },
    expected,
  );
  const root = createRootRoute({
    component: () =>
      createElement(SubjectCommunityRegion, {
        id: 'reviews',
        kind: 'review',
        region,
        authors: {},
        now: '2026-10-24T00:00:00.000Z',
        subject: communitySubject,
        locale: 'en',
        href: '/en/subjects/subject/reviews',
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html).toContain('data-slot="community-entry-start"');
  expect(html).toContain(m.subject_community_review());
  expect(html).toContain(entry.board.id);
  expect(html).not.toContain(`/boards/${thread.boardId}/new`);
  expect(html).not.toContain('data-slot="create-thread"');
});
