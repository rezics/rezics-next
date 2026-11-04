import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchInputRecovery } from '../src/search/search-input-recovery';
import { correctSearchInput, removeSearchInput, searchFormFields, searchLoaderDeps } from '../src/search/search-params';

test('malformed conditions and ranges stay editable and are not omitted from search forms', () => {
  const condition = '{"and":[]}';
  const search = {
    q: 'Mira',
    condition,
    type: 'schema:Book',
    'r.schema:datePublished': '{"gte":"not-a-number"}',
    'f.schema:genre': ['myth'],
    cursor: 'old-hit',
  };
  const deps = searchLoaderDeps(search);
  expect(deps.invalidInput).toEqual({ key: 'condition', value: condition });
  expect(searchFormFields(search)).toEqual([
    ['type', 'schema:Book'],
    ['condition', condition],
    ['r.schema:datePublished', '{"gte":"not-a-number"}'],
    ['f.schema:genre', 'myth'],
  ]);

  for (const issue of [
    deps.invalidInput!,
    { key: 'r.schema:datePublished', value: search['r.schema:datePublished'] },
  ]) {
    const html = renderToStaticMarkup(
      createElement(SearchInputRecovery, {
        parameter: issue.key,
        value: issue.value,
        onApply() {},
        onRemove() {},
      }),
    );
    expect(html).toContain('<textarea');
    expect(html).toContain(issue.value);
    expect(html).toContain('Apply correction');
    expect(html).toContain('Remove this input');
    expect(html).not.toMatch(/FilterError|SyntaxError|stack/i);
  }
});

test('correcting or removing one invalid input keeps other selections and resets the continuation', () => {
  const search = {
    q: 'Mira',
    type: 'schema:Book',
    condition: '{"type":{"in":["schema:Book"]}}',
    'r.schema:datePublished': '{bad json',
    'f.schema:genre': ['myth', 'fable'],
    cursor: 'old-hit',
  };
  expect(correctSearchInput(search, 'r.schema:datePublished', '{"gte":1900}')).toEqual({
    ...search,
    'r.schema:datePublished': '{"gte":1900}',
    cursor: undefined,
  });
  expect(removeSearchInput(search, 'r.schema:datePublished')).toEqual({
    q: 'Mira',
    type: 'schema:Book',
    condition: search.condition,
    'f.schema:genre': ['myth', 'fable'],
    cursor: undefined,
  });
});

test('the text editor retains Unicode input, selects only after failed Apply, and deliberately reapplies every choice', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/ja/search' });
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryTextRecovery } = await import('../src/search/query-text-recovery');
  const { diagnoseText } = await import('../../../packages/search-text/src/index.ts');
  const { discoverySearchHref } = await import('../src/search/search-params');
  const { discoveryRequest } = await import('../src/search/search-request');
  const query = '😀 心 "こころ';
  const state = searchLoaderDeps({
    q: query,
    kinds: ['schema:Book'],
    language: ['zh-Hant', 'ja'],
    condition: '{"type":{"in":["schema:Book"]}}',
    filter: '{"realm":{"id":"018f0000-0000-7000-8000-00a000000001"}}',
    ratingPopulation: '018f0000-0000-7000-8000-00a000000002',
    sort: 'rating',
    'f.schema:inLanguage': ['ja'],
    cursor: 'old-hit',
  });
  const applied: string[] = [];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (value: string, locale = 'ja') =>
    root.render(
      createElement(QueryTextRecovery, {
        key: `${value}:${locale}`,
        value,
        locale,
        diagnostic: diagnoseText(value),
        onApply: (next) => applied.push(discoverySearchHref(locale, { ...state, query: next, cursor: undefined })),
      }),
    );
  await act(async () => render(query));
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const button = host.querySelector<HTMLButtonElement>('button')!;
  expect(input.value).toBe(query);
  expect(window.document.activeElement).not.toBe(input);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const fail = async () => {
    button.focus();
    await act(async () => {
      input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  await fail();
  await act(async () => {
    await window.happyDOM.waitUntilComplete();
  });
  expect(window.document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 6]);
  expect(applied).toEqual([]);
  const fixed = `${query}"`;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, fixed);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(input.getAttribute('aria-invalid')).toBeNull();
  await act(async () => {
    input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(applied).toHaveLength(1);
  const repaired = searchLoaderDeps(Object.fromEntries(new URL(applied[0]!, window.location.origin).searchParams));
  const params = new URL(applied[0]!, window.location.origin).searchParams;
  expect(params.getAll('language')).toEqual(['zh-Hant', 'ja']);
  expect(params.get('q')).toBe(fixed);
  expect(params.get('cursor')).toBeNull();
  expect(params.get('ratingPopulation')).toBe(state.ratingPopulation!);
  expect(discoveryRequest({ ...repaired, languages: params.getAll('language') }, ['en'])).toEqual({
    ...discoveryRequest({ ...state, query: fixed, cursor: undefined }, ['en']),
  });
  await act(async () => render(query));
  const replacementButton = host.querySelector<HTMLButtonElement>('button')!;
  replacementButton.focus();
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    render('replacement', 'zh-Hant');
  });
  await act(async () => {
    await window.happyDOM.waitUntilComplete();
  });
  expect(host.querySelector('textarea')!.value).toBe('replacement');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(window.document.activeElement).not.toBe(host.querySelector('textarea'));
  await act(async () => root.unmount());
});
