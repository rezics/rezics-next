import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { GLOBAL, QUESTION, readRatings } from '../src/features/pages/subject-ratings';

const subject = '00000000-0000-7000-8000-000000000099';
const responses = {
  question: {
    id: QUESTION,
    revision: 1,
    label: 'How much did you like this work?',
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  },
  figure: {
    figure: {
      questionId: QUESTION,
      populationId: GLOBAL,
      scale: { min: 0, max: 20, displayStep: 1 },
      count: 0,
      state: 'insufficient_data',
      mean: null,
      score: null,
    },
  },
  aggregate: {
    question: QUESTION,
    subject,
    figures: [{ population: GLOBAL, count: 0, freshness: { asOf: null, updating: false } }],
  },
  statistics: [],
};
type Responses = { [Key in keyof typeof responses]: unknown };

function client(overrides: Partial<Responses> = {}) {
  const payloads = { ...responses, ...overrides };
  return createKernelClient('https://kernel.example', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const payload = path.includes('/rating-questions/')
        ? payloads.question
        : path.endsWith('/figure')
          ? payloads.figure
          : path.endsWith('/ratings')
            ? payloads.aggregate
            : payloads.statistics;
      return Response.json(payload);
    },
  });
}

test('malformed successful public payloads fail only their own sources', async () => {
  const invalidStatistics = await readRatings(
    client({ statistics: [{ source: 'vndb', scale: null }] }),
    subject,
  );
  expect(invalidStatistics.statistics.kind).toBe('failed');
  expect(invalidStatistics.global.kind).toBe('ready');
  expect(invalidStatistics.question.kind).toBe('ready');
  expect(invalidStatistics.figure.kind).toBe('ready');

  const invalidAggregate = await readRatings(
    client({
      aggregate: {
        ...responses.aggregate,
        figures: [{ population: GLOBAL, count: -1, freshness: { asOf: null, updating: false } }],
      },
    }),
    subject,
  );
  expect(invalidAggregate.global.kind).toBe('failed');
  expect(invalidAggregate.statistics).toEqual({ kind: 'ready', value: [] });
});

test('valid hidden and updating native figures and imported attribution stay ready', async () => {
  for (const [state, updating] of [
    ['insufficient_data', false],
    ['updating', true],
  ] as const) {
    const data = await readRatings(
      client({
        figure: {
          figure: { ...responses.figure.figure, state },
        },
        aggregate: {
          ...responses.aggregate,
          figures: [
            {
              population: GLOBAL,
              count: 3,
              remaining: 2,
              freshness: { asOf: null, updating },
            },
          ],
        },
        statistics: [
          {
            source: 'vndb',
            sourceRecordId: 'v4',
            scale: { min: 1, max: 10 },
            mean: 8.4,
            count: 1,
            asOf: '2026-10-20',
            licence: 'ODbL-1.0',
            attribution: 'VNDB',
          },
        ],
      }),
      subject,
    );

    expect(data.figure).toMatchObject({ kind: 'ready', value: { state, mean: null, score: null } });
    expect(data.global).toMatchObject({ kind: 'ready', value: { count: 3, remaining: 2, freshness: { updating } } });
    expect(data.statistics).toMatchObject({ kind: 'ready', value: [{ scale: { min: 1, max: 10 }, attribution: 'VNDB' }] });
  }
});
