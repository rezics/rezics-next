import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EXPERIENCE_CADENCE, experienceRatingIdentity, validOccasion } from '../src/modules/rating/experience.ts';
import { InvalidRatingObservationInput, standingRatingDigest, standingRatingSlotIri } from '../src/modules/rating/observation.ts';
import { ratingContextDigest, InvalidRatingContextInput } from '../src/modules/rating/context.ts';
import { ID } from '../src/modules/work/activate.ts';

test('RATE02: intentional occasions and request identity are independent of private ownership', () => {
  const principal = randomUUID(), context = ID + randomUUID(), mainVersion = ID + randomUUID();
  const occasion = randomUUID();
  const first = experienceRatingIdentity(principal, context, mainVersion, occasion);
  expect(experienceRatingIdentity(principal, context, mainVersion, occasion)).toEqual(first);
  expect(experienceRatingIdentity(randomUUID(), context, mainVersion, occasion)).not.toEqual(first);
  expect(experienceRatingIdentity(principal, context, mainVersion, randomUUID())).not.toEqual(first);
  expect(experienceRatingIdentity(principal, ID + randomUUID(), mainVersion, occasion)).not.toEqual(first);
  expect(experienceRatingIdentity(principal, context, ID + randomUUID(), occasion)).not.toEqual(first);
  expect(first.slot).not.toBe(standingRatingSlotIri(principal, context, mainVersion));
  for (const raw of [principal, occasion, context, EXPERIENCE_CADENCE]) expect(JSON.stringify(first)).not.toContain(raw);
  const input = { context, mainVersion, work: ID + randomUUID(), actingSubject: ID + randomUUID(),
    value: 7, expectedRevisionHead: null, occasion };
  expect(standingRatingDigest({ ...input, occasion: randomUUID() })).not.toBe(standingRatingDigest(input));
  expect(standingRatingDigest({ ...input, expectedRevisionHead: ID + randomUUID() })).not.toBe(standingRatingDigest(input));
  expect(() => standingRatingDigest(input, true)).toThrow(InvalidRatingObservationInput);
  for (const invalid of ['', 'occasion', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', Bun.randomUUIDv7(), null, 7]) {
    expect(validOccasion(invalid)).toBe(false);
  }
  expect(validOccasion(occasion)).toBe(true);
  const question = { realm: ID + randomUUID(), question: 'Quality now', actingSubject: input.actingSubject };
  expect(ratingContextDigest({ ...question, cadence: 'experience' })).not.toBe(ratingContextDigest(question));
  expect(() => ratingContextDigest({ ...question, cadence: 'experience', timeZone: 'UTC' })).toThrow(InvalidRatingContextInput);
});
