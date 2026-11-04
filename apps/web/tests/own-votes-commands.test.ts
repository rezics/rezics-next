import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import type { OwnVoteEntry } from '../../../services/kernel/src/rating/own-votes-page.ts';
import { createOwnVoteIntent, parseOwnVoteIntent } from '../src/ratings/own-votes/intent';
import { commandOutcome, readOriginalOwnVote } from '../src/ratings/own-votes/readback';

const viewer = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
const targetId = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const terminalId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const questionId = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
const path = `/v1/subjects/${targetId}/ratings/${questionId}/vote`;
function row(
  actions: OwnVoteEntry['actions'] = { state: 'editable', put: path, clear: path, readback: path },
): OwnVoteEntry {
  return {
    targetId,
    questionId,
    subject: {
      id: terminalId,
      type: 'work',
      types: ['work'],
      label: { value: 'Merged title', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: `/v1/subjects/${targetId}`,
    question: {
      id: questionId,
      revision: 1,
      label: 'Question',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units: 0, revision: 3, at: '2026-10-01T00:00:00.000Z' },
    actions,
  };
}

test('frozen replay intent retains the original pair, exact route, body and idempotency key', () => {
  const intent = createOwnVoteIntent(viewer, row(), 'PUT', 0, '11111111-1111-4111-8111-111111111111');
  expect(intent).toMatchObject({
    targetId,
    questionId,
    pair: `${questionId}\u0000${targetId}`,
    path,
    method: 'PUT',
    body: { units: 0 },
    key: '11111111-1111-4111-8111-111111111111',
    actions: row().actions,
  });
  expect(row().question.revision).toBe(1);
  expect(Object.isFrozen(intent.actions)).toBe(true);
  expect(intent.targetId).not.toBe(terminalId);
  expect(parseOwnVoteIntent(intent)).toMatchObject({ path, key: intent.key, body: { units: 0 } });
  expect(parseOwnVoteIntent({ ...intent, path: `/v1/subjects/${terminalId}/ratings/${questionId}/vote` })).toBeNull();
});

test('retired questions admit only native clear; merged rows have no mutation intent', () => {
  const retired = row({ state: 'retired', reason: 'question_retired', clear: path, readback: path });
  expect(createOwnVoteIntent(viewer, retired, 'DELETE', undefined, '22222222-2222-4222-8222-222222222222')).toMatchObject({
    targetId,
    questionId,
    pair: `${questionId}\u0000${targetId}`,
    path,
    method: 'DELETE',
    body: null,
    key: '22222222-2222-4222-8222-222222222222',
  });
  expect(() => createOwnVoteIntent(viewer, retired, 'PUT', 8)).toThrow();
  const merged = row({ state: 'unavailable', reason: 'merged_source' });
  expect(() => createOwnVoteIntent(viewer, merged, 'DELETE')).toThrow();
});

test('a fresh exact inventory read cannot acknowledge or replace an uncertain original intent', async () => {
  const intent = createOwnVoteIntent(viewer, row(), 'PUT', 0, '33333333-3333-4333-8333-333333333333');
  const client = {
    subjects: ({ id }: { id: string }) => ({
      ratings: ({ questionId: question }: { questionId: string }) => ({
        vote: {
          get: async () => {
            expect(`${id}/${question}`).toBe(`${targetId}/${questionId}`);
            return { status: 200, data: { units: 0, revision: 9, at: '2026-11-01T00:00:00.000Z' } };
          },
        },
      }),
    }),
  } as unknown as KernelClient;
  expect(await readOriginalOwnVote(client, 'Bearer test', targetId, questionId, 'REVIEW')).toEqual({
    kind: 'current',
    units: 0,
    revision: 9,
    at: '2026-11-01T00:00:00.000Z',
  });
  expect(commandOutcome(503, undefined)).toBe('uncertain');
  expect(parseOwnVoteIntent(intent)).toMatchObject({ key: intent.key, method: 'PUT', targetId, questionId, body: { units: 0 } });
  expect(parseOwnVoteIntent({ ...intent, targetId: terminalId, path: `/v1/subjects/${terminalId}/ratings/${questionId}/vote` })).toBeNull();
});

test('exact original readback treats DELETE 404 as cleared and PUT 404 as missing', async () => {
  const calls: string[] = [];
  const client = {
    subjects: ({ id }: { id: string }) => ({
      ratings: ({ questionId: question }: { questionId: string }) => ({
        vote: {
          get: async () => {
            calls.push(`${id}/${question}`);
            return { status: 404, data: undefined };
          },
        },
      }),
    }),
  } as unknown as KernelClient;
  expect(await readOriginalOwnVote(client, 'Bearer test', targetId, questionId, 'DELETE')).toEqual({ kind: 'cleared' });
  expect(await readOriginalOwnVote(client, 'Bearer test', targetId, questionId, 'PUT')).toEqual({ kind: 'missing' });
  expect(calls).toEqual([`${targetId}/${questionId}`, `${targetId}/${questionId}`]);
  expect(commandOutcome(503, undefined)).toBe('uncertain');
  expect(commandOutcome(400, undefined)).toBe('rejected');
});
