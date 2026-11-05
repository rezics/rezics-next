import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { discoveryRequest } from '../src/search/search-request';
import { discoverySearchHref, searchLoaderDeps } from '../src/search/search-params';
import { SearchRecovery } from '../src/search/search-recovery-view';
import { Refinement } from '../src/search/refinement/refinement';
import { readFacetPage } from '../src/search/refinement/request';
import { m } from '../src/paraglide/messages.js';
import {
  facetSearchInvalidation,
  readSearchOutcome,
  searchPageForRecovery,
  searchRecoveryFromResponse,
  searchRetryAt,
  searchUnavailablePage,
  type SearchRecoveryState,
} from '../src/search/search-recovery';
import type { SearchPageData } from '../src/search/search';

const tree = { not: { type: { in: ['schema:Movie'] } } };
const state = searchLoaderDeps({
  q: '  original | 原文  ',
  condition: JSON.stringify(tree),
  language: ['ja', 'en'],
  kinds: ['schema:Book'],
  sort: 'rating',
  cursor: 'native+/= opaque',
  'f.schema:inLanguage': ['ja'],
});
const request = discoveryRequest(state, ['en']);

test('actual SDK failures preserve the submitted query and distinguish admission, session, authority and readiness without retries', async () => {
  const cases = [
    [400, 'invalid_request', [{ pointer: '/cursor', code: 'invalid_format' }], 'invalid-cursor'],
    [400, 'invalid_request', [{ pointer: '/text', code: 'invalid_format' }], 'invalid'],
    [422, 'unsupported_query', [{ pointer: '/filter/and/0/not/type', code: 'unsupported' }], 'invalid'],
    [401, 'invalid_credentials', [], 'session'],
    [403, 'platform_closed', [], 'closed'],
    [403, 'forbidden', [], 'denied'],
    [409, 'search_restart_required', [], 'restart'],
    [503, 'index_not_ready', [], 'index-not-ready'],
    [503, 'semantic_not_ready', [], 'source-not-ready'],
    [503, 'overloaded', [], 'unavailable'],
  ] as const;
  for (const [status, code, errors, expected] of cases) {
    const calls: { url: string; body: unknown; credential: string | null }[] = [];
    const client = createKernelClient('http://kernel.local', {
      headers: { authorization: 'Bearer original-session' },
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          credential: new Headers(init?.headers).get('authorization'),
        });
        return Response.json({ code, errors }, { status, headers: { 'retry-after': '1' } });
      },
    });
    const before = Date.now();
    const outcome = await readSearchOutcome(request, (body) => client.subjects.$search.post(body));
    expect(outcome.recovery.status).toBe(expected);
    if (outcome.recovery.status === 'ready') throw new Error('A native refusal became success');
    expect(outcome.recovery.problem).toMatchObject({ code, errors: [...errors] });
    expect(outcome.recovery.retryAt).toBeGreaterThanOrEqual(before + 1000);
    expect(outcome.discovery).toBeUndefined();
    expect(outcome.result).toBeUndefined();
    expect(calls).toEqual([
      { url: 'http://kernel.local/v1/subjects:search', body: request, credential: 'Bearer original-session' },
    ]);
  }
});

