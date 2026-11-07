import { expect, test } from 'bun:test';
import { composedCommunityRegion, type CommunityRequest } from '../src/features/pages/subject-community';
import { communityEntryHref } from '../src/features/pages/subject-community-navigation';
import { GLOBAL } from '../src/features/pages/subject-ratings';
import { threadCreationPreset } from '../src/threads/thread-creation-lifetime';

const subject = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const board = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const otherBoard = '01a17a3b-0884-721b-91ef-d7ffd7bb58e6';
const plain: CommunityRequest = { kind: 'subjectThreads', id: subject, place: GLOBAL, threadKind: 'discussion', limit: 5 };
const withBoard: CommunityRequest = { ...plain, board };
const context = {
  subject: { id: subject, label: null, source: { partition: 0, epoch: 1, position: '1' } },
  place: { kind: 'global', id: GLOBAL },
  kind: 'discussion',
};
const requestOf = (selectedBoardId?: string) => ({
  subjectId: subject,
  placeId: GLOBAL,
  kind: 'discussion',
  ...(selectedBoardId === undefined ? {} : { selectedBoardId }),
});
const page = (entry?: unknown) => ({
  status: 200,
  body: { threads: [], next: null, context, reactionsAsOf: null, ...(entry === undefined ? {} : { entry }) },
});
const current = (action: string) => ({
  state: 'current',
  request: requestOf(board),
  board: { id: board, title: 'Reviews', purpose: 'discussion' },
  actions: { createThread: action },
  observations: {},
});

test('a Subject region without a supplied Board is not_selected and offers no creation Board', () => {
  expect(composedCommunityRegion(page(), plain)).toMatchObject({ state: 'ready', entry: { state: 'not_selected' } });
  expect(
    composedCommunityRegion(page({ state: 'not_selected', request: requestOf() }), plain),
  ).toMatchObject({ state: 'ready', entry: { state: 'not_selected' } });
});

test('a supplied Board receives its exact current entry with allowed, denied, sign-in and unavailable advice distinct', () => {
  expect(composedCommunityRegion(page(current('allowed')), withBoard)).toMatchObject({
    state: 'ready',
    entry: { state: 'current', action: 'allowed', board: { id: board, title: 'Reviews' } },
  });
  for (const action of ['denied', 'sign-in', 'unavailable'])
    expect(composedCommunityRegion(page(current(action)), withBoard)).toMatchObject({
      state: 'ready',
      entry: { state: 'current', action },
    });
});

test('concealed and unavailable entries stay distinct from the no-Board answer', () => {
  for (const state of ['concealed', 'unavailable'])
    expect(composedCommunityRegion(page({ state, request: requestOf(board) }), withBoard)).toMatchObject({
      state: 'ready',
      entry: { state },
    });
});

test('the allowed entry link opens the composer with the exact Subject preset and regional return', () => {
  const returnTo = `/en/subjects/${subject}/book/discussion#subject-community-threads`;
  const href = communityEntryHref({
    locale: 'en',
    boardId: board,
    subjectId: subject,
    subjectLabel: 'Steins;Gate',
    returnTo,
  });
  const url = new URL(href, 'https://site.test');
  expect(url.pathname).toBe(`/en/boards/${board}/new`);
  expect(threadCreationPreset(Object.fromEntries(url.searchParams), 'en')).toEqual({
    subject,
    subjectTitle: 'Steins;Gate',
    returnTo,
  });
});

test('a supplied Board without its explicit entry, or with another Board, fails closed', () => {
  expect(composedCommunityRegion(page(), withBoard).state).toBe('unavailable');
  expect(
    composedCommunityRegion(page({ state: 'concealed', request: requestOf(otherBoard) }), withBoard).state,
  ).toBe('unavailable');
  expect(composedCommunityRegion(page(current('allowed')), plain).state).toBe('unavailable');
});
