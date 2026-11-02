import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import {
  HEADER_SUGGESTION_LIMIT,
  readHeaderSuggestions,
  type HeaderSuggestionLoader,
} from '../src/search/header-search/suggestions';
import type { SearchScope } from '../src/search/header-search/types';
import type { SuggestionResult } from '../src/search/suggestions';

const id = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const first = '123e4567-e89b-12d3-a456-426614174000';
const second = '123e4567-e89b-12d3-a456-426614174001';
const refusal = { name: 'TypeError', message: 'Malformed suggestion page' };
const row = (
  index: number,
  extra: Partial<SuggestionResult['subjects'][number]> = {},
): SuggestionResult['subjects'][number] => ({
  id: id(index),
  type: 'schema:Book',
  labels: { en: `Book ${index}` },
  summary: null,
  ...extra,
});
const summary = (subjectId: string, type = 'schema:Book') => ({
  id: subjectId,
  type,
  types: ['schema:Book'],
  label: null,
  creativeWork: true,
  cover: null,
});
const page = (subjects: unknown): SuggestionResult =>
  ({
    as_of: '2026-10-31T00:00:00.000Z',
    subjects,
    types: { 'schema:Book': { en: 'Book' } },
  }) as SuggestionResult;
const read = (
  value: unknown,
  query = 'Book',
  locale = 'en',
  signal: AbortSignal = new AbortController().signal,
  scope?: SearchScope,
) => readHeaderSuggestions(async () => value as SuggestionResult, query, locale, signal, scope);

test('every installed header suggestion loader is admitted before truncation', async () => {
  await expect(read({ ...page([]), subjects: null })).rejects.toMatchObject(refusal);
  await expect(read(page([{ ...row(0), labels: { en: 4 } }]))).rejects.toMatchObject(refusal);
  await expect(
    read(
      page(Array.from({ length: 9 }, (_, index) => (index === 8 ? { ...row(index), id: 'not-a-uuid' } : row(index)))),
    ),
  ).rejects.toMatchObject(refusal);
  await expect(read(page([row(0, { id: first, summary: summary(second) })]))).rejects.toMatchObject(refusal);
  await expect(
    read(page([row(0, { id: first, type: 'person', summary: summary(first, 'organization') })])),
  ).rejects.toMatchObject(refusal);
  await expect(read(page([row(0, { id: first }), row(1, { id: first.toUpperCase() })]))).rejects.toMatchObject(refusal);

  expect((await read(page([]))).subjects).toEqual([]);
  expect((await read(page([row(1)]))).subjects[0]?.summary).toBeNull();
  const native = Array.from({ length: 10 }, (_, index) =>
    index === 0
      ? row(0, {
          summary: summary(id(0)),
          facts: { 'schema:datePublished': [{ kind: 'time' as const, year: 1943 }] },
        })
      : row(index),
  );
  const limited = await read(page(native));
  expect(limited.subjects).toHaveLength(HEADER_SUGGESTION_LIMIT);
  expect(limited.subjects[0]?.summary).toEqual(summary(id(0)));
  expect(limited.subjects[0]?.facts).toEqual({ 'schema:datePublished': [{ kind: 'time', year: 1943 }] });
  expect(limited.subjects.at(-1)?.id).toBe(id(7));

  const scope: SearchScope = {
    kind: 'Collection',
    id: 'reading',
    name: 'Reading list',
    searchAction: '/en/search?collection=reading',
  };
  const calls: unknown[] = [];
  const scoped = await readHeaderSuggestions(
    async (query, locale, signal, received) => {
      calls.push({ query, locale, aborted: signal.aborted, scope: received });
      return page([row(0)]);
    },
    'Prince',
    'zh-Hans',
    new AbortController().signal,
    scope,
  );
  expect(calls).toEqual([{ query: 'Prince', locale: 'zh-Hans', aborted: false, scope }]);
  expect(scoped.subjects).toEqual([row(0)]);

  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  const late = readHeaderSuggestions(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    'old',
    'en',
    controller.signal,
  );
  controller.abort();
  finish({ subjects: null });
  await expect(late).rejects.toHaveProperty('name', 'AbortError');
});

test('mounted typeahead recovers from a malformed scoped page on explicit retry', async () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((ok) => {
      resolve = ok;
    });
    return { promise, resolve };
  }
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search', width: 1280 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  await setLocale('en', { reload: false });
  const requests: ReturnType<typeof deferred<SuggestionResult>>[] = [];
  const scope: SearchScope = {
    kind: 'Collection',
    id: 'reading',
    name: 'Reading list',
    searchAction: '/en/search?collection=reading',
  };
  const loadScoped: HeaderSuggestionLoader = (query, locale, _signal, received) => {
    expect({ query, locale, scope: received }).toEqual({ query: 'Prince', locale: 'en', scope });
    const request = deferred<SuggestionResult>();
    requests.push(request);
    return request.promise;
  };
  let globalCalls = 0;
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () =>
      root.render(
        createElement(HeaderSearch, {
          locale: 'en',
          initialQuery: 'Prince',
          scope,
          history: { entries: [], persistence: 'memory', sync: 'local-only', remember() {}, remove() {} },
          loadSuggestions: async () => {
            globalCalls++;
            return page([]);
          },
          loadScopedSuggestions: loadScoped,
          onNavigate() {},
        }),
      ),
    );
    await act(async () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!.focus());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 230)));
    await act(async () => requests.at(-1)!.resolve(page([{ ...row(0), labels: { en: 4 } }])));
    expect(host.textContent).toContain(m.search_suggestions_failed());
    expect(host.querySelector('[role="option"]')).toBeNull();
    expect(host.querySelector('form')?.getAttribute('action')).toBe(scope.searchAction);
    expect(globalCalls).toBe(0);
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry())!;
    await act(async () => retry.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 230)));
    await act(async () => requests.at(-1)!.resolve(page([row(0, { labels: { en: 'Recovered' } })])));
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Recovered');
    expect(host.querySelector('form')?.getAttribute('action')).toBe(scope.searchAction);
    expect(globalCalls).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