test('restart removes only continuation, while readiness retry transports the original opaque cursor and all predicates', () => {
  const retry = new URL(discoverySearchHref('en', state), 'https://example.test');
  const restart = new URL(discoverySearchHref('en', { ...state, cursor: undefined }), retry);
  expect(retry.searchParams.get('cursor')).toBe('native+/= opaque');
  expect(restart.searchParams.get('cursor')).toBeNull();
  retry.searchParams.delete('cursor');
  expect(restart.href).toBe(retry.href);
  expect(JSON.parse(restart.searchParams.get('condition')!)).toEqual(tree);
  expect(restart.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(restart.searchParams.get('sort')).toBe('rating');
  expect(restart.searchParams.get('q')).toBe(state.query);
});

test('native sparse continuations, exhausted continuations, complete empty first pages and malformed responses stay distinct', async () => {
  const pages = [
    discoveryExample,
    { ...discoveryExample, hits: [], next: null },
    { ...discoveryExample, hits: [], next: 'next-page' },
    { ...discoveryExample, next: state.cursor },
    { ...discoveryExample, next: '' },
    { hits: [], next: null },
  ];
  const outcomes = [];
  for (const page of pages) outcomes.push(await readSearchOutcome(request, async () => ({ status: 200, data: page })));
  expect(outcomes.map(({ recovery }) => recovery.status)).toEqual([
    'ready',
    'exhausted',
    'sparse',
    'unavailable',
    'unavailable',
    'unavailable',
  ]);
  expect(outcomes[1]?.recovery).toEqual({ status: 'exhausted', asOf: discoveryExample.as_of });
  expect(outcomes[2]?.recovery).toEqual({ status: 'sparse', asOf: discoveryExample.as_of });
  const legacy = { subjects: [], next: 'next', as_of: discoveryExample.as_of };
  const { representation: _representation, kindPage: _kindPage, ...legacyRequest } = request;
  expect((await readSearchOutcome(legacyRequest, async () => ({ status: 200, data: legacy }))).recovery).toEqual({
    status: 'sparse',
    asOf: discoveryExample.as_of,
  });
  expect(
    (await readSearchOutcome(legacyRequest, async () => ({ status: 200, data: { ...legacy, next: null } }))).recovery,
  ).toEqual({ status: 'exhausted', asOf: discoveryExample.as_of });
  const firstPage = { ...legacyRequest, cursor: undefined };
  expect(
    (await readSearchOutcome(firstPage, async () => ({ status: 200, data: { ...legacy, next: null } }))).recovery,
  ).toEqual({ status: 'ready' });
});

test('current authority and restart invalidation remove hits and independently retained facet labels, while preserving the editable draft', () => {
  const protectedData: SearchPageData = {
    queryState: state,
    condition: tree,
    recovery: { status: 'ready' },
    discovery: { status: 'ready', page: discoveryExample },
    hitTypes: { private: { en: 'Retired hit label' } },
    yearProperties: [],
    typeChoices: [{ id: 'private', labels: { en: 'Retired kind label' } }],
    groups: [{ property: 'private', labels: {}, values: [{ value: 'value', labels: { en: 'Retired value label' } }] }],
    refinement: {
      key: 'same-query',
      properties: [],
      initial: {
        status: 'ready',
        page: {
          as_of: discoveryExample.as_of,
          facets: [
            { property: 'private', values: [{ value: 'value', labels: { en: 'Retired facet label' } }], next: null },
          ],
        },
      },
    },
    selectedFacets: state.facets,
    selectedFacetLabels: { private: { en: { text: 'Retired selected label' } } },
    facetsAvailable: true,
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: 'rating',
  };
  for (const status of ['loading', 'session', 'closed', 'denied', 'restart', 'index-not-ready'] as const) {
    const masked = searchPageForRecovery(protectedData, { status });
    expect(masked.discovery).toBeUndefined();
    expect(masked.result).toBeUndefined();
    expect(masked.refinement).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('Retired');
    expect(masked.queryState).toBe(state);
    expect(masked.condition).toBe(tree);
    expect(masked.selectedFacets).toBe(state.facets);
  }
  expect(searchPageForRecovery(protectedData)).toBe(protectedData);
  expect(searchUnavailablePage(state).queryState).toBe(state);
  expect(searchUnavailablePage(state).condition).toBe(state.condition);
  expect(searchUnavailablePage(state).recovery?.status).toBe('unavailable');
  const metadata = { types: {}, properties: {} };
  expect(searchUnavailablePage(state, metadata).conditionMetadata).toBe(metadata);
  expect(searchUnavailablePage(state, metadata).refinement).toBeUndefined();
  expect(facetSearchInvalidation({ status: 'unavailable', httpStatus: 503, code: 'index_not_ready' })).toBeUndefined();
  expect(
    facetSearchInvalidation({ status: 'unavailable', httpStatus: 401, problem: { code: 'invalid_credentials' } })
      ?.status,
  ).toBe('session');
  expect(facetSearchInvalidation({ status: 'refused', httpStatus: 403, code: 'platform_closed' })?.status).toBe(
    'closed',
  );
  expect(facetSearchInvalidation({ status: 'restart', httpStatus: 409 })?.status).toBe('restart');
});

test('recovery offers appropriate manual actions, honors Retry-After, and never renders unavailable metadata as zero or a successful empty page', () => {
  const retryHref = discoverySearchHref('en', state);
  const restartHref = discoverySearchHref('en', { ...state, cursor: undefined });
  const render = (recovery: SearchRecoveryState) =>
    renderToStaticMarkup(createElement(SearchRecovery, { state: recovery, retryHref, restartHref, onRetry() {} }));
  const waiting = render({ status: 'index-not-ready', retryAt: Date.now() + 60_000 });
  expect(waiting).toContain(m.search_reader_results_unavailable());
  expect(waiting).toContain(m.search_facet_retry());
  expect(waiting).toContain('disabled');
  expect(waiting).toContain('Wait a moment');
  const restart = render({ status: 'restart' });
  expect(restart).toContain('Restart search');
  expect(restart).not.toContain('cursor=');
  const expired = render({ status: 'session' });
  expect(expired).toContain('/auth/sign-in?return_to=');
  for (const status of ['closed', 'denied', 'invalid'] as const) {
    const html = render({ status });
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<button');
  }
  expect(render({ status: 'source-not-ready' })).toContain(m.search_reader_results_unavailable());
  expect(render({ status: 'unavailable' })).toContain(m.search_reader_results_unavailable());
  expect(render({ status: 'sparse' })).toContain(m.search_recovery_sparse());
  expect(render({ status: 'exhausted' })).toContain(m.search_recovery_exhausted());
  expect(render({ status: 'invalid' })).toContain(m.discovery_invalid());
  expect(render({ status: 'unavailable' })).not.toMatch(/0 results|No results|progressbar|%/);
  expect(searchRetryAt('1', 1000)).toBe(2000);
  expect(searchRetryAt('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(3000);
  expect(searchRetryAt('-1', 1000)).toBeUndefined();
  expect(searchRetryAt('invalid', 1000)).toBeUndefined();
  expect(searchRecoveryFromResponse({ status: 503, error: { code: 'index_not_ready' } })).not.toHaveProperty('retryAt');
});

test('scoped facet readiness keeps native Retry-After and the continuation request without implying zero values', async () => {
  const facets = [{ property: 'type', size: 10, cursor: 'facet+/= opaque' }];
  const bodies: unknown[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '60' } });
    },
  });
  const context = { text: state.query, languages: state.languages, facets };
  const before = Date.now();
  const initial = await readFacetPage(context, (body) => client.subjects.$facets.post(body));
  expect(initial.status).toBe('preparing');
  if (initial.status === 'ready') throw new Error('A native refusal became facet success');
  expect(initial.retryAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(bodies).toEqual([context]);
  expect(facetSearchInvalidation(initial)).toBeUndefined();
  let calls = 0;
  const html = renderToStaticMarkup(
    createElement(Refinement, {
      data: {
        key: 'native-preparing',
        properties: [{ property: 'type', labels: {}, mode: 'types', datatype: 'type', units: [] }],
        initial,
      },
      conditions: { facetValues: {} },
      query: state.query,
      locale: 'en',
      load: async () => {
        calls++;
        return initial;
      },
    }),
  );
  expect(html).toContain('Wait a moment');
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).not.toMatch(/0 results|0 values|No results|progressbar|%/);
  expect(calls).toBe(0);
});

