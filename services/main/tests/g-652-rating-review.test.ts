import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { reviewCommand, reviewItem } from '../src/modules/review/contract.ts';
import { validateReviewIntent } from '../src/modules/review/store.ts';
import { targetAggregateResult } from '../src/modules/rating/target-api.ts';
import { resourceRatingRead } from '../src/modules/rating/target-read.ts';
import { targetRatingSlotIri, targetRatingDigest } from '../src/modules/rating/target.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('G-652: review command and response preserve absent scores and reject invalid supplied scores', () => {
  const body = { profile: 'reader-review-command-v1', actingSubject: id(1), context: id(2), target: id(3),
    expectedRevision: null, language: 'en', text: 'A translation review without a score', spoiler: false };
  expect(Value.Check(reviewCommand, body)).toBe(true);
  expect(Value.Check(reviewCommand, { ...body, rating: null })).toBe(true);
  expect(Value.Check(reviewCommand, { ...body, rating: 8 })).toBe(true);
  for (const rating of [0, 11, 8.5, '8']) expect(Value.Check(reviewCommand, { ...body, rating })).toBe(false);
  expect(Value.Check(reviewItem.properties.rating, null)).toBe(true);
  expect(Value.Check(reviewItem.properties.ratingObservation, null)).toBe(true);
  expect(Value.Check(reviewItem.properties.ratingRevision, null)).toBe(true);
  const intent = { actingSubject: id(1), context: id(2), work: id(3), expectedRevision: null,
    language: 'en', text: body.text, spoiler: false };
  expect(() => validateReviewIntent(intent, 'review-key')).not.toThrow();
  expect(() => validateReviewIntent({ ...intent, rating: 0 }, 'review-key')).toThrow();
});

test('G-652: every resource ratings response variant requires complete aggregation scope', () => {
  const base = { scope: { kind: 'realm', realm: id(4) }, context: id(2), status: 'available',
    scale: { min: 1, max: 10, step: 1 }, count: 0, mean: null, distribution: [],
    sourcePosition: { dataEpoch: 'epoch', sequence: '1' } };
  const results = [{ ...base, profile: 'work-rating-read-v1', work: id(3), mainVersion: id(5),
    aggregationScope: { question: 'How good is the story?', grain: 'main-version',
      population: 'account-principal', countedTarget: id(5) } },
  ...['release', 'realization', 'occurrence', 'resource'].map(grain => ({ ...base,
    profile: 'target-rating-read-v1', target: id(3), targetGrain: grain,
    aggregationScope: { question: 'How good is this target?', grain,
      population: 'account-principal', countedTarget: id(3) } }))];
  // Iterate the route's actual response union, so another variant cannot escape this guard.
  for (const member of resourceRatingRead.anyOf) {
    const matching = results.filter(result => Value.Check(member, result));
    expect(matching.length).toBeGreaterThan(0);
    for (const result of matching) {
      expect(Value.Check(resourceRatingRead, result)).toBe(true);
      const { aggregationScope, ...withoutScope } = result;
      expect(Value.Check(resourceRatingRead, withoutScope)).toBe(false);
      for (const field of Object.keys(aggregationScope)) {
        const partial = { ...aggregationScope } as Record<string, unknown>;
        delete partial[field];
        expect(Value.Check(resourceRatingRead, { ...result, aggregationScope: partial })).toBe(false);
      }
      expect(Value.Check(resourceRatingRead, { ...result, context: null, status: 'no-context',
        aggregationScope: null, scale: null })).toBe(true);
    }
  }
});

test('G-652: scope is mandatory for every aggregate, including an empty population', () => {
  const result = { profile: 'realm-target-latest-mean-v1', complete: true, context: id(2), realm: id(4),
    target: id(3), targetGrain: 'realization', scope: { question: 'How good is this translation?',
      grain: 'realization', population: 'account-principal', countedTarget: id(3) }, scale: { min: 1, max: 10, step: 1 },
    cadence: 'standing', populationPolicy: 'account-principal', aggregationPolicy: 'latest-per-rater-mean',
    population: 0, count: 0, withdrawnCount: 0, histogram: Array.from({ length: 10 }, () => 0), sum: 0,
    mean: null, precision: { kind: 'no-data' }, sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
  expect(Value.Check(targetAggregateResult, result)).toBe(true);
  const { scope, ...withoutScope } = result;
  expect(Value.Check(targetAggregateResult, withoutScope)).toBe(false);
  for (const field of Object.keys(scope)) {
    const partial = { ...scope } as Record<string, unknown>;
    delete partial[field];
    expect(Value.Check(targetAggregateResult, { ...result, scope: partial })).toBe(false);
  }
});

test('G-652: principal, context and exact target each select independent standing slots and retry intents', () => {
  const principal = id(1).slice(-36), slot = targetRatingSlotIri(principal, id(2), id(3));
  expect(slot).not.toBe(targetRatingSlotIri(principal, id(2), id(4)));
  expect(slot).not.toBe(targetRatingSlotIri(principal, id(4), id(3)));
  expect(slot).not.toBe(targetRatingSlotIri(id(4).slice(-36), id(2), id(3)));
  const input = { context: id(2), target: id(3), expectedRevisionHead: null, value: 8, actingSubject: id(1) };
  expect(targetRatingDigest(input)).not.toBe(targetRatingDigest({ ...input, target: id(4) }));
  expect(() => targetRatingDigest({ ...input, value: null })).toThrow();
});
