import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { admitPopulationEnvelope } from '../src/features/pages/population-envelope-admission';
import { readRatingPopulations, type PopulationInput } from '../src/features/pages/subject-rating-populations';

const subject = '123e4567-e89b-42d3-a456-426614174000';
const question = '123e4567-e89b-42d3-b456-426614174001';
const population = '123e4567-e89b-42d3-c456-426614174002';
const otherPopulation = '123e4567-e89b-42d3-a456-426614174003';
const global = '00000000-0000-8000-8000-000000000000';
const input: PopulationInput = { id: subject, question, expectedReader: null, locale: 'en' };
const idle = { kind: 'idle' };
const item = { id: population, name: 'Current Realm', figure: idle };
const comparisonItem = { ...item, figure: { kind: 'failed' } };
const envelope = (value: unknown) => ({ reader: null, subject, question, result: value });
const ready = (value: unknown) => ({ kind: 'ready', value });

test('admits bounded sparse pages and only exact selected, concealed identities', () => {
  const sparse = envelope(ready({ items: [item], next: 'opaque.native.cursor', incomplete: true }));
  expect(admitPopulationEnvelope(sparse, input)).toEqual(sparse);
  expect(
    admitPopulationEnvelope(
      envelope(ready({ items: [], next: 'opaque.native.cursor', incomplete: true })),
      input,
    ),
  ).toMatchObject({ result: { kind: 'ready', value: { items: [], next: 'opaque.native.cursor' } } });

  const selected: PopulationInput = { ...input, selected: [population, otherPopulation] };
  const selectedExact: PopulationInput = { ...input, selected: [population] };
  const concealed = envelope(ready({ items: [comparisonItem], next: null, incomplete: true }));
  expect(admitPopulationEnvelope(concealed, selected)).toEqual(concealed);
  const emptySelected: PopulationInput = { ...input, selected: [] };
  expect(admitPopulationEnvelope(envelope(ready({ items: [], next: null, incomplete: false })), emptySelected)).not.toBeNull();
  const figure = {
    population,
    count: 5,
    mean: 4,
    histogram: [0, 0, 0, 0, 0, 5],
    freshness: { asOf: '2026-11-01T00:00:00.000Z', updating: false },
  };
  const comparison = envelope(
    ready({ items: [{ id: population, name: 'Current Realm', figure: { kind: 'ready', value: figure } }], next: null, incomplete: false }),
  );
  expect(admitPopulationEnvelope(comparison, { ...input, selected: [population] })).toEqual(comparison);

  const delayed = envelope({ kind: 'failed', retryAfter: '15' });
  expect(admitPopulationEnvelope(delayed, input)).toEqual(delayed);
});

test('rejects malformed envelopes and any invalid directory or selected page as a whole', () => {
  const directory = ready({ items: [item], next: null, incomplete: false });
  const selected: PopulationInput = { ...input, selected: [population] };
  const invalid = [
    { ...envelope(directory), subject: question },
    { ...envelope(directory), reader: 'another-reader' },
    envelope(ready({ items: {}, next: null, incomplete: false })),
    envelope(ready({ items: [{ ...item, id: global }], next: null, incomplete: false })),
    envelope(ready({ items: [item, item], next: null, incomplete: false })),
    envelope(
      ready({
        items: [
          {
            ...item,
            figure: {
              kind: 'ready',
              value: {
                population,
                count: 1,
                freshness: { asOf: null, updating: false },
                mean: 1,
                histogram: [-1],
              },
            },
          },
        ],
        next: null,
        incomplete: false,
      }),
    ),
    envelope(ready({ items: [{ ...item, name: [] }], next: null, incomplete: false })),
    envelope(ready({ items: [{ ...item, figure: { kind: 'ready', value: { population, count: 1, histogram: [] } } }], next: null, incomplete: false })),
  ];
  for (const value of invalid) expect(admitPopulationEnvelope(value, input)).toBeNull();

  expect(
    admitPopulationEnvelope(
      envelope(ready({ items: [comparisonItem, comparisonItem], next: null, incomplete: false })),
      selectedExact,
    ),
  ).toBeNull();
  expect(
    admitPopulationEnvelope(
      envelope(ready({ items: [{ ...comparisonItem, id: otherPopulation }], next: null, incomplete: false })),
      selectedExact,
    ),
  ).toBeNull();
  expect(admitPopulationEnvelope(envelope(ready({ items: [], next: null, incomplete: false })), selectedExact)).toBeNull();
  expect(
    admitPopulationEnvelope(
      envelope(ready({ items: [comparisonItem], next: 'continuation', incomplete: false })),
      selectedExact,
    ),
  ).toBeNull();
  expect(admitPopulationEnvelope({ ...envelope(directory), result: { kind: 'ready', value: [] } }, input)).toBeNull();
});

function clientFor(title: unknown): KernelClient {
  return {
    subjects: () => ({
      ratings: {
        populations: {
          get: async () => ({ status: 200, data: { populations: [{ population, count: 1 }], next: null } }),
        },
      },
    }),
    realms: () => ({ get: async () => ({ status: 200, data: { realm: { realmId: population, title } } }) }),
  } as unknown as KernelClient;
}

test('the native Realm join admits only bounded string titles and conceals malformed labels', async () => {
  for (const title of [[], '', 'x'.repeat(1025)]) {
    const result = await readRatingPopulations(
      clientFor(title),
      new Request('https://web.test'),
      {},
      input,
    );
    expect(result.result).toEqual({
      kind: 'ready',
      value: { items: [], next: null, incomplete: true },
    });
  }

  const admitted = await readRatingPopulations(
    clientFor('Current Realm'),
    new Request('https://web.test'),
    {},
    input,
  );
  expect(admitted.result).toEqual({
    kind: 'ready',
    value: { items: [{ id: population, name: 'Current Realm', figure: idle }], next: null, incomplete: false },
  });
});
