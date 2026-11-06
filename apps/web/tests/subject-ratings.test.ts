import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Figure, Statistic } from '../src/features/pages/subject-ratings';

// The view and the rating state reach the Kernel client, which imports Cloudflare's Workers module at load time.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { RatingsView, RatingsRecoveryContext } = await import('../src/features/pages/subject-ratings-view');
const { GLOBAL, QUESTION, readRatings, readOwnRating, writeRatingVote } =
  await import('../src/features/pages/subject-ratings');
// Subject ids are UUIDs; the aggregate reader admits a response only when its subject is the requested one.
const subjectId = '00000000-0000-7000-8000-000000000010';

const realms = [
  { id: '00000000-0000-7000-8000-000000000002', name: 'Quiet Realm' },
  { id: '00000000-0000-7000-8000-000000000003', name: 'Popular Realm' },
  { id: '00000000-0000-7000-8000-000000000004', name: 'Another Realm' },
  { id: '00000000-0000-7000-8000-000000000005', name: 'Ignored Realm' },
];
// Aggregate figures carry their freshness; the reader admits no figure without it.
const figure = (population: string, count: number, extra: Partial<Figure> = {}): Figure => ({
  population,
  count,
  freshness: { asOf: null, updating: false },
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
  const transport = createKernelClient('https://kernel.example', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/vote')) {
        calls.vote.push(request);
        return Response.json(vote.data ?? {}, { status: vote.status });
      }
      if (url.pathname.startsWith('/v1/rating-questions/'))
        return Response.json({
          id: QUESTION,
          revision: 1,
          label: 'How much did you like this work?',
          grain: 'work',
          scale: { min: 0, max: 20, displayStep: 1 },
        });
      if (url.pathname.endsWith('/figure')) {
        const global = figures.find((item) => item.population === GLOBAL);
        return Response.json({
          figure: {
            questionId: QUESTION,
            populationId: GLOBAL,
            scale: { min: 0, max: 20, displayStep: 1 },
            count: global?.count ?? 0,
            state: global?.freshness?.updating
              ? 'updating'
              : global?.mean !== undefined && !global.remaining
                ? 'ready'
                : 'insufficient_data',
            mean: global?.mean !== undefined && !global.remaining ? global.mean / 2 : null,
            score: null,
          },
        });
      }
      if (url.pathname.endsWith('/ratings')) {
        calls.aggregate.push({
          query: { question: url.searchParams.get('question'), population: url.searchParams.getAll('population') },
          headers: Object.fromEntries(request.headers),
        });
        return Response.json({ question: QUESTION, subject: subjectId, figures }, { status: aggregateStatus });
      }
      if (url.pathname.endsWith('/source-statistics')) {
        calls.source.push(request);
        return Response.json(statistics);
      }
      throw new Error(`Unexpected read ${url.pathname}`);
    },
  });
  return { calls, client: transport };
}

const render = (
  data: Awaited<ReturnType<typeof readRatings>> | import('../src/features/pages/subject-ratings').Ratings,
) => renderToStaticMarkup(createElement(RatingsView, { data, locale: 'en', subject: 'subject', id: 'ratings' }));

test('a signed-out reader sees the Global score with its count and population and its distribution', async () => {
  const fake = client([figure(GLOBAL, 1203, { mean: 16.8, histogram })]);
  const html = render(await readRatings(fake.client, subjectId));

  expect(html).toContain('8.4');
  expect(html).toContain('1,203');
  expect(html).toContain('Global');
  expect(html).toContain('data-slot="histogram"');
  expect(fake.calls.aggregate).toHaveLength(1);
  expect(fake.calls.source).toHaveLength(1);
  expect(fake.calls.vote).toHaveLength(0);
  // The installed client sends its JSON content type; a signed-out read carries no credentials.
  expect(fake.calls.aggregate[0]).toEqual({
    query: { question: QUESTION, population: [GLOBAL] },
    headers: { 'content-type': 'application/json' },
  });
});

