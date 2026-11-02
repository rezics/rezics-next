import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { admitRatingAggregate, admitRatingPopulationPage } from '../src/features/pages/rating-population-value';
import { readRatingPopulations, type PopulationInput } from '../src/features/pages/subject-rating-populations';

const subject = '123e4567-e89b-42d3-a456-426614174000';
const question = '123e4567-e89b-42d3-b456-426614174001';
const population = '123e4567-e89b-42d3-c456-426614174002';
const otherPopulation = '123e4567-e89b-42d3-a456-426614174003';
const freshness = { asOf: '2026-11-01T00:00:00.000Z', updating: false };
const figure = { population, count: 7, mean: 4.5, histogram: [1, 2, 4], freshness };
const aggregate = { question, subject, figures: [figure] };
const input: PopulationInput = { id: subject, question, expectedReader: null, locale: 'en', selected: [population] };

function clientFor(response: unknown): KernelClient {
  return {
    subjects: () => ({ ratings: { get: async () => ({ status: 200, data: response }) } }),
    realms: () => ({ get: async () => ({ status: 200, data: { realm: { realmId: population, title: 'Realm' } } }) }),
  } as unknown as KernelClient;
}

test('admits coherent native rating population responses', async () => {
  expect(admitRatingPopulationPage({ populations: [], next: 'opaque.native.cursor' })).toEqual({
    populations: [],
    next: 'opaque.native.cursor',
  });
  expect(admitRatingAggregate(aggregate, { subject, question, populations: [population] })).toEqual(aggregate);

  const result = await readRatingPopulations(clientFor(aggregate), new Request('https://web.test'), {}, input);
  expect(result.result).toEqual({
    kind: 'ready',
    value: { items: [{ id: population, name: 'Realm', figure: { kind: 'ready', value: figure } }], next: null, incomplete: false },
  });
});

test('rejects malformed population pages and aggregate figures', async () => {
  expect(admitRatingPopulationPage({ populations: [{ population, count: 0 }], next: null })).toBeNull();
  expect(admitRatingPopulationPage({ populations: [{ population, count: 1 }, { population, count: 2 }], next: null })).toBeNull();
  expect(admitRatingPopulationPage({ populations: [], next: { cursor: 'opaque' } })).toBeNull();

  const malformed = [
    { ...aggregate, subject: question },
    { ...aggregate, figures: [{ ...figure, count: -1 }] },
    { ...aggregate, figures: [{ ...figure, histogram: [1, -1] }] },
    { ...aggregate, figures: [{ ...figure, population: subject }] },
    { ...aggregate, figures: [{ ...figure, privatePayload: 'must not reach cache' }] },
  ];
  for (const value of malformed) expect(admitRatingAggregate(value, { subject, question, populations: [population] })).toBeNull();
  expect(
    admitRatingAggregate({ ...aggregate, figures: [figure, figure] }, { subject, question, populations: [population, otherPopulation] }),
  ).toBeNull();

  const result = await readRatingPopulations(clientFor({ ...aggregate, question: subject }), new Request('https://web.test'), {}, input);
  expect(result.result).toEqual({ kind: 'failed' });
});
