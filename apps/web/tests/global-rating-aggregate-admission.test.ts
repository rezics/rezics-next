import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { ratingsFixtures } from '../src/kernel/fake/ratings';
import { readRatingPopulations } from '../src/features/pages/subject-rating-populations';
import { GLOBAL, QUESTION, readRatings } from '../src/features/pages/subject-ratings';

const subject = '123e4567-e89b-42d3-a456-426614174000';
const population = '123e4567-e89b-42d3-c456-426614174002';
const fixtures = ratingsFixtures;
const hidden = (population: string) => ({
  ...fixtures['subject-ratings-below-threshold'].aggregate.figures[0]!,
  population,
  freshness: { asOf: null, updating: true },
});
const visible = (population: string) => ({ ...fixtures['subject-ratings-global'].aggregate.figures[0]!, population });

function clientFor(globalFigures: unknown[], selectedFigures: unknown[]): KernelClient {
  return {
    'rating-questions': () => ({ get: async () => ({ status: 200, data: fixtures['subject-ratings-global'].preview.question }) }),
    subjects: () => ({
      figure: { get: async () => ({ status: 200, data: { figure: fixtures['subject-ratings-global'].preview.figure } }) },
      ratings: {
        get: async ({ query }: { query: { population: string[] } }) => ({
          status: 200,
          data: {
            subject,
            question: QUESTION,
            figures: query.population.includes(GLOBAL) ? globalFigures : selectedFigures,
          },
        }),
      },
      'source-statistics': { get: async () => ({ status: 200, data: fixtures['subject-ratings-global'].statistics }) },
    }),
    realms: () => ({ get: async () => ({ status: 200, data: { realm: { realmId: population, title: 'Realm' } } }) }),
  } as unknown as KernelClient;
}

const readSelected = (client: KernelClient) =>
  readRatingPopulations(client, new Request('https://web.test'), {}, {
    id: subject,
    question: QUESTION,
    expectedReader: null,
    locale: 'en',
    selected: [population],
  });

test('Global and selected reads share aggregate admission and preserve siblings and meanless updating figures', async () => {
  const lawful = clientFor([hidden(GLOBAL)], [hidden(population)]);
  expect((await readRatings(lawful, subject)).global).toEqual({ kind: 'ready', value: hidden(GLOBAL) });
  expect(await readSelected(lawful)).toMatchObject({
    result: { kind: 'ready', value: { items: [{ id: population, figure: { kind: 'ready', value: hidden(population) } }] } },
  });

  for (const [globalFigures, selectedFigures] of [
    [[visible(GLOBAL), visible(GLOBAL)], [visible(population), visible(population)]],
    [[visible(GLOBAL), visible(population)], [visible(population), visible(GLOBAL)]],
  ]) {
    const client = clientFor(globalFigures, selectedFigures);
    expect(await readRatings(client, subject)).toMatchObject({
      question: { kind: 'ready' },
      figure: { kind: 'ready' },
      global: { kind: 'failed' },
      statistics: { kind: 'ready' },
    });
    expect((await readSelected(client)).result).toEqual({ kind: 'failed' });
  }
});