test('imported scores show after the native figures with their source, own scale, count and date, and are never blended', async () => {
  const fake = client([figure(GLOBAL, 5, { mean: 16, histogram })], [imported]);
  const html = render(await readRatings(fake.client, subjectId));

  expect(html.indexOf('public-rating-figure')).toBeLessThan(html.indexOf('Example'));
  expect(html).toContain('8');
  expect(html).toContain('84');
  expect(html).toContain('1');
  expect(html).toContain('100');
  expect(html).toContain('50');
  expect(html).toContain('2025');
});

test('public rating acquisition never consumes membership choices or an own vote, which has its separate native reader', async () => {
  const fake = client([figure(GLOBAL, 0), ...realms.map(({ id }) => figure(id, 8, { mean: 15, histogram }))], [], {
    status: 200,
    data: { units: 17 },
  });
  const data = await readRatings(fake.client, subjectId);
  const html = render(data);
  expect(fake.calls.aggregate[0]).toMatchObject({ query: { question: QUESTION, population: [GLOBAL] } });
  expect(fake.calls.vote).toHaveLength(0);
  expect(html).toContain('No ratings yet');
  for (const realm of realms) expect(html).not.toContain(realm.name);
  expect(html).not.toContain('Your rating');
  const own = await readOwnRating(
    fake.client,
    new Request('https://site.test', { headers: { authorization: 'Bearer token' } }),
    {},
    subjectId,
  );
  expect(own).toMatchObject({ kind: 'ready', units: 17 });
  expect(fake.calls.vote).toHaveLength(1);
});

test('a population below the threshold shows its count and how many more ratings it needs, never a score or histogram', async () => {
  const fake = client([figure(GLOBAL, 3, { remaining: 2 })]);
  const html = render(await readRatings(fake.client, subjectId));

  expect(html).toContain('3');
  expect(html).toContain('2 more ratings to show a score');
  expect(html).not.toContain('data-slot="histogram"');
  expect(html).not.toContain('<strong');
});

test('with no votes the section says there are no ratings yet and draws no zero and no empty histogram', async () => {
  const fake = client([figure(GLOBAL, 0)]);
  const html = render(await readRatings(fake.client, subjectId));

  expect(html).toContain('No ratings yet');
  expect(html).not.toContain('data-slot="histogram"');
  expect(html).not.toContain('>0<');
});

test("a failed rating read shows the section's retry state and the rest of the page renders", async () => {
  const fake = client([], [], { status: 404 }, 503);
  const data = await readRatings(fake.client, subjectId);
  const html = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement('p', null, 'About remains available'),
      createElement(RatingsView, { data, locale: 'en', subject: 'subject', id: 'ratings' }),
    ),
  );

  expect(html).toContain('About remains available');
  expect(data.global.kind).toBe('failed');
  expect(data.figure.kind).toBe('ready');
  expect(data.statistics.kind).toBe('ready');
  expect(html).toContain('data-source="global"');
  const retry = renderToStaticMarkup(
    createElement(
      RatingsRecoveryContext.Provider,
      { value: () => {} },
      createElement(RatingsView, { data, locale: 'en', subject: 'subject', id: 'ratings' }),
    ),
  );
  expect(retry).toContain('Retry');
});

test('an inaccessible own vote leaves the public figures visible without a rating control', async () => {
  const fake = client([figure(GLOBAL, 0)], [], { status: 403 });
  const html = render(await readRatings(fake.client, subjectId));

  expect(html).toContain('No ratings yet');
  expect(html).not.toContain('Your rating');
  const own = await readOwnRating(
    fake.client,
    new Request('https://site.test', { headers: { authorization: 'Bearer token' } }),
    {},
    subjectId,
  );
  expect(own.kind).toBe('unavailable');
  expect(fake.calls.vote).toHaveLength(1);
});

test('rating request counts stay constant for empty and populated subjects', async () => {
  for (const count of [0, 1203]) {
    const signedOut = client([figure(GLOBAL, count, count ? { mean: 16.8, histogram } : {})]);
    await readRatings(signedOut.client, subjectId);
    expect(signedOut.calls.aggregate).toHaveLength(1);
    expect(signedOut.calls.source).toHaveLength(1);
    expect(signedOut.calls.vote).toHaveLength(0);

    const signedIn = client([figure(GLOBAL, count, count ? { mean: 16.8, histogram } : {})]);
    await readRatings(signedIn.client, subjectId);
    expect(signedIn.calls.aggregate).toHaveLength(1);
    expect(signedIn.calls.source).toHaveLength(1);
    expect(signedIn.calls.vote).toHaveLength(0);
  }
});

