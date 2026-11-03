import { expect, test } from 'bun:test';
import type { OwnVoteEntry, OwnVotesPage } from '../../../services/kernel/src/rating/own-votes-page.ts';
import {
  indexOwnVotes,
  ownVotesCursor,
  removeOwnVote,
  replaceOwnVote,
  votePairKey,
} from '../src/ratings/own-votes/inventory';

const accountId = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
const terminalId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
function entry(targetId: string, questionId: string, units = 0): OwnVoteEntry {
  const path = `/v1/subjects/${targetId}/ratings/${questionId}/vote`;
  return {
    targetId,
    questionId,
    subject: {
      id: terminalId,
      type: 'work',
      types: ['work'],
      label: { value: 'Same summary', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: '/v1/subjects/admitted',
    question: {
      id: questionId,
      revision: 1,
      label: 'Question',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units, revision: 1, at: '2026-10-01T00:00:00.000Z' },
    actions: { state: 'editable', put: path, clear: path, readback: path },
  };
}
const page = (votes: OwnVoteEntry[], next: string | null = null): OwnVotesPage => ({
  viewer: { accountId },
  votes,
  next,
});

test('bounded index keeps original pairs distinct when admitted summaries share one terminal identity', () => {
  for (const count of [1, 10, 20]) {
    const votes = Array.from({ length: count }, (_, index) => entry(`b${index}`, `q${index}`));
    const indexed = indexOwnVotes(page(votes));
    expect(indexed.size).toBe(count);
    expect(indexed.get(votePairKey(votes.at(-1)!))).toBe(votes.at(-1));
    expect(votes[0]!.own.units).toBe(0);
  }
  const sameSummary = [entry('source-a', 'question-a'), entry('source-b', 'question-a')];
  expect(indexOwnVotes(page(sameSummary)).size).toBe(2);
  expect(() => indexOwnVotes(page([sameSummary[0]!, sameSummary[0]!]))).toThrow();
});

test('cursor bytes and page frontier survive sparse pages, same-key edits and clear', () => {
  const next = 'sealed/+opaque=bytes';
  expect(ownVotesCursor(next)).toEqual({ valid: true, cursor: next });
  expect(ownVotesCursor('x'.repeat(4097))).toEqual({ valid: false });
  const first = entry('source-a', 'question-a');
  const second = entry('source-b', 'question-b');
  const current = page([first, second], next);
  const updated = replaceOwnVote(current, { ...first, own: { ...first.own, units: 8 } });
  expect(updated.votes.map(votePairKey)).toEqual(current.votes.map(votePairKey));
  expect(updated.next).toBe(next);
  const cleared = removeOwnVote(updated, first);
  expect(cleared.votes).toEqual([second]);
  expect(cleared.next).toBe(next);
  expect(page([], next).next).toBe(next);
});
