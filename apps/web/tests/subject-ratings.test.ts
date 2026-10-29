import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RatingsView } from '../src/features/pages/subject-ratings-view';
import { GLOBAL, QUESTION, readRatings, type Figure, type Statistic } from '../src/features/pages/subject-ratings';

const realms = [
  { id: '00000000-0000-7000-8000-000000000002', name: 'Quiet Realm' },
  { id: '00000000-0000-7000-8000-000000000003', name: 'Popular Realm' },
  { id: '00000000-0000-7000-8000-000000000004', name: 'Another Realm' },
  { id: '00000000-0000-7000-8000-000000000005', name: 'Ignored Realm' },
];
const figure = (population: string, count: number, extra: Partial<Figure> = {}): Figure => ({
  population,
  count,
  ...extra,
});
const histogram = Array.from({ length: 21 }, (_, index) => (index === 17 ? 1203 : 0));
const imported: Statistic = {
  source: 'Example',
  scale: { min: 1, max: 100 },
  mean: 84,
  count: 50,
  asOf: '2025-01-01',
};

type VoteResponse = { status: number; data?: { units: number } | null };
function client(
  figures: Figure[],
  statistics: Statistic[] = [],
  vote: VoteResponse = { status: 404 },
  aggregateStatus = 200,
) {
  const calls: { aggregate: unknown[]; source: unknown[]; vote: unknown[] } = {
    aggregate: [],
    source: [],
    vote: [],
  };
  const subject = {
    ratings: Object.assign(
      (_args: { questionId: string }) => ({
        vote: {
          get: async (options: unknown) => {
            calls.vote.push(options);
            return vote;
          },
        },
      }),
      {
        get: async (options: unknown) => {
          calls.aggregate.push(options);
          return aggregateStatus === 200 ? { status: 200, data: { figures } } : { status: aggregateStatus };
        },
      },
    ),
    'source-statistics': {
      get: async (options: unknown) => {
        calls.source.push(options);
        return { status: 200, data: statistics };
      },
    },
  };
  return { calls, client: { subjects: () => subject } };
}

const render = (data: Awaited<ReturnType<typeof readRatings>>) =>
  renderToStaticMarkup(createElement(RatingsView, { data, locale: 'en', subject: 'subject', id: 'ratings' }));

test('a signed-out reader sees the Global score with its count and population and its distribution', async () => {
  const fake = client([figure(GLOBAL, 1203, { mean: 16.8, histogram })]);
  const html = render(await readRatings(fake.client as never, 'subject', null));

  expect(html).toContain('8.4');
  expect(html).toContain('1,203');
  expect(html).toContain('REZICS');
  expect(html).toContain('data-slot="histogram"');
  expect(fake.calls.aggregate).toHaveLength(1);
  expect(fake.calls.source).toHaveLength(1);
  expect(fake.calls.vote).toHaveLength(0);
  expect(fake.calls.aggregate[0]).toEqual({
    query: { question: QUESTION, population: [GLOBAL] },
    headers: {},
  });
});

test('imported scores show after the native figures with their source, own scale, count and date, and are never blended', async () => {
  const fake = client([figure(GLOBAL, 5, { mean: 16, histogram })], [imported]);
  const html = render(await readRatings(fake.client as never, 'subject', null));

  expect(html.indexOf('REZICS')).toBeLessThan(html.indexOf('Example'));
  expect(html).toContain('8');
  expect(html).toContain('84');
  expect(html).toContain('1');
  expect(html).toContain('100');
  expect(html).toContain('50');
  expect(html).toContain('2025');
});

test('a signed-in reader also sees up to three of their Realms, each with its own figure or No ratings yet, and their own rating shown once, as theirs', async () => {
  const fake = client(
    [
      figure(GLOBAL, 0),
      figure(realms[0]!.id, 2, { remaining: 3 }),
      figure(realms[1]!.id, 8, { mean: 15, histogram }),
      figure(realms[2]!.id, 0),
    ],
    [],
    { status: 200, data: { units: 17 } },
  );
  const data = await readRatings(fake.client as never, 'subject', 'Bearer token', realms);
  const html = render(data);

  expect(data?.realms.map((realm) => realm.id)).toEqual(realms.slice(0, 3).map((realm) => realm.id));
  expect(fake.calls.aggregate[0]).toEqual({
    query: { question: QUESTION, population: [GLOBAL, ...realms.slice(0, 3).map((realm) => realm.id)] },
    headers: { authorization: 'Bearer token' },
  });
  expect(html.indexOf('Popular Realm')).toBeLessThan(html.indexOf('Quiet Realm'));
  expect(html).toContain('No ratings yet');
  expect(html).toContain('Your rating');
  expect(html.match(/8\.5/g)?.length).toBe(1);
  expect(fake.calls.aggregate).toHaveLength(1);
  expect(fake.calls.source).toHaveLength(1);
  expect(fake.calls.vote).toHaveLength(1);
});

test('a population below the threshold shows its count and how many more ratings it needs, never a score or histogram', async () => {
  const fake = client([figure(GLOBAL, 3, { remaining: 2 })]);
  const html = render(await readRatings(fake.client as never, 'subject', null));

  expect(html).toContain('3');
  expect(html).toContain('2 more ratings to show a score');
  expect(html).not.toContain('data-slot="histogram"');
  expect(html).not.toContain('<strong');
});

test('with no votes the section says there are no ratings yet and draws no zero and no empty histogram', async () => {
  const fake = client([figure(GLOBAL, 0)]);
  const html = render(await readRatings(fake.client as never, 'subject', null));

  expect(html).toContain('No ratings yet');
  expect(html).not.toContain('data-slot="histogram"');
  expect(html).not.toContain('>0<');
});

test("a failed rating read shows the section's retry state and the rest of the page renders", async () => {
  const fake = client([], [], { status: 404 }, 503);
  const data = await readRatings(fake.client as never, 'subject', null);
  const html = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement('p', null, 'About remains available'),
      createElement(RatingsView, { data, locale: 'en', subject: 'subject', id: 'ratings' }),
    ),
  );

  expect(html).toContain('About remains available');
  expect(html).toContain('data-slot="retry"');
  expect(html).toContain('Retry');
});

test('an inaccessible own vote leaves the public figures visible without a rating control', async () => {
  const fake = client([figure(GLOBAL, 0)], [], { status: 403 });
  const html = render(await readRatings(fake.client as never, 'subject', 'Bearer token'));

  expect(html).toContain('No ratings yet');
  expect(html).not.toContain('Your rating');
  expect(fake.calls.vote).toHaveLength(1);
});

test('rating request counts stay constant for empty and populated subjects', async () => {
  for (const count of [0, 1203]) {
    const signedOut = client([figure(GLOBAL, count, count ? { mean: 16.8, histogram } : {})]);
    await readRatings(signedOut.client as never, 'subject', null);
    expect(signedOut.calls.aggregate).toHaveLength(1);
    expect(signedOut.calls.source).toHaveLength(1);
    expect(signedOut.calls.vote).toHaveLength(0);

    const signedIn = client([figure(GLOBAL, count, count ? { mean: 16.8, histogram } : {})]);
    await readRatings(signedIn.client as never, 'subject', 'Bearer token');
    expect(signedIn.calls.aggregate).toHaveLength(1);
    expect(signedIn.calls.source).toHaveLength(1);
    expect(signedIn.calls.vote).toHaveLength(1);
  }
});