// Render the current read model directly: these are presentation regressions, not producer/native evidence.
const hierarchyData: import('../src/features/pages/subject-ratings').Ratings = {
  question: {
    id: QUESTION,
    revision: 7,
    label: 'How much did you like this work?',
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  },
  figure: {
    questionId: QUESTION,
    populationId: GLOBAL,
    scale: { min: 0, max: 20, displayStep: 1 },
    count: 1203,
    state: 'ready',
    mean: 8.4,
    score: 7.9,
  },
  figures: [figure(GLOBAL, 1203, { mean: 16.8, histogram })],
  statistics: [{ ...imported, licence: 'ODbL-1.0', attribution: 'Example contributors' }],
  realms: [],
  own: null,
};

async function ratingDocument(html: string) {
  const { createRequire } = await import('node:module');
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window();
  window.document.body.innerHTML = html;
  return window;
}

test('Subject rating presents one primary result and an accessible bounded distribution without manufacturing missing figures or leaking own votes', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  for (const session of ['signed-in', 'signed-out', 'unknown', 'unavailable'] as const) {
    const cache = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(RatingsView, {
          data: { ...hierarchyData, own: 19, realms: [{ id: GLOBAL, name: 'Duplicate Global' }, realms[0]!] },
          id: 'ratings',
          subject: 'subject',
          locale: 'en',
          control: {
            subjectId: 'subject',
            locale: 'en',
            returnTo: '/en/subjects/subject',
            session,
            own: { reader: null, kind: 'unavailable' },
          },
        }),
      ),
    );
    const window = await ratingDocument(html);
    try {
      const document = window.document;
      const primary = document.querySelector('[data-slot="public-rating-figure"]')!;
      expect(primary.textContent).toContain('8.4 out of 10');
      expect(primary.textContent).toContain('1,203 ratings');
      expect(document.querySelectorAll('[data-slot="public-rating-figure"]')).toHaveLength(1);
      expect(document.querySelector('[data-slot="rating-question"]')?.getAttribute('data-revision')).toBe('7');
      expect(html).not.toContain('Duplicate Global');
      expect(html).not.toContain('Your rating: 9.5');
      expect(document.querySelector('[data-slot="own-rating"]')).toBeNull();
      const action = document.querySelector('[data-slot="rating-control-reserved"]')!;
      expect(action).not.toBeNull();
      expect(primary.compareDocumentPosition(action) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const disclosure of document.querySelectorAll('details')) {
        expect(disclosure.open).toBe(false);
        expect(disclosure.querySelector('summary')?.textContent?.trim()).toBeTruthy();
        expect(action.compareDocumentPosition(disclosure) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      const sources = document.querySelector('[data-slot="rating-provenance"]')!;
      for (const detail of ['Example', '84', '100', '50', '2025', 'ODbL-1.0', 'Example contributors', 'Bayesian'])
        expect(sources.textContent).toContain(detail);
    } finally {
      cache.clear();
      await window.happyDOM.close();
    }
  }
});

test('missing comparison figure or mean stays unavailable while zero, threshold and updating remain distinct', async () => {
  const data = {
    ...hierarchyData,
    realms: ['missing', 'zero', 'threshold', 'updating', 'missing-mean'].map((id) => ({ id, name: id })),
    figures: [
      ...hierarchyData.figures,
      figure('zero', 0),
      figure('threshold', 3, { mean: 20, remaining: 2 }),
      figure('updating', 9, { mean: 18, freshness: { asOf: null, updating: true } }),
      figure('missing-mean', 8),
    ],
  };
  const window = await ratingDocument(render(data));
  try {
    const rows = new Map(
      Array.from(window.document.querySelectorAll('[data-slot="rating-comparison"]'), (row) => [
        row.querySelector('h3')!.textContent,
        row.textContent,
      ]),
    );
    expect(rows.get('missing')).toContain('Rating figure unavailable');
    expect(rows.get('missing')).not.toContain('No ratings yet');
    expect(rows.get('missing-mean')).toContain('8 ratings');
    expect(rows.get('missing-mean')).toContain('Rating figure unavailable');
    expect(rows.get('zero')).toContain('No ratings yet');
    expect(rows.get('zero')).not.toContain('unavailable');
    expect(rows.get('threshold')).toContain('2 more ratings');
    expect(rows.get('threshold')).not.toContain('out of 10');
    expect(rows.get('updating')).toContain('publication is updating');
    expect(rows.get('updating')).not.toContain('out of 10');
  } finally {
    await window.happyDOM.close();
  }
});

