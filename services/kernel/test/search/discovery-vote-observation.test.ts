import { expect, test } from 'bun:test';
import {
  assertVoteObservation,
  parseVoteObservation,
  requireVoteObservationProvider,
} from '../../src/rating/vote-observation.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/standard-question.ts';
import type { RatingQuestion } from '../../src/rating/votes.ts';

const subjectId = '018f0000-0000-7000-8000-00a000000001';
const observation = {
  subjectId,
  question: {
    id: STANDARD_QUESTION_ID,
    revision: 1,
    grain: 'work',
    meaning: 'score',
    scale: { min: 0, max: 20, displayStep: 1 },
  },
};
const question = {
  id: STANDARD_QUESTION_ID,
  revision: 1,
  grain: 'work',
  meaning: 'score',
  label: 'Score',
  minimumUnits: 0,
  maximumUnits: 20,
  stepUnits: 1,
} as RatingQuestion;

test('explicit native score observation refuses question or resolved identity changes after an await', async () => {
  const captured = parseVoteObservation(JSON.stringify(observation))!;
  expect(() => assertVoteObservation(captured, question, subjectId)).not.toThrow();
  await Promise.resolve();
  for (const changed of [
    { ...question, revision: 2 },
    { ...question, maximumUnits: 100 },
    { ...question, grain: 'release' as const },
    { ...question, meaning: 'different' },
  ])
    expect(() => assertVoteObservation(captured, changed, subjectId)).toThrow('question_changed');
  expect(() => assertVoteObservation(captured, question, 'other')).toThrow('subject_changed');
});

test('conditional providers refuse without an unlocked preflight; observations have a finite byte bound', () => {
  expect(() => requireVoteObservationProvider('conditional')).toThrow('atomic_guard_unavailable');
  expect(() =>
    parseVoteObservation(
      JSON.stringify({ ...observation, question: { ...observation.question, meaning: '界'.repeat(700) } }),
    ),
  ).toThrow('Invalid vote observation');
  expect(parseVoteObservation(undefined)).toBeUndefined();
});
