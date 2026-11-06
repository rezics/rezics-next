import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router';
import { GLOBAL } from '../src/features/pages/subject-ratings';
import {
  communityBoardHref,
  communityRegionAnchor,
  communityRegionReturnTo,
} from '../src/features/pages/subject-community-navigation';
import type { CommunityRegion } from '../src/features/pages/subject-community';
import { subjectCommunityVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { threadCreationPreset } from '../src/threads/thread-creation-lifetime';
import type { CommunityEntry, CommunityThread, SubjectCommunity } from '../src/features/pages/subject-community';
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
  const section = await mountedSection(mountedCommunity(paged), entry, paged);
  const href = section.match(/href="([^"]*\/boards\/[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  return href ? new URL(href, 'https://site.test').searchParams.get('returnTo') : null;
}

async function mountedSection(community: SubjectCommunity, entry: string, paged: boolean): Promise<string> {
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
  return /<section id="subject-community-threads"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
}

test('the creation entry renders each native state distinctly and offers the composer only for allowed advice', async () => {
  const entry = `/en/subjects/${subjectId}/book?realm=${realmId}`;
  const composer = `/en/boards/${boardId}/new`;
  const options = { locale: 'en' } as const;
  const render = async (creation?: CommunityEntry) => {
    const community = mountedCommunity(false);
    const region = community.regions.discussion;
    if (region?.state !== 'ready') throw new Error('Expected a ready region');
    const next = { ...region, ...(creation ? { entry: creation } : {}) };
    return mountedSection({ ...community, regions: { discussion: next }, nodes: { threads: next } }, entry, false);
  };
  const current = (action: 'allowed' | 'denied' | 'sign-in' | 'unavailable'): CommunityEntry => ({
    state: 'current',
    board: { id: boardId, title: 'Discussions' },
    action,
  });

  const none = await render();
  expect(none).not.toContain('data-slot="community-entry"');

  const allowed = await render(current('allowed'));
  const link = /data-slot="community-entry-start"[^>]*href="([^"]+)"/.exec(allowed)?.[1]?.replaceAll('&amp;', '&');
  expect(link).toBeDefined();
  expect(new URL(link!, 'https://site.test').pathname).toBe(composer);
  expect(new URL(link!, 'https://site.test').searchParams.get('subject')).toBe(subjectId);
  expect(new URL(link!, 'https://site.test').searchParams.get('returnTo')).toBeTruthy();

  const signIn = await render(current('sign-in'));
  expect(signIn).toContain(`/auth/sign-in?return_to=${encodeURIComponent(link!)}`);
  expect(signIn).not.toContain('data-slot="community-entry-start"');

  const denied = await render(current('denied'));
  expect(denied).toContain(m.subject_community_entry_denied({}, options));
  expect(denied).not.toContain('data-slot="community-entry-start"');

  const concealed = await render({ state: 'concealed' });
  expect(concealed).toContain('data-state="concealed"');
  expect(concealed).toContain(m.subject_community_entry_concealed({}, options));
  expect(concealed).not.toContain(composer);

  const unavailable = await render({ state: 'unavailable' });
  expect(unavailable).toContain('data-state="unavailable"');
  expect(unavailable).toContain(m.subject_section_retry({}, options));
  expect(unavailable).not.toContain(composer);
});

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
  const currentHref = `/en/subjects/${subjectId}/book/reviews?realm=${realmId}&board=${boardId}&cursor=old&node=old`;
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
    `/en/subjects/${subjectId}/book/reviews?realm=${realmId}&board=${boardId}&cursor=${encodeURIComponent(cursor)}&node=review-list#subject-community-review-list`,
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
  expect(await mountedReturn(`${base}?realm=${realmId}&board=${boardId}`, false)).toBe(
    `${base}?realm=${realmId}&board=${boardId}#subject-community-threads`,
  );
  expect(subjectCommunityVisitReturn(`${base}?board=not-a-board#subject-community-threads`, 'en')).toBeUndefined();

  const expected = new URL(`${base}/discussion`, 'https://site.test');
  expected.searchParams.set('realm', realmId);
  expected.searchParams.set('board', boardId);
  expected.searchParams.set('cursor', cursor);
  expected.searchParams.set('node', 'threads');
  expected.hash = 'subject-community-threads';
  expect(
    await mountedReturn(
      `${base}/discussion?realm=${realmId}&board=${boardId}&cursor=route-cursor&node=route-node`,
      true,
    ),
  ).toBe(`${expected.pathname}${expected.search}${expected.hash}`);
});

test('independent community list mounts need no router when Overview context is missing', () => {
  expect(renderToStaticMarkup(createElement(ReviewList, { id: 'reviews' }))).toBe('');
  expect(renderToStaticMarkup(createElement(ThreadList, { id: 'threads' }))).toBe('');
});

test('title-only invitation states the current empty state without inviting edits', () => {
  expect(m.subject_empty({}, { locale: 'en' })).toBe('This subject has only a title so far.');
});
