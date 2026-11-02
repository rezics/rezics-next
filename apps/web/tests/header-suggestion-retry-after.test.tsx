import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../src/media/kernel';
import { suggestionResponse, readSubjectSuggestions } from '../src/search/suggestions';
import { loadGlobalHeaderSuggestions, type HeaderSuggestionLoader } from '../src/search/header-search/suggestions';
import { searchRetryAt } from '../src/search/search-recovery-retry';
import type { SuggestionResult } from '../src/search/suggestions';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

const emptyResult: SuggestionResult = { as_of: '2026-11-03T00:00:00Z', subjects: [], types: {} };
const problemBody = { type: 'about:blank', title: 'Unavailable', status: 503, code: 'dependency_unavailable' };

test('native suggestion Retry-After survives both transports and parses numeric, date, malformed, and missing values', async () => {
  const date = new Date(Date.now() + 15_000).toUTCString();
  const cases: (string | undefined)[] = ['5', date, 'tomorrow', undefined];
  const originalFetch = globalThis.fetch;
  try {
    for (const retryAfter of cases) {
      const headers = new Headers({ 'x-native-only': 'discard' });
      if (retryAfter !== undefined) headers.set('retry-after', retryAfter);
      const client = {
        subjects: {
          $suggest: {
            get: async () => ({
              error: { value: { code: 'dependency_unavailable' } },
              status: 503,
              headers,
            }),
          },
        },
      } as unknown as KernelClient;
      const response = await suggestionResponse(
        new Request('https://site.test/api/search/suggestions?q=Prince'),
        {},
        async (_query, request) => {
          const value = await readSubjectSuggestions(
            client,
            { q: 'Prince', limit: 8, languages: ['en'] },
            null,
            request.signal,
          );
          return { ...value, types: {} };
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-native-only')).toBeNull();
      expect(response.headers.get('retry-after')).toBe(retryAfter ?? null);
      globalThis.fetch = async () => response.clone();

      let failure: unknown;
      try {
        await loadGlobalHeaderSuggestions('Prince', 'en', new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MediaProblem);
      const mediaFailure = failure as MediaProblem;
      expect(mediaFailure.problem).toMatchObject({ status: 503, code: 'dependency_unavailable' });
      expect(new Headers(mediaFailure.headers).get('retry-after')).toBe(retryAfter ?? null);
      const retryAt = searchRetryAt(retryAfter ?? null, Date.now());
      if (retryAfter === '5') expect(retryAt).toBeDefined();
      else if (retryAfter === date) expect(retryAt).toBe(Date.parse(date));
      else expect(retryAt).toBeUndefined();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mounted manual retry waits for the current deadline, while replacement and unmount retire it', async () => {
  const window = new Window({ url: 'https://site.test/en/search', width: 1280 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let unmounted = false;
  const calls: string[] = [];
  const load: HeaderSuggestionLoader = async (query) => {
    calls.push(query);
    if (calls.length === 1)
      throw new MediaProblem(problemBody, { 'retry-after': '1' });
    if (calls.length === 2) return emptyResult;
    if (calls.length === 3) throw new MediaProblem(problemBody, { 'retry-after': '2' });
    if (calls.length === 4) throw new Error('injected failure without Retry-After');
    return emptyResult;
  };
  const render = (initialQuery: string) =>
    root.render(
      <HeaderSearch
        locale="en"
        initialQuery={initialQuery}
        history={{ entries: [], persistence: 'memory', sync: 'local-only', remember() {}, remove() {}, retry() {} }}
        loadSuggestions={load}
      />,
    );
  const pause = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const retry = () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry())!;
  try {
    await act(async () => render('Prince'));
    const input = host.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;
    await act(async () => input.focus());
    await pause(230);
    expect(calls).toEqual(['Prince']);
    expect(retry().disabled).toBe(true);
    expect(host.textContent).toContain(m.settings_retry_wait());
    retry().click();
    expect(calls).toEqual(['Prince']);

    await pause(1_100);
    expect(calls).toEqual(['Prince']);
    expect(retry().disabled).toBe(false);
    expect(host.textContent).not.toContain(m.settings_retry_wait());
    await act(async () => retry().click());
    await pause(230);
    expect(calls).toEqual(['Prince', 'Prince']);

    await act(async () => render('Replacement'));
    await pause(230);
    expect(retry().disabled).toBe(true);
    await act(async () => render('Newest'));
    await pause(230);
    expect(calls).toEqual(['Prince', 'Prince', 'Replacement', 'Newest']);
    expect(retry().disabled).toBe(false);
    expect(host.textContent).not.toContain(m.settings_retry_wait());
    await act(async () => retry().click());
    await pause(230);
    expect(calls).toHaveLength(5);

    await act(async () => root.unmount());
    unmounted = true;
    await pause(1_800);
    expect(calls).toHaveLength(5);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.close();
  }
});
