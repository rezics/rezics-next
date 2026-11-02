import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { isWithinGlobalSearchQueryLimit } from '../src/search/query-text-limit';
import { validSuggestionText } from '../src/search/typeahead';
import type { RecentHistory } from '../src/search/recent-history';

test('global search keeps over-limit drafts correctable and submits only within its UTF-8 budget', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search', width: 1200, height: 800 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    FormData: window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const { m } = await import('../src/paraglide/messages.js');
  const supported = `${'界'.repeat(170)}ab`;
  const overLimit = '界'.repeat(171);
  expect(isWithinGlobalSearchQueryLimit(supported)).toBe(true);
  expect(isWithinGlobalSearchQueryLimit(overLimit)).toBe(false);
  expect(isWithinGlobalSearchQueryLimit('a'.repeat(129))).toBe(true);
  expect(validSuggestionText('a'.repeat(129))).toBe(false);

  const remembered: string[] = [];
  const navigated: string[] = [];
  const history = { remember: (query: string) => remembered.push(query) } as unknown as RecentHistory;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () =>
    root.render(createElement(HeaderSearch, { locale: 'en', history, onNavigate: (href) => navigated.push(href) })),
  );

  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const form = input.form!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, overLimit);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(input.maxLength).toBe(-1);
  expect(input.value).toBe(overLimit);
  const invalid = new window.Event('submit', { bubbles: true, cancelable: true });
  await act(async () => void form.dispatchEvent(invalid));
  expect(invalid.defaultPrevented).toBe(true);
  expect(host.textContent).toContain(m.search_query_limit_error());
  expect(remembered).toEqual([]);
  expect(navigated).toEqual([]);

  await act(async () => {
    setValue.call(input, supported);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(input.value).toBe(supported);
  expect(host.textContent).not.toContain(m.search_query_limit_error());
  const valid = new window.Event('submit', { bubbles: true, cancelable: true });
  await act(async () => void form.dispatchEvent(valid));
  expect(valid.defaultPrevented).toBe(true);
  expect(remembered).toEqual([supported]);
  expect(new URL(navigated[0]!, window.location.origin).searchParams.get('q')).toBe(supported);
  await act(async () => root.unmount());
});
