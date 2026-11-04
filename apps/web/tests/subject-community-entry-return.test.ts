import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useLocation } from '@tanstack/react-router';
import { GLOBAL } from '../src/features/pages/subject-ratings';
import {
  communityBoardHref,
  communityRegionAnchor,
  communityRegionReturnTo,
} from '../src/features/pages/subject-community-navigation';
import type { CommunityRegion } from '../src/features/pages/subject-community';
import { subjectCommunityVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { threadCreationPreset } from '../src/threads/thread-creation-lifetime';
import type { CommunityThread, SubjectCommunity } from '../src/features/pages/subject-community';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const [{ PageData }, { ReviewList, ThreadList }, { SubjectCommunityContext }, { subjectPageMessages }] =
  await Promise.all([
    import('../src/features/pages/data'),
    import('../src/features/pages/overview'),
    import('../src/features/pages/subject-community-view'),
    import('../src/features/pages/route-support'),
  ]);
afterAll(() => mock.restore());

const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const realmId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const boardId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e6';
const threadId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e7';
const cursor = 'opaque:/+?=&版%';

function mountedCommunity(paged: boolean): SubjectCommunity {
  const region: CommunityRegion = {
    state: 'ready',
    threads: [
      {
        id: threadId,
        title: 'Mounted discussion',
        authorId: 'author-one',
        boardId,
        createdAt: '2026-11-05T00:00:00.000Z',
        summary: '',
        licence: 'CC BY',
      } satisfies CommunityThread,
    ],
    next: null,
    context: {
      subjectId,
      subjectLabel: 'Subject',
      place: { kind: 'realm', id: realmId, title: 'Realm', spaceId: realmId, headRevisionId: boardId },
    },
    reactionsAsOf: null,
    request: {
      kind: 'subjectThreads',
      id: subjectId,
      place: realmId,
      threadKind: 'discussion',
      limit: 20,
      ...(paged ? { cursor } : {}),
    },
  };
  return { regions: { discussion: region }, nodes: { threads: region }, authors: {}, now: '2026-11-05T00:00:00.000Z' };
}

async function mountedReturn(entry: string, paged: boolean): Promise<string | null> {
  const community = mountedCommunity(paged);
  function RoutedList() {
    const currentHref = useLocation().publicHref;
    return createElement(
      SubjectCommunityContext.Provider,
      { value: community },
      createElement(
        PageData,
        {
          locale: 'en',
          subject: subjectId,
          subjectLabel: 'Subject',
          realm: realmId,
          currentHref,
          document: { root: { props: {} }, content: [] } as never,
          reads: {},
          messages: subjectPageMessages(),
        },
        createElement(ThreadList, { id: 'threads', paged }),
      ),
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: RoutedList }),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  const section = /<section id="subject-community-threads"[\s\S]*?<\/section>/.exec(html)?.[0];
  const href = section?.match(/href="([^"]*\/boards\/[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  return href ? new URL(href, 'https://site.test').searchParams.get('returnTo') : null;
}

test('a Board visit and its composer keep the current Subject region return', async () => {
  const region: CommunityRegion = {
    state: 'ready',
    threads: [],
    next: null,
    context: {
      subjectId,
      subjectLabel: 'Subject',
      place: { kind: 'realm', id: realmId, title: 'Realm', spaceId: realmId, headRevisionId: boardId },
    },
    reactionsAsOf: null,
    request: {
      kind: 'subjectThreads',
      id: subjectId,
      place: realmId,
      threadKind: 'review',
      limit: 20,
      cursor,
    },
  };
  const currentHref = `/en/subjects/${subjectId}/book/reviews?realm=${realmId}&cursor=old&node=old`;
  const fullListHref = `/en/subjects/${subjectId}/book/reviews?realm=${realmId}`;
  const returnTo = communityRegionReturnTo({
    currentHref,
    locale: 'en',
    id: 'review-list',
    subjectId,
    kind: 'review',
    paged: true,
    node: 'review-list',
    region,
  });

  expect(returnTo).toBe(
    `/en/subjects/${subjectId}/book/reviews?realm=${realmId}&cursor=${encodeURIComponent(cursor)}&node=review-list#subject-community-review-list`,
  );
  expect(returnTo).not.toBe(fullListHref);
  expect(communityRegionAnchor('review-list')).toBe('subject-community-review-list');
  expect(communityRegionAnchor('../private')).toBeUndefined();

  const board = new URL(communityBoardHref('en', boardId, returnTo), 'https://site.test');
  expect(board.pathname).toBe(`/en/boards/${boardId}`);
  expect(subjectCommunityVisitReturn(board.searchParams.get('returnTo'), 'en')).toBe(returnTo);
  expect(threadCreationPreset({ returnTo }, 'en').returnTo).toBe(returnTo);
  expect(threadCreationPreset({ returnTo: 'https://outside.test/' }, 'en').returnTo).toBeUndefined();

  const globalRegion: CommunityRegion = {
    ...region,
    context: { ...region.context, place: { kind: 'global', id: GLOBAL } },
    request: {
      kind: 'subjectThreads',
      id: subjectId,
      place: GLOBAL,
      threadKind: 'review',
      limit: 20,
    },
  };
  const globalReturn = communityRegionReturnTo({
    currentHref: `/en/subjects/${subjectId}/book/reviews?realm=${realmId}`,
    locale: 'en',
    id: 'review-list',
    subjectId,
    kind: 'review',
    paged: false,
    region: globalRegion,
  });
  expect(globalReturn).toBe(`/en/subjects/${subjectId}/book/reviews#subject-community-review-list`);

  const boardReturnTo = `${board.pathname}${board.search}`;
  const { SignInPrompt } = await import('../src/threads/write-prompts');
  expect(renderToStaticMarkup(SignInPrompt({ returnTo: boardReturnTo, label: 'Sign in' }))).toContain(
    `href="/auth/sign-in?return_to=${encodeURIComponent(boardReturnTo)}"`,
  );
});

test('mounted overview and full-view routes retain their exact community return address', async () => {
  const base = `/en/subjects/${subjectId}/book`;
  expect(await mountedReturn(`${base}?realm=${realmId}`, false)).toBe(
    `${base}?realm=${realmId}#subject-community-threads`,
  );

  const expected = new URL(`${base}/discussion`, 'https://site.test');
  expected.searchParams.set('realm', realmId);
  expected.searchParams.set('cursor', cursor);
  expected.searchParams.set('node', 'threads');
  expected.hash = 'subject-community-threads';
  expect(
    await mountedReturn(`${base}/discussion?realm=${realmId}&cursor=route-cursor&node=route-node`, true),
  ).toBe(`${expected.pathname}${expected.search}${expected.hash}`);
});

test('independent community list mounts need no router when Overview context is missing', () => {
  expect(renderToStaticMarkup(createElement(ReviewList, { id: 'reviews' }))).toBe('');
  expect(renderToStaticMarkup(createElement(ThreadList, { id: 'threads' }))).toBe('');
});

test('title-only invitation states the current empty state without inviting edits', () => {
  expect(m.subject_empty({}, { locale: 'en' })).toBe('This subject has only a title so far.');
});
