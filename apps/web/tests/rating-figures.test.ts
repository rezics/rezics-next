import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
import { createKernelClient } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import recorded from '../src/kernel/recorded/subject-page.json';
import type { PublicFigure, RatingQuestion } from '../src/features/pages/subject-ratings';
import type { SubjectPersonalLease, SubjectRatingWriteOperation } from '../src/features/pages/subject-personal-reader';

const { RatingControlView, applyOptimisticRatingChange } = await import('../src/features/pages/rating-control');
const { RatingsView, BookOverviewRating, RatingsPreviewContext } =
  await import('../src/features/pages/subject-ratings-view');
const { subjectHead } = await import('../src/features/pages/subject-head');
const { subjectOwnRatingQuery, subjectRatingQuery } = await import('../src/features/pages/subject-queries');
const { GLOBAL, QUESTION, preparedRatingReader, readRatings, readOwnRating, writeOwnRating } =
  await import('../src/features/pages/subject-ratings');
const { ResultRow } = await import('../src/search/results');

const subjectId = recorded.subject;
const question: RatingQuestion = {
  id: QUESTION,
  revision: 7,
  label: 'How much did you like this work?',
  grain: 'work',
  scale: { min: 0, max: 40, displayStep: 4 },
};
const ready: PublicFigure = {
  questionId: QUESTION,
  populationId: GLOBAL,
  scale: question.scale,
  count: 5,
  state: 'ready',
  mean: 8.4,
  score: 7.9,
};

function ratingLease(): SubjectPersonalLease {
  let operationId = 0;
  let owner = 0;
  let committed: Awaited<ReturnType<typeof readOwnRating>> | undefined;
  const reader = 'reader-a';
  const scope = { reader, admission: 1, view: 'overview', cacheEpoch: 0 } as const;
  return {
    key: JSON.stringify([subjectId, 'en', reader, 1]),
    reader,
    subjectId,
    locale: 'en',
    view: 'overview',
    scope,
    isCurrent: () => true,
    retire: () => {},
    beginRatingWrite: (before) => {
      if (committed === undefined) committed = before;
      const id = ++operationId;
      owner = id;
      const operation: SubjectRatingWriteOperation = {
        id,
        sequence: id,
        ownsCache: () => owner === id,
        commit: (value) => {
          committed = value;
          if (owner === id) owner = 0;
        },
        rollback: (fallback) => {
          if (owner !== id) return null;
          owner = 0;
          return committed ?? fallback;
        },
        preserveUncertainty: (value) => {
          committed = value;
          if (owner === id) owner = 0;
        },
      };
      return operation;
    },
  };
}

