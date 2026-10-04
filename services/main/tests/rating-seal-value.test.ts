import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { RatingInventoryConflict, recordRatingAggregateHead } from '../src/modules/access/rating-aggregate-inventory.ts';
import { targetRatingSlotIri } from '../src/modules/rating/target.ts';
import { targetRatingDigest } from '../src/modules/rating/target-digest.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [context, realm, target, observation, contextRevision, revision, predecessor, actor] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const principal = 'bb000000-0000-4000-8000-000000000000';
const slot = targetRatingSlotIri(principal, context, target);

/** An Access client that records every statement and answers the seal's reads as given. */
function fakeClient(prior: { value: number | null; value_known: boolean } | null, componentExists: boolean) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const client = { query: async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: text, params });
    if (text.includes('FROM access.target_rating_head') && text.includes('FOR UPDATE')) {
      return { rowCount: prior ? 1 : 0, rows: prior ? [prior] : [] };
    }
    if (text.includes('FROM access.target_rating_component') && text.includes('FOR UPDATE')) return { rowCount: componentExists ? 1 : 0, rows: [] };
    return { rowCount: 1, rows: [] };
  } } as unknown as PoolClient;
  return { client, statements };
}
const admissionFor = (value: number | null, expected: string | null) => ({ id: 'ad000000-0000-4000-8000-000000000000',
  action: 'rating.observation.set', principal_id: 'bb000000-0000-4000-8000-000000000000', acting_subject: actor,
  request_digest: targetRatingDigest({ context, target, expectedRevisionHead: expected, value, actingSubject: actor }) });
const proof = (value: number | null, expected: string | null, over: Record<string, unknown> = {}) => ({ outcome: 'succeeded' as const,
  receipt: 'urn:rezics:receipt:x', admissionId: 'ad', requestDigest: 'd', authorityEpoch: '0', scope: `rating:observe:${context}`, dataEpoch: 'e', sequence: '1',
  context, realm, revision, target, observation, contextRevision, slot, predecessor: expected, value,
  availability: value === null ? 'withdrawn' as const : 'available' as const, ...over });
const writes = <T extends { sql: string }>(statements: T[]) => statements.filter(statement => /^(INSERT|UPDATE)/.test(statement.sql));

test('a sealed value must be the one in the admitted request digest, and nothing is written when it is not', async () => {
  const { client, statements } = fakeClient(null, false);
  // The admission asked for 8; a receipt claiming 10 cannot move a sum.
  await expect(recordRatingAggregateHead(client, admissionFor(8, null), proof(10, null))).rejects.toBeInstanceOf(RatingInventoryConflict);
  await expect(recordRatingAggregateHead(client, admissionFor(8, null), proof(8, null, { target: id(9) })))
    .rejects.toBeInstanceOf(RatingInventoryConflict);
  expect(writes(statements)).toEqual([]);
});

test('a sealed value outside 1-10, or one that contradicts its availability, is refused before any write', async () => {
  const { client, statements } = fakeClient(null, false);
  const admission = admissionFor(8, null);
  for (const bad of [proof(11, null), proof(0, null), proof(7.5, null), proof(8, null, { availability: 'withdrawn' }),
    proof(null, null, { availability: 'available' }), proof(8, null, { availability: undefined })]) {
    await expect(recordRatingAggregateHead(client, admission, bad)).rejects.toBeInstanceOf(RatingInventoryConflict);
  }
  expect(writes(statements)).toEqual([]);
});

test('a first rating inserts a valued head and its target components under the target gate', async () => {
  const { client, statements } = fakeClient(null, false);
  await recordRatingAggregateHead(client, admissionFor(8, null), proof(8, null));
  const inserts = writes(statements);
  expect(inserts.map(statement => statement.sql.split(' ').slice(0, 3).join(' '))).toEqual([
    'INSERT INTO access.rating_observation_gate', 'INSERT INTO access.target_rating_head', 'INSERT INTO access.target_rating_component']);
  expect(inserts[1]!.params.at(-1)).toBe(8);
  // slots, rating count, sum and a histogram with one rating in bin 8.
  expect(inserts[2]!.params).toEqual([context, target, 1, 8, [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], 'ad000000-0000-4000-8000-000000000000']);
  expect(statements.find(
      (statement) =>
        statement.sql.includes('rating_observation_gate') && statement.sql.endsWith('FOR UPDATE'),
    )?.params).toEqual([context, target]);
});

test("a revision subtracts the head's recorded value and adds the new one; a withdrawal subtracts only", async () => {
  const revise = async (value: number | null, prior: { value: number | null; value_known: boolean }) => {
    const { client, statements } = fakeClient(prior, true);
    await recordRatingAggregateHead(client, admissionFor(value, predecessor), proof(value, predecessor));
    const updates = writes(statements).filter(statement => statement.sql.includes('rating_count = rating_count +'));
    return updates.map(statement => statement.params);
  };
  // [context, target, slots, unvalued, count, sum, previous, next, admission] for the target row.
  const [target6to9] = await revise(9, { value: 6, value_known: true });
  expect(target6to9!.slice(2)).toEqual([0, 0, 0, 3, 6, 9, 'ad000000-0000-4000-8000-000000000000']);
  const [withdraw] = await revise(null, { value: 6, value_known: true });
  expect(withdraw!.slice(2)).toEqual([0, 0, -1, -6, 6, null, 'ad000000-0000-4000-8000-000000000000']);
  // A withdrawn rater rating again adds one rating and subtracts nothing.
  const [again] = await revise(4, { value: null, value_known: true });
  expect(again!.slice(2)).toEqual([0, 0, 1, 4, null, 4, 'ad000000-0000-4000-8000-000000000000']);
  // A head sealed before values were recorded has nothing to subtract, and is valued from now on.
  const [legacy] = await revise(5, { value: null, value_known: false });
  expect(legacy!.slice(2)).toEqual([0, -1, 1, 5, null, 5, 'ad000000-0000-4000-8000-000000000000']);
});

test('a revision whose predecessor head is not the sealed one moves nothing', async () => {
  const { client, statements } = fakeClient(null, true);
  await expect(recordRatingAggregateHead(client, admissionFor(9, predecessor), proof(9, predecessor)),
  ).rejects.toBeInstanceOf(RatingInventoryConflict);
  expect(
    writes(statements).filter((statement) => !statement.sql.includes('rating_observation_gate')),
  ).toEqual([]);
});

test('Access recomputes the target slot from principal, Context and target before writing', async () => {
  for (const forged of [
    targetRatingSlotIri('cc000000-0000-4000-8000-000000000000', context, target),
    targetRatingSlotIri(principal, id(9), target),
    targetRatingSlotIri(principal, context, id(9)),
  ]) {
    const { client, statements } = fakeClient(null, false);
    await expect(
      recordRatingAggregateHead(client, admissionFor(8, null), proof(8, null, { slot: forged })),
    ).rejects.toBeInstanceOf(RatingInventoryConflict);
  expect(writes(statements)).toEqual([]);
}});
