import { expect, test } from 'bun:test';
import { QUESTION } from '../src/features/pages/subject-ratings';
import { ownScoreUnits } from '../src/library/score';
import {
  classifyPersonalScoreWriteProblem,
  personalScoreDiscoveryWrite,
  personalScoreWriteCommand,
  personalScoreWriteNotice,
} from '../src/library/score-write';
import { scoreOrderReadState } from '../src/library/personal-score';
import { likedMemberScore } from '../src/library/liked';
import type { CollectionViewerFacts } from '../src/library/reads';

const question = {
  id: QUESTION,
  meaning: 'Your personal rating',
  revision: 1,
  grain: 'count',
  minimumUnits: 0,
  maximumUnits: 20,
  stepUnits: 1,
  lifecycleState: 'active',
  lifecycleRevision: 1,
};
const overlayQuestion = {
  id: QUESTION,
  revision: 1,
  grain: 'item',
  scale: { min: 0, max: 20, displayStep: 1 },
  meaning: 'Your personal rating',
};
const subjectId = '00000000-0000-4000-8000-000000000111';
const memberId = '00000000-0000-4000-8000-000000000201';
const facts = {
  state: 'current',
  question: overlayQuestion,
  rows: [
    {
      rowKey: memberId,
      subjectId,
      entry: { state: 'present', incarnationId: null, entryState: 'completed', revision: 1 },
      vote: { state: 'present', questionId: QUESTION, questionRevision: 1, units: 0, revision: 2 },
    },
  ],
} as CollectionViewerFacts;

test('score order maps native preparation and identity-fence details without treating other 503s as currentness', () => {
  expect(scoreOrderReadState('personalScore: POST /v1/libraryShelfScorePreparation until ready=true')).toBe(
    'preparing',
  );
  expect(scoreOrderReadState('Content native owner-wide score identity fence is not installed')).toBe(
    'score-unavailable',
  );
  expect(scoreOrderReadState('Content voter standing ineligible refuses score currentness')).toBe('score-unavailable');
  expect(scoreOrderReadState('native title page coverage and seek')).toBeUndefined();
});

test('own shelf units keep zero distinct from unrated and ignore a mismatched question', () => {
  expect(ownScoreUnits({ subjectId, personalScore: 0, scoreQuestion: question })?.units).toBe(0);
  expect(ownScoreUnits({ subjectId, personalScore: null, scoreQuestion: question })?.units).toBeNull();
  expect(ownScoreUnits({ subjectId, personalScore: 8, scoreQuestion: { ...question, id: subjectId } })).toBeUndefined();
});

test('vote writes classify stale review separately from uncertain delivery and reuse the unresolved key', () => {
  expect(classifyPersonalScoreWriteProblem({ status: 409, code: 'conflict' })).toBe('stale');
  expect(classifyPersonalScoreWriteProblem({ status: 409, code: 'vote_review_stale' })).toBe('stale');
  expect(classifyPersonalScoreWriteProblem({ status: 403 })).toBe('rejected');
  expect(classifyPersonalScoreWriteProblem({ status: 503 })).toBe('uncertain');
  expect(personalScoreWriteNotice('uncertain')).toBe('uncertain');
  expect(personalScoreWriteNotice('stale')).toBe('stale');
  expect(personalScoreWriteNotice('successful')).toBeUndefined();
  expect(personalScoreDiscoveryWrite('stale')).toBe('rejected');
  expect(personalScoreDiscoveryWrite('uncertain')).toBe('uncertain');
  const first = personalScoreWriteCommand(null, 0);
  expect(personalScoreWriteCommand(first, 0)).toEqual(first);
  expect(personalScoreWriteCommand(first, 15).key).not.toBe(first.key);
});

test('Liked own score uses the current overlay and stays withheld without a live session', () => {
  const member = { id: memberId, subjectId };
  const page = { viewerFacts: facts };
  const provenance = { mode: 'session' as const, viewerId: 'voter' };
  expect(likedMemberScore(page, member, provenance, 'voter', true)).toEqual({ units: 0 });
  expect(likedMemberScore(page, member, provenance, 'voter', false)).toBeUndefined();
  expect(likedMemberScore(page, member, { mode: 'anonymous', viewerId: null }, null, true)).toBeUndefined();
});