test('question-driven save and clear include zero, enforce the live scale and preserve private session behavior', async () => {
  const requests: Request[] = [];
  let stored: number | null = null;
  const client = createKernelClient('https://kernel.example', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname === `/v1/rating-questions/${QUESTION}`) return Response.json(question);
      expect(request.headers.get('authorization')).toBe('Bearer reader');
      expect(new URL(request.url).pathname).toBe(`/v1/subjects/${subjectId}/ratings/${QUESTION}/vote`);
      if (request.method === 'GET')
        return stored === null
          ? Response.json({ code: 'not_found' }, { status: 404 })
          : Response.json({ units: stored, revision: 1, at: '2026-10-31T00:00:00Z' });
      expect(request.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/i);
      stored = request.method === 'DELETE' ? null : (await request.json()).units;
      return stored === null
        ? new Response(null, { status: 204 })
        : Response.json({ units: stored, revision: 1, at: '2026-10-31T00:00:00Z' });
    },
  });
  const html = renderToStaticMarkup(
    createElement(RatingControlView, {
      question,
      subjectId,
      locale: 'en',
      returnTo: `/en/subjects/${subjectId}/kokoro`,
      state: { kind: 'ready', units: 0 },
      pending: false,
      failure: null,
      onSet: () => {},
      onClear: () => {},
    }),
  );
  expect(html).toContain(`aria-label="${question.label}"`);
  expect(html).toContain('max="40"');
  expect(html).toContain('step="4"');
  expect(html).toContain('0 out of 10');
  expect(html).toContain('method="post"');

  const cache = new QueryClient();
  const binding = ratingLease();
  const ownKey = subjectOwnRatingQuery(subjectId, 'en', binding.scope).queryKey;
  const publicKey = subjectRatingQuery(subjectId, 'en').queryKey;
  cache.setQueryData(ownKey, { reader: binding.reader, kind: 'ready', units: null });
  cache.setQueryData(publicKey, { figure: ready });
  for (const units of [0, 40, null]) {
    expect(
      await applyOptimisticRatingChange({
        queryClient: cache,
        subjectId,
        locale: 'en',
        binding,
        units,
        write: ({ units, idempotencyKey }) => writeOwnRating(client, subjectId, 'Bearer reader', units, idempotencyKey),
        onFailure: () => {
          throw new Error('The valid vote was rejected');
        },
      }),
    ).toBe(true);
    expect(stored).toBe(units);
    expect(cache.getQueryData(ownKey)).toEqual({ reader: binding.reader, kind: 'ready', units });
    expect(cache.getQueryData(publicKey)).toEqual({ figure: ready });
    const request = new Request('https://site.example', { headers: { authorization: 'Bearer reader' } });
    const reader = await preparedRatingReader(request, 'Bearer reader');
    expect(await readOwnRating(client, request, {}, subjectId)).toEqual({ reader, kind: 'ready', units });
  }
  expect(await writeOwnRating(client, subjectId, 'Bearer reader', 2, crypto.randomUUID())).toBe(false);
  expect(requests.filter((request) => ['PUT', 'DELETE'].includes(request.method))).toHaveLength(3);
  const before = cache.getQueryData(ownKey);
  expect(
    await applyOptimisticRatingChange({
      queryClient: cache,
      subjectId,
      locale: 'en',
      binding,
      units: 4,
      write: async () => false,
      onFailure: () => {},
    }),
  ).toBe(false);
  expect(cache.getQueryData(ownKey)).toEqual(before);
  cache.clear();
});

test('an uncertain private vote preserves only its own value and leaves public figures untouched', async () => {
  const cache = new QueryClient();
  const binding = ratingLease();
  const ownKey = subjectOwnRatingQuery(subjectId, 'en', binding.scope).queryKey;
  const publicKey = subjectRatingQuery(subjectId, 'en').queryKey;
  cache.setQueryData(ownKey, { reader: binding.reader, kind: 'ready', units: 8 });
  cache.setQueryData(publicKey, { figure: ready });
  let writes = 0;
  const failures: { uncertain: boolean }[] = [];

  await expect(
    applyOptimisticRatingChange({
      queryClient: cache,
      subjectId,
      locale: 'en',
      binding,
      units: 12,
      write: async () => {
        writes++;
        throw new Error('The vote may have reached the server');
      },
      onFailure: (failure) => failures.push(failure),
    }),
  ).resolves.toBe(false);

  expect(writes).toBe(1);
  expect(failures).toEqual([{ uncertain: true }]);
  expect(cache.getQueryData(ownKey)).toEqual({ reader: binding.reader, kind: 'ready', units: 12 });
  expect(cache.getQueryData(publicKey)).toEqual({ figure: ready });
  expect(cache.getQueryState(publicKey)?.isInvalidated).toBe(false);
  cache.clear();
});

