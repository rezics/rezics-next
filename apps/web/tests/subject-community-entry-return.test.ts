import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GLOBAL } from '../src/features/pages/subject-ratings';
import {
  communityBoardHref,
  communityRegionAnchor,
  communityRegionReturnTo,
} from '../src/features/pages/subject-community-navigation';
import type { CommunityRegion } from '../src/features/pages/subject-community';
import { subjectCommunityVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { threadCreationPreset } from '../src/threads/thread-creation-lifetime';

const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const realmId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const boardId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e6';
const cursor = 'opaque:/+?=&版%';

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
