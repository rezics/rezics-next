import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { type FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import {
  CONDITION_POINTER,
  conditionAdmission,
  conditionMetadata,
  conditionSearchState,
} from '../src/search/condition-editor-model';
import { discoverySearchHref, searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { PredicateDescription, rangeDescription } from '../src/search/search-context/predicate';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';

// Mount the receiving editor in its real native form boundary; request/URL assertions use existing adapters.
test('author, combine, repair, apply and reopen precise calendar conditions; semantic replacements retire drafts', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('form');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    const metadata = conditionMetadata(recording.release);
    let value: FilterDocument | undefined = { statement: { property: '', in: [''] } };
    let requestIdentity = 'first';
    const render = () =>
      root!.render(
        createElement(ConditionEditor, {
          value,
          metadata,
          requestIdentity,
          locale: 'en',
          onChange: (next) => {
            value = next;
            render();
          },
        }),
      );
    const field = (suffix: string) =>
      host.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-condition-field-pointer="${CONDITION_POINTER}${suffix}"] input, [data-condition-field-pointer="${CONDITION_POINTER}${suffix}"] select`,
      )!;
    const change = async (element: HTMLInputElement | HTMLSelectElement, text: string) =>
      act(async () => {
        const prototype =
          element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text);
        element.dispatchEvent(new window.Event(element.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true }));
      });
    const button = (text: string) =>
      Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text)!;
    const click = async (text: string) => act(async () => button(text).click());
    const mode = () =>
      Array.from(host.querySelectorAll('select')).find((node) => node.querySelector('option[value="calendar"]'))!;
    const bound = (name = 'gte', path = '') => field(`${path}/statement/range/${name}`) as HTMLInputElement;
    await act(async () => render());
    await change(field('/statement/property'), 'schema:datePublished');
    expect(value).toEqual({ statement: { property: 'schema:datePublished', range: {} } });
    await change(mode(), 'calendar');
    expect(mode().value).toBe('year');
    await click(m.condition_range_replace_confirm());
    expect(mode().value).toBe('calendar');
    expect(host.checkValidity()).toBe(false);
    await change(bound(), '2024-02');
    await change(bound('lte'), '2024-03-01');
    expect(host.checkValidity()).toBe(true);
    expect(host.textContent).toContain(m.condition_calendar_month());
    expect(host.textContent).toContain(m.condition_calendar_day());
    // Wrapping the occurrence preserves raw repair state and every sibling predicate.
    await change(bound(), '2024-02-30');
    const lastExecutable = value;
    expect(host.checkValidity()).toBe(false);
    expect(value).toBe(lastExecutable);
    await change(field(''), 'and');
    expect(bound('gte', '/and/0').value).toBe('2024-02-30');
    await click(m.condition_add_type());
    await change(field('/and/1/type/in/0'), 'schema:Book');
    const combined = value;
    for (const raw of ['2023-02-29', '2024-0', ' 2024', '2025']) {
      await change(bound('gte', '/and/0'), raw);
      expect(bound('gte', '/and/0').value).toBe(raw);
      expect(bound('gte', '/and/0').getAttribute('aria-invalid')).toBe('true');
      expect(host.checkValidity()).toBe(false);
      expect(value).toBe(combined);
    }
    await act(async () => render());
    expect(bound('gte', '/and/0').value).toBe('2025');
    await change(bound('gte', '/and/0'), '2024-02');
    expect(host.checkValidity()).toBe(true);
    let applied = '';
    host.addEventListener('submit', (event: Event) => {
      event.preventDefault();
      applied = host.querySelector<HTMLInputElement>('input[name="condition"]')!.value;
    });
    await click(m.search_apply());
    expect(JSON.parse(applied)).toEqual(value);
    const state = conditionSearchState(searchLoaderDeps({ q: 'books', cursor: 'old' }), value);
    expect(conditionAdmission(metadata)(value, state)).toEqual([]);
    const url = new URL(discoverySearchHref('en', state), 'https://site.test');
    expect(url.searchParams.has('cursor')).toBe(false);
    const restored = searchLoaderDeps(Object.fromEntries(url.searchParams));
    expect(restored.condition).toEqual(value);
    expect(discoveryRequest(restored, ['en']).filter).toEqual({ and: [value] });
    await act(async () => {
      value = restored.condition;
      render();
    });
    expect(bound('gte', '/and/0').value).toBe('2024-02');
    expect(bound('lte', '/and/0').value).toBe('2024-03-01');
    await change(bound('gte', '/and/0'), ''); // One-sided calendar ranges stay typed.
    expect(host.checkValidity()).toBe(true);
    const open = value;
    await change(bound('lte', '/and/0'), '');
    expect(host.checkValidity()).toBe(false);
    expect(value).toBe(open);
    applied = '';
    await click(m.search_apply());
    expect(applied).toBe('');
    await change(bound('lte', '/and/0'), '+012345-06');
    expect(host.checkValidity()).toBe(true);
    await change(bound('gte', '/and/0'), '-0044');
    expect(host.checkValidity()).toBe(true);
    await change(bound('gte', '/and/0'), '-');
    await act(async () => {
      requestIdentity = 'replacement';
      render();
    });
    expect(bound('gte', '/and/0').value).toBe('-0044');
    expect(host.checkValidity()).toBe(true);
    // Existing numeric years are untouched by mounting, rerendering, or a cancelled transition.
    const numeric: FilterDocument = { statement: { property: 'schema:datePublished', range: { gte: -44, lte: 2024 } } };
    await act(async () => {
      value = numeric;
      render();
    });
    await act(async () => render());
    expect(value).toBe(numeric);
    await change(mode(), 'calendar');
    await click(m.condition_property_change_cancel());
    expect(value).toBe(numeric);
    expect(bound().value).toBe('-44');
    await change(mode(), 'calendar');
    await click(m.condition_range_replace_confirm());
    expect(bound().value).toBe('');
    expect(value).toEqual({ statement: { property: 'schema:datePublished', range: { type: 'time' } } });
    expect(host.checkValidity()).toBe(false);
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

test('applied coverage preserves inclusive open endpoints and independently localized precision and overlap meaning', () => {
  const range = { type: 'time' as const, gte: '2024-02', lte: '2024-02-29' };
  for (const locale of locales) {
    const options = { locale };
    const description = rangeDescription(range, locale);
    expect(description).toContain(`≥ 2024-02 (${m.condition_calendar_month({}, options)})`);
    expect(description).toContain(`≤ 2024-02-29 (${m.condition_calendar_day({}, options)})`);
    expect(description).toContain(m.condition_calendar_overlap({}, options));
    expect(rangeDescription({ type: 'time', lte: '-0044' }, locale)).toContain(m.condition_calendar_open({}, options));
    const markup = renderToStaticMarkup(
      createElement(PredicateDescription, {
        value: { statement: { property: 'schema:datePublished', range } },
        locale,
        label: () => 'Publication date',
      }),
    );
    expect(markup).toContain('Publication date');
    expect(markup).toContain(m.condition_range_calendar_mode({}, options));
  }
  expect(rangeDescription({ gte: 1900, lte: 2024 })).toBe('≥ 1900 ≤ 2024');
});
