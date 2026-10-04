import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { short, startRatingStack } from './rating-components-support.ts';

test('a target mean is withheld below the Context display threshold and shown from it, with count and histogram always', async () => {
  const r = await startRatingStack('rating-thresholds');
  try {
    const target = await r.resource('キリト');
    // v2 keeps the default of five ratings; v3 may declare its own, and a bad one is refused.
    const legacy = await r.json<{ context: string; displayThreshold: number; profile: string }>(await r.call(r.owner, 'POST',
      '/v1/rating-contexts', { profile: 'realm-target-rating-context-v2', realm: r.realm, question: 'How good is this character?',
        language: 'en', targetGrain: 'resource', actingSubject: r.owner.actor }), 201);
    expect(legacy).toMatchObject({ profile: 'realm-target-rating-context-v2', displayThreshold: 5 });
    const declared = await r.context({ displayThreshold: 3 });
    expect(declared).toMatchObject({ profile: 'realm-target-rating-context-v3', displayThreshold: 3 });
    const defaulted = await r.context();
    expect(defaulted.displayThreshold).toBe(5);
    for (const displayThreshold of [0, 1001]) {
      expect((await r.call(r.owner, 'POST', '/v1/rating-contexts', { profile: 'realm-target-rating-context-v3', realm: r.realm,
        question: 'How good is this character?', language: 'en', targetGrain: 'resource', displayThreshold,
        actingSubject: r.owner.actor })).status).toBe(400);
    }
    // The projection resolver now admits the v3 grain with its own default threshold.
    expect((await r.call(r.owner, 'POST', '/v1/rating-contexts', { profile: 'realm-target-rating-context-v3', realm: r.realm,
      question: 'How good is this character?', language: 'en', targetGrain: 'projection',
      actingSubject: r.owner.actor })).status).toBe(201);
    expect(await r.json(await r.call(null, 'GET', `/v1/rating-contexts/${short(declared.context)}`)))
      .toMatchObject({ profile: 'realm-target-rating-context-v3', displayThreshold: 3 });
    expect(await r.json(await r.call(null, 'GET', `/v1/rating-contexts/${short(legacy.context)}`)))
      .toMatchObject({ profile: 'realm-target-rating-context-v2', displayThreshold: 5 });
    // A declared threshold replays with the same key and conflicts with another.
    const key = randomUUID(), question = 'Declared twice?';
    const twice = { profile: 'realm-target-rating-context-v3', realm: r.realm, question, language: 'en', targetGrain: 'resource',
      displayThreshold: 7, actingSubject: r.owner.actor };
    const first = await r.json<{ context: string }>(await r.call(r.owner, 'POST', '/v1/rating-contexts', twice, key), 201);
    expect(await r.json(await r.call(r.owner, 'POST', '/v1/rating-contexts', twice, key))).toMatchObject({ context: first.context, replayed: true, displayThreshold: 7 });
    expect((await r.call(r.owner, 'POST', '/v1/rating-contexts', { ...twice, displayThreshold: 8 }, key)).status).toBe(409);

    const raters = await Promise.all(Array.from({ length: 5 }, (_, index) => r.person(`threshold-rater-${index}`)));
    const [a, b, c, d, e] = raters as [typeof raters[0], ...typeof raters];
    const opinion = await r.rate(a, declared.context, target, 8);
    await r.rate(b, declared.context, target, 6);
    // Two ratings against a threshold of three: count and histogram, no mean.
    const two = await r.aggregate(declared.context, target);
    expect(two).toMatchObject({ count: 2, population: 2, sum: 14, displayThreshold: 3, mean: null,
      meanDisplay: 'withheld-below-threshold', precision: { kind: 'withheld-below-threshold' } });
    expect(two.histogram).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
    const read = async (context: string) => r.json<{ count: number; mean: number | null; meanDisplay: string | null; displayThreshold: number | null;
      distribution: { value: number; count: number }[] }>(await r.call(r.owner, 'GET',
      `/v1/resources/${short(target)}/ratings?scope=realm&realm=${encodeURIComponent(r.realm)}&context=${encodeURIComponent(context)}`
      + `&actingSubject=${encodeURIComponent(r.owner.actor)}`));
    expect(await read(declared.context)).toMatchObject({ count: 2, mean: null, meanDisplay: 'withheld-below-threshold', displayThreshold: 3 });
    await r.rate(c, declared.context, target, 10);
    expect(await r.aggregate(declared.context, target)).toMatchObject({ count: 3, sum: 24, mean: 8, meanDisplay: 'shown',
      precision: { kind: 'exact-rational', numerator: 24, denominator: 3 } });
    expect(await read(declared.context)).toMatchObject({ count: 3, mean: 8, meanDisplay: 'shown', displayThreshold: 3 });
    // Withdrawing drops the count below the threshold again; the withdrawn rating leaves the histogram.
    await r.rate(a, declared.context, target, null, opinion.observationRevision);
    const withdrawn = await r.aggregate(declared.context, target);
    expect(withdrawn).toMatchObject({ count: 2, population: 3, withdrawnCount: 1, sum: 16, mean: null, meanDisplay: 'withheld-below-threshold' });
    expect(withdrawn.histogram).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);

    // The default of five applies to a v2 Context and to a v3 Context that declares none.
    for (const [index, rater] of [a, b, c, d].entries()) await r.rate(rater, defaulted.context, target, 5 + index);
    expect(await r.aggregate(defaulted.context, target)).toMatchObject({ count: 4, mean: null, displayThreshold: 5, meanDisplay: 'withheld-below-threshold' });
    await r.rate(e, defaulted.context, target, 10);
    expect(await r.aggregate(defaulted.context, target)).toMatchObject({ count: 5, sum: 36, mean: 7.2, meanDisplay: 'shown' });
    for (const [index, rater] of [a, b, c, d, e].entries()) await r.rate(rater, legacy.context, target, 1 + index);
    expect(await r.aggregate(legacy.context, target)).toMatchObject({ count: 5, mean: 3, displayThreshold: 5, meanDisplay: 'shown' });
    // No ratings at all is neither a mean nor a withheld one.
    const empty = await r.aggregate(first.context, target);
    expect(empty).toMatchObject({ count: 0, population: 0, mean: null, meanDisplay: 'no-data', displayThreshold: 7, precision: { kind: 'no-data' } });
    await r.expectComponentsMatchHeads(declared.context, target);
  } finally { await r.stop(); }
}, 300_000);