test('subject and Search render published ready, pending and below-threshold figures with independent imports and metadata', async () => {
  for (const figure of [
    ready,
    { ...ready, mean: 0, score: null },
    { ...ready, mean: null, score: null, count: 3, state: 'insufficient_data' },
    { ...ready, mean: null, score: null, count: 0, state: 'updating' },
    { ...ready, mean: null, score: null, count: 0, state: 'insufficient_data' },
  ] satisfies PublicFigure[]) {
    const requests: string[] = [];
    const client = createKernelClient('https://kernel.example', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push(path);
        expect(request.headers.has('authorization')).toBe(false);
        expect(path.endsWith('/vote')).toBe(false);
        if (path.startsWith('/v1/rating-questions/')) return Response.json(question);
        if (path.endsWith('/figure')) return Response.json({ figure });
        // Deliberately newer aggregate values must never replace the published headline.
        if (path.endsWith('/ratings'))
          return Response.json({
            question: QUESTION,
            subject: subjectId,
            figures: [
              {
                population: GLOBAL,
                count: 9,
                mean: 12,
                histogram: [9],
                freshness: { asOf: '2026-10-31T00:00:00Z', updating: true },
              },
            ],
          });
        if (path.endsWith('/source-statistics'))
          return Response.json([
            {
              source: 'vndb',
              sourceRecordId: 'v4',
              scale: { min: 1, max: 100 },
              mean: 87,
              count: 267,
              asOf: '2026-10-20',
              licence: 'ODbL-1.0',
              attribution: 'VNDB contributors',
            },
          ]);
        throw new Error(`Unexpected request: ${path}`);
      },
    });
    const data = await readRatings(client, subjectId);
    expect(data).not.toBeNull();
    if (!data) throw new Error('Expected published rating data');
    expect(requests).toHaveLength(4);
    const subject = renderToStaticMarkup(
      createElement(RatingsView, {
        data,
        id: 'ratings',
        subject: subjectId,
        locale: 'en',
      }),
    );
    const search = renderToStaticMarkup(
      createElement(ResultRow, {
        hit: { id: subjectId, type: 'schema:Book', labels: { en: 'Kokoro' }, figure },
        locale: 'en',
        hitTypes: {},
        yearProperties: [],
      }),
    );
    const head = subjectHead(recorded, {
      origin: 'https://site.example',
      locale: 'en',
      path: `/en/subjects/${subjectId}/kokoro`,
      ...(data.figure.kind === 'ready' ? { ratings: { figure: data.figure.value } } : {}),
    });
    const metadata = JSON.parse(head.scripts[0]!.children);
    for (const html of [subject, search]) {
      expect(html).not.toContain('7.9');
      expect(html).not.toContain('Your rating');
      if (figure.state === 'ready') {
        expect(html).toContain(`${figure.mean} out of 10`);
        expect(html).toContain('Global');
        expect(html).toContain('5 ratings');
        expect(metadata.aggregateRating).toMatchObject({ ratingValue: figure.mean, ratingCount: 5, bestRating: 10 });
      } else {
        expect(html).not.toContain('out of 10');
        expect(metadata).not.toHaveProperty('aggregateRating');
        if (figure.state === 'updating') expect(html).toContain('publication is updating');
        if (figure.count === 3) expect(html).toContain('3 ratings');
        if (figure.count === 0) expect(html).not.toContain('0 ratings');
      }
    }
    expect(subject).toContain('Revision 7');
    expect(subject).toContain('Bayesian');
    expect(subject).toContain('after processing');
    for (const detail of ['VNDB', '87', '100', '267', '2026', 'ODbL-1.0', 'VNDB contributors'])
      expect(subject).toContain(detail);
    expect(search).not.toContain('VNDB');
    if (figure.state !== 'ready') expect(subject).not.toContain('data-slot="histogram"');
  }
});

