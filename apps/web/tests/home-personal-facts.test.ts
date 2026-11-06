import { expect, test } from 'bun:test';
import {
  admittedFeedWorkId,
  homeWorkLibraryFeedProjection,
  homeWorkLibraryPage,
  homeWorkLibraryRow,
  type HomeNativePersonalPage,
} from '../src/features/feed/home-work-library/contract';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';

const standardQuestion = {
  id: '00000000-0000-7000-8000-000000000001',
  revision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
  meaning: 'Overall',
};
const scope = {
  reader: 'reader-1',
  credentialEpoch: 'credential-1',
  source: 'home',
  observation: 'page-1',
  locale: 'en',
  route: '/',
};
const lease = { subscribe: () => () => {}, snapshot: () => 0, isCurrent: () => true };

test('native personal facts map by original occurrence and Subject, and never fill a missing or foreign fact', () => {
  const native: HomeNativePersonalPage = {
    state: 'current',
    question: standardQuestion,
    rows: [
      {
        rowKey: 'occurrence-1',
        subjectId: 'work-1',
        entry: { state: 'present', incarnationId: 'incarnation-1', entryState: 'reading', revision: 4 },
        vote: { state: 'present', questionId: standardQuestion.id, questionRevision: 1, units: 14, revision: 2 },
        actions: { state: 'current', allowed: [{ action: 'vote.set', operations: ['vote.set'] }] },
      },
      {
        rowKey: 'occurrence-2',
        subjectId: 'work-2',
        entry: { state: 'present', incarnationId: null, entryState: null, revision: 1 },
        vote: { state: 'absent', questionId: 'other-question', questionRevision: 3 },
        actions: { state: 'unavailable', reason: 'dependency' },
      },
    ],
  };
  const page = homeWorkLibraryPage(native, scope.reader);
  expect(page.rows[0]).toEqual({
    rowKey: 'occurrence-1',
    subjectId: 'work-1',
    entry: {
      state: 'present',
      value: { subjectId: 'work-1', state: 'reading', revision: 4, incarnationId: 'incarnation-1' },
    },
    score: { state: 'present', value: { reader: scope.reader, kind: 'ready', units: 14 } },
    actions: { state: 'current', allowed: [{ action: 'vote.set', operations: ['vote.set'] }] },
  });
  // A null entry state and a vote on another question are unavailable, not absent.
  expect(page.rows[1]).toEqual({
    rowKey: 'occurrence-2',
    subjectId: 'work-2',
    entry: { state: 'unavailable' },
    score: { state: 'unavailable' },
    actions: { state: 'unavailable' },
  });
  // A non-standard scale cannot supply a Home score, and a native unavailable page supplies no rows.
  const rescaled = homeWorkLibraryPage(
    { ...native, question: { ...standardQuestion, scale: { min: 0, max: 10, displayStep: 1 } } },
    scope.reader,
  );
  expect(rescaled.rows[0]?.score).toEqual({ state: 'unavailable' });
  expect(homeWorkLibraryPage({ state: 'unavailable', reason: 'identity', retryable: true }, scope.reader)).toEqual({
    state: 'unavailable',
    rows: [],
  });

  const projection = homeWorkLibraryFeedProjection({ native, scope, lease });
  expect(homeWorkLibraryRow(projection, 'occurrence-1', 'work-1')?.subjectId).toBe('work-1');
  // Another occurrence of the same Subject, or the wrong Subject, is not that row.
  expect(homeWorkLibraryRow(projection, 'occurrence-1', 'work-2')).toBeUndefined();
  expect(homeWorkLibraryRow(projection, 'occurrence-9', 'work-1')).toBeUndefined();
});

test('the seeded Home work row is an admitted Subject identity', () => {
  const work = homeFeedStoryPage('en', true, 'mixed').feedItems.find((item) => admittedFeedWorkId(item));
  expect(work && admittedFeedWorkId(work)).toBe(work?.destination.id);
});
