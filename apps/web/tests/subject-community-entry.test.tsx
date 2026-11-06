import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';

let session: { state: string; subject: string | null; csrfToken: string | null } = {
  state: 'signed-in',
  subject: 'current-person',
  csrfToken: 'csrf',
};
mock.module('../src/session/query', () => ({ useSession: () => session }));

const { SubjectCommunityRegion } = await import('../src/features/pages/subject-community-view');
const { composedCommunityRegion } = await import('../src/features/pages/subject-community');
const { GLOBAL } = await import('../src/features/pages/subject-ratings');
const { communityCurrentEntry, communitySubject, communityThread, communityThreadPage } = await import(
  '../src/kernel/fake/subject-community'
);
const { m } = await import('../src/paraglide/messages.js');

const expected = {
  kind: 'subjectThreads' as const,
  id: communitySubject.id,
  place: GLOBAL,
  threadKind: 'review' as const,
  limit: 20,
};

async function renderRegion(region: ReturnType<typeof composedCommunityRegion>) {
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
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test('hydrated Subject create-thread follows native entry.current Board, not a card boardId', async () => {
  const thread = communityThread('review');
  const entry = communityCurrentEntry('review', communitySubject);
  const region = composedCommunityRegion(
    { status: 200, body: communityThreadPage('review', communitySubject, [thread], null, GLOBAL, entry) },
    expected,
  );
  session = { state: 'signed-in', subject: 'current-person', csrfToken: 'csrf' };
  const html = await renderRegion(region);
  expect(html).toContain('data-slot="create-thread"');
  expect(html).toContain(m.board_start_thread());
  expect(html).toContain(entry.board.id);
  expect(html).not.toContain(`/boards/${thread.boardId}/new`);
  session = { state: 'unknown', subject: 'current-person', csrfToken: 'csrf' };
  expect(await renderRegion(region)).not.toContain('data-slot="create-thread"');
});