test('five supplied comparisons mount initially and local reveal/collapse mounts only supplied remainder without reads', async () => {
  const { act } = await import('react');
  const window = await ratingDocument('');
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const contexts = Array.from({ length: 8 }, (_, index) => ({
    id: `supplied-${index}`,
    name: `Supplied context ${index}`,
  }));
  const data = {
    ...hierarchyData,
    realms: [{ id: GLOBAL, name: 'Duplicate Global' }, ...contexts, contexts[0]!],
    figures: [...hierarchyData.figures, ...contexts.map(({ id }, index) => figure(id, 8 - index, { mean: 16 }))],
  };
  const fetchBefore = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (() => {
    reads++;
    throw new Error('Presentation must not fetch');
  }) as typeof fetch;
  try {
    await act(async () => {
      root.render(createElement(RatingsView, { data, id: 'ratings', subject: 'subject', locale: 'en' }));
    });
    const disclosure = host.querySelector('[data-slot="rating-comparisons"]')!;
    expect(disclosure.hasAttribute('open')).toBe(false);
    expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(5);
    expect(host.textContent).not.toContain('Duplicate Global');
    expect(host.textContent).not.toContain('Supplied context 7');
    const button = disclosure.querySelector('button')!;
    expect(button.textContent).toContain('3 more supplied contexts');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const remainder = host.querySelector(`#${button.getAttribute('aria-controls')}`)!;
    expect(remainder.hasAttribute('hidden')).toBe(true);
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(remainder.hasAttribute('hidden')).toBe(false);
    expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(8);
    expect(host.textContent).toContain('Supplied context 7');
    await act(async () => {
      button.click();
    });
    expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(5);
    expect(host.textContent).not.toContain('Supplied context 7');
    expect(reads).toBe(0);
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.fetch = fetchBefore;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

test('a vote write quotes its command key and treats 503 atomic_guard_unavailable as an exact retry', async () => {
  const calls: { method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const voteClient = (status: number, error?: { code: string; retryable: boolean }) =>
    ({
      subjects: () => ({
        ratings: () => ({
          vote: {
            put: async (body: unknown, options: { headers: Record<string, string> }) => {
              calls.push({ method: 'PUT', headers: options.headers, body });
              return {
                status,
                error,
                data: status === 200 ? { units: 8, revision: 1, at: '2026-11-06T00:00:00Z' } : undefined,
              };
            },
            delete: async (_: unknown, options: { headers: Record<string, string> }) => {
              calls.push({ method: 'DELETE', headers: options.headers });
              return { status, error };
            },
          },
        }),
      }),
    }) as never;
  expect(
    await writeRatingVote(voteClient(200), {
      subjectId,
      questionId: QUESTION,
      authorization: 'Bearer reader',
      units: 8,
      idempotencyKey: key,
    }),
  ).toBe('successful');
  expect(calls[0]!.headers['idempotency-key']).toBe(JSON.stringify(key));
  expect(
    await writeRatingVote(voteClient(503, { code: 'atomic_guard_unavailable', retryable: true }), {
      subjectId,
      questionId: QUESTION,
      authorization: 'Bearer reader',
      units: 8,
      idempotencyKey: key,
    }),
  ).toBe('uncertain');
  expect(
    await writeRatingVote(voteClient(409, { code: 'conflict', retryable: false }), {
      subjectId,
      questionId: QUESTION,
      authorization: 'Bearer reader',
      units: null,
      idempotencyKey: key,
    }),
  ).toBe('rejected');
});
