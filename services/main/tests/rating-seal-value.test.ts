import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { CONTEXT_COMPONENT_SHARDS, RatingInventoryConflict, recordRatingAggregateHead, sumShards, targetShard } from '../src/modules/access/rating-aggregate-inventory.ts';
import { targetRatingDigest } from '../src/modules/rating/target-digest.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [context, realm, target, observation, contextRevision, revision, predecessor, actor] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const slot = `urn:rezics:rating-slot:${'a'.repeat(64)}`;

/** An Access client that records every statement and answers the seal's reads as given. */
function fakeClient(prior: { value: number | null; value_known: boolean } | null, componentExists: boolean, contextExists = componentExists) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const client = { query: async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: text, params });
    if (text.includes('FROM access.target_rating_head') && text.includes('FOR UPDATE')) {
      return { rowCount: prior ? 1 : 0, rows: prior ? [prior] : [] };
    }
    if (text.includes('FROM access.target_rating_component') && text.includes('FOR UPDATE')) return { rowCount: componentExists ? 1 : 0, rows: [] };
    if (text.includes('FROM access.target_rating_context_component') && text.includes('FOR UPDATE')) return { rowCount: contextExists ? 1 : 0, rows: [] };
    return { rowCount: 1, rows: [] };
  } } as unknown as PoolClient;
  return { client, statements };
}
const admissionFor = (value: number | null, expected: string | null) => ({ id: 'ad000000-0000-4000-8000-000000000000',
  action: 'rating.observation.set', principal_id: 'bb000000-0000-4000-8000-000000000000', acting_subject: actor,
  request_digest: targetRatingDigest({ context, target, expectedRevisionHead: expected, value, actingSubject: actor }) });
const proof = (value: number | null, expected: string | null, over: Record<string, unknown> = {}) => ({ outcome: 'succeeded' as const,
  receipt: 'urn:rezics:receipt:x', admissionId: 'ad', requestDigest: 'd', authorityEpoch: '0', scope: 's', dataEpoch: 'e', sequence: '1',
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

test('a first rating inserts a valued head and creates both component rows from its value', async () => {
  const { client, statements } = fakeClient(null, false);
  await recordRatingAggregateHead(client, admissionFor(8, null), proof(8, null));
  const inserts = writes(statements);
  expect(inserts.map(statement => statement.sql.split(' ').slice(0, 3).join(' '))).toEqual([
    'INSERT INTO access.target_rating_head', 'INSERT INTO access.target_rating_component', 'INSERT INTO access.target_rating_context_component']);
  expect(inserts[0]!.params.at(-1)).toBe(8);
  // slots, rating count, sum and a histogram with one rating in bin 8.
  expect(inserts[1]!.params).toEqual([context, target, 1, 8, [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], 'ad000000-0000-4000-8000-000000000000']);
  // The Context's totals are the target's shard row: [context, shard, count, sum, bins].
  expect(inserts[2]!.params).toEqual([context, targetShard(target), 1, 8, [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]]);
});

test('a revision subtracts the head\'s recorded value and adds the new one; a withdrawal subtracts only', async () => {
  const revise = async (value: number | null, prior: { value: number | null; value_known: boolean }) => {
    const { client, statements } = fakeClient(prior, true);
    await recordRatingAggregateHead(client, admissionFor(value, predecessor), proof(value, predecessor));
    const updates = writes(statements).filter(statement => statement.sql.includes('rating_count = rating_count +'));
    return updates.map(statement => statement.params);
  };
  // [context, target, slots, unvalued, count, sum, previous, next, admission] for the target row.
  const [target6to9, context6to9] = await revise(9, { value: 6, value_known: true });
  expect(target6to9!.slice(2)).toEqual([0, 0, 0, 3, 6, 9, 'ad000000-0000-4000-8000-000000000000']);
  expect(context6to9!.slice(0, 2)).toEqual([context, targetShard(target)]);
  expect(context6to9!.slice(2)).toEqual([0, 0, 0, 0, 3, 6, 9]);
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
  await expect(recordRatingAggregateHead(client, admissionFor(9, predecessor), proof(9, predecessor))).rejects.toBeInstanceOf(RatingInventoryConflict);
  expect(writes(statements)).toEqual([]);
});

/** Targets whose shards differ, and two that share one, found by trying ids. */
function targetsByShard() {
  const found = new Map<number, string>();
  let same: [string, string] | null = null;
  for (let n = 100; !same || found.size < 2; n++) {
    const candidate = id(n), shard = targetShard(candidate);
    if (found.has(shard) && !same) same = [found.get(shard)!, candidate];
    if (!found.has(shard)) found.set(shard, candidate);
  }
  return { differ: [...found.values()].slice(0, 2) as [string, string], same: same! };
}

test('a target\'s shard is a stable hash in 0-15 spread over the Context\'s targets', () => {
  const shards = Array.from({ length: 1600 }, (_, n) => targetShard(id(n + 1)));
  expect(shards.every(shard => Number.isInteger(shard) && shard >= 0 && shard < CONTEXT_COMPONENT_SHARDS)).toBe(true);
  expect(shards).toEqual(Array.from({ length: 1600 }, (_, n) => targetShard(id(n + 1))));
  // Every shard is used, and none takes more than a few times its even share.
  const counts = Array.from({ length: CONTEXT_COMPONENT_SHARDS }, (_, shard) => shards.filter(value => value === shard).length);
  expect(Math.min(...counts)).toBeGreaterThan(40);
  expect(Math.max(...counts)).toBeLessThan(200);
});

test('seals of different targets move different shard rows of one Context, and the same shard only for targets that hash alike', async () => {
  const { differ: [first, second], same: [alike, twin] } = targetsByShard();
  // The admission digest names the target, so each seal is built for its own target.
  const seal = async (target: string, value: number) => {
    const { client, statements } = fakeClient(null, false, true);
    const admission = { ...admissionFor(value, null), request_digest: targetRatingDigest({ context, target, expectedRevisionHead: null,
      value, actingSubject: actor }) };
    await recordRatingAggregateHead(client, admission, proof(value, null, { target }));
    return writes(statements).find(statement => statement.sql.includes('target_rating_context_component'))!.params.slice(0, 2);
  };
  expect(await seal(first, 7)).toEqual([context, targetShard(first)]);
  expect(await seal(second, 7)).toEqual([context, targetShard(second)]);
  expect((await seal(first, 7))[1]).not.toBe((await seal(second, 7))[1]);
  expect((await seal(alike, 7))[1]).toBe((await seal(twin, 7))[1]);
});

test('the Context totals are the sum of the shard rows', () => {
  const row = (targets: number, slots: number, histogram: number[]) => ({ targets, slots, unvalued: 0,
    rating_count: histogram.reduce((a, b) => a + b, 0), rating_sum: String(histogram.reduce((a, b, i) => a + b * (i + 1), 0)), histogram });
  expect(sumShards([])).toBeNull();
  const total = sumShards([row(2, 5, [0, 1, 0, 0, 2, 0, 0, 0, 0, 0]), row(1, 3, [0, 0, 0, 1, 0, 0, 0, 0, 0, 2]), row(1, 1, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  expect(total).toEqual({ targets: 4, slots: 9, unvalued: 0, count: 7, sum: 2 + 10 + 4 + 20 + 1,
    histogram: [1, 1, 0, 1, 2, 0, 0, 0, 0, 2] });
});