test('horizontal distribution keeps semantic localized bucket counts, true scale steps and all-zero bars', async () => {
  const { RatingDistribution } = await import('../src/features/pages/rating-distribution');
  const { createRequire } = await import('node:module');
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const histogram = [0, 1203, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const values of [histogram, histogram.map(() => 0)]) {
    const html = renderToStaticMarkup(
      createElement(RatingDistribution, {
        headline: { ...ready, count: 1203 },
        question,
        locale: 'de',
        figure: {
          population: GLOBAL,
          count: 1203,
          mean: 4,
          histogram: values,
          freshness: { asOf: null, updating: false },
        },
      }),
    );
    const window = new Window();
    window.document.body.innerHTML = html;
    try {
      const list = window.document.querySelector('ol')!;
      expect(list.getAttribute('aria-label')).toBeTruthy();
      const rows = Array.from(list.querySelectorAll('li'));
      expect(rows).toHaveLength(11);
      expect(rows.map((row) => row.firstElementChild!.textContent)).toEqual(
        Array.from({ length: 11 }, (_, index) => String(index)),
      );
      expect(rows[0]!.textContent).toContain('0');
      expect(rows[1]!.textContent).toContain(new Intl.NumberFormat('de').format(values[1]!));
      for (const row of rows) {
        const visual = row.querySelector('[aria-hidden="true"]')!;
        expect(visual.textContent).toBe('');
        expect(row.lastElementChild!.textContent!.trim()).toBeTruthy();
      }
      expect(html).not.toMatch(/NaN|Infinity|canvas/);
      if (values.every((value) => value === 0)) {
        expect(html.match(/width:0%/g)).toHaveLength(11);
        expect(html).not.toContain('width:100%');
      } else expect(html).toContain('width:100%');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('unpublished, ineligible, stale, threshold and absent distributions render no histogram or inferred buckets', async () => {
  const { RatingDistribution } = await import('../src/features/pages/rating-distribution');
  const eligible = {
    population: GLOBAL,
    count: ready.count,
    mean: 32,
    histogram: [0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0],
    freshness: { asOf: null, updating: false },
  };
  const cases = [
    { headline: { ...ready, state: 'updating', mean: null }, figure: eligible },
    { headline: { ...ready, state: 'insufficient_data', count: 3, mean: null }, figure: eligible },
    { headline: { ...ready, populationId: 'another-context' }, figure: eligible },
    { headline: { ...ready, questionId: 'another-question' }, figure: eligible },
    { headline: ready, figure: { ...eligible, remaining: 2 } },
    { headline: ready, figure: { ...eligible, freshness: { asOf: null, updating: true } } },
    { headline: ready, figure: { ...eligible, count: ready.count + 1 } },
    { headline: ready, figure: { population: GLOBAL, count: ready.count, mean: 32, freshness: eligible.freshness } },
    { headline: ready, figure: { ...eligible, histogram: [5] } },
    { headline: ready, figure: { ...eligible, histogram: eligible.histogram.map(() => -1) } },
    { headline: ready, figure: undefined },
  ] satisfies { headline: PublicFigure; figure: import('../src/features/pages/subject-ratings').Figure | undefined }[];
  for (const item of cases) {
    const html = renderToStaticMarkup(createElement(RatingDistribution, { ...item, question, locale: 'en' }));
    expect(html).toBe('');
  }
});

test('Book identity preserves absent, unavailable and unpublished public ratings instead of inventing a score', () => {
  const render = (data: import('../src/features/pages/subject-ratings').RatingSources | null | undefined) =>
    renderToStaticMarkup(
      createElement(
        RatingsPreviewContext.Provider,
        { value: data },
        createElement(BookOverviewRating, { subject: subjectId, locale: 'en' }),
      ),
    );
  expect(render(undefined)).toBe('');
  expect(render(null)).toContain('data-state="failed"');
  const sources = { question: { kind: 'absent' }, global: { kind: 'absent' }, statistics: { kind: 'absent' } } as const;
  const unavailable = render({ ...sources, figure: { kind: 'unavailable' } });
  expect(unavailable).toContain('data-state="unavailable"');
  expect(unavailable).not.toContain('data-slot="public-rating-figure"');
  const unpublished = render({
    ...sources,
    figure: { kind: 'ready', value: { ...ready, count: 3, mean: null, score: null, state: 'insufficient_data' } },
  });
  expect(unpublished).toContain('data-slot="public-rating-figure"');
  expect(unpublished).not.toContain('<strong');
});