test('transport failure stays unavailable and cancellation cannot publish a late ready response', async () => {
  let calls = 0;
  const outcome = await readSearchOutcome(request, async () => {
    calls++;
    throw new Error('offline');
  });
  expect(outcome.recovery.status).toBe('unavailable');
  expect(calls).toBe(1);
  const abort = new DOMException('Cancelled', 'AbortError');
  await expect(
    readSearchOutcome(request, async () => {
      throw abort;
    }),
  ).rejects.toBe(abort);
  const controller = new AbortController();
  let finish!: () => void;
  const pending = readSearchOutcome(
    request,
    async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: 200, data: discoveryExample };
    },
    controller.signal,
  );
  controller.abort(abort);
  finish();
  await expect(pending).rejects.toBe(abort);
});

test('text diagnostics belong to the captured submission, never a replacement, refusal or aborted read', async () => {
  const { diagnoseText } = await import('../../../packages/search-text/src/index.ts');
  const text = '😀 心 "こころ';
  const diagnostic = diagnoseText(text)!;
  const error = {
    code: 'unsupported_query',
    errors: [{ pointer: '/text', code: 'unsupported' }],
    textDiagnostic: diagnostic,
  };
  const submitted = { ...request, text };
  let resolve!: (response: { status: number; error: unknown }) => void;
  const pending = readSearchOutcome(
    submitted,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  submitted.text = 'replacement';
  resolve({ status: 422, error });
  const outcome = await pending;
  expect(outcome.recovery).toMatchObject({ status: 'invalid', textError: { query: text, diagnostic } });
  for (const status of [400, 401, 403, 409, 503]) {
    const refused = await readSearchOutcome({ ...request, text }, async () => ({ status, error }));
    expect(refused.recovery).not.toHaveProperty('textError');
  }
  const stale = await readSearchOutcome(submitted, async () => ({ status: 422, error }));
  expect(stale.recovery).not.toHaveProperty('textError');
  const controller = new AbortController();
  const aborted = readSearchOutcome(
    { ...request, text },
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    controller.signal,
  );
  controller.abort();
  resolve({ status: 422, error });
  await expect(aborted).rejects.toThrow();
});
