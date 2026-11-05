import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { act, createElement, Fragment } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterDocument } from '@rezics/filter';
import { ConditionEditor } from '../src/search/condition-editor';
import { ConditionSavedFilter } from '../src/search/condition-saved-filter';
import { conditionMetadata, conditionAdmission } from '../src/search/condition-editor-model';
import { conditionPresetCatalogue, PRESET_WINDOW } from '../src/search/condition-preset-model';
import { PredicateDescription } from '../src/search/search-context/predicate';
import { SearchCoverage } from '../src/search/search-context/coverage';
import { discoverySearchHref, searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { sessionQuery } from '../src/session/query';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { renderToStaticMarkup } from 'react-dom/server';

async function mounted(
  run: (
    host: HTMLElement,
    render: (element: React.ReactNode) => Promise<void>,
    change: (element: HTMLSelectElement | HTMLInputElement, value: string) => Promise<void>,
  ) => Promise<void>,
) {
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
  const locale = getLocale();
  let root: Root | undefined;
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('div');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    await run(
      host as unknown as HTMLElement,
      async (element) => {
        await act(async () => root!.render(element));
      },
      async (element, value) => {
        await act(async () => {
          const prototype =
            element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
          element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        });
      },
    );
  } finally {
    if (root) await act(async () => root!.unmount());
    setLocale(locale, { reload: false });
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}
const click = (button: HTMLButtonElement) => act(async () => button.click());
const button = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text)!;

test('choose a native released name, inspect, combine, deliberately apply and reopen the authored reference', async () => {
  await mounted(async (host, render, change) => {
    const locale = 'ja';
    expect(getLocale()).toBe('en'); // The explicit surface locale may differ from the ambient route.
    const options = { locale };
    const metadata = conditionMetadata(bundledRelease);
    const ordinary: FilterDocument = { statement: { property: 'schema:datePublished', range: { gte: 1980 } } };
    let draft: FilterDocument | undefined = { and: [ordinary] };
    let applied = searchLoaderDeps({ q: 'animation', cursor: 'old' });
    const draw = () =>
      render(
        createElement(
          Fragment,
          {},
          createElement(ConditionEditor, {
            value: draft,
            metadata,
            locale,
            onChange: (value) => {
              draft = value;
              void draw();
            },
          }),
          createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                applied = { ...applied, condition: draft, cursor: undefined };
                void draw();
              },
            },
            'Apply',
          ),
          createElement(SearchCoverage, {
            state: applied,
            data: { conditionMetadata: metadata, hitTypes: {}, selectedFacetLabels: {} },
            observation: { as_of: '2026-11-05T00:00:00Z' },
            locale,
            refreshHref: '#',
          }),
        ),
      );
    await draw();
    const picker = host.querySelector<HTMLElement>('[data-condition-saved-filter]')!;
    const select = picker.querySelector('select')!;
    const nativeName = bundledRelease.filters!['anime/before-2000']!.labels.ja!;
    const option = Array.from(select.options).find((item) => item.textContent?.includes(nativeName))!;
    expect(option.lang).toBe('ja');
    await change(select, option.value);
    expect(draft).toEqual({ and: [ordinary] });
    await click(button(picker, m.condition_preset_inspect({}, options)));
    expect(picker.textContent).toContain('1999');
    expect(picker.textContent).toContain(metadata.properties['schema:datePublished']!.labels!.ja!);
    expect(picker.querySelector('[role="region"] [lang="ja"]')).not.toBeNull();
    await click(button(picker, m.condition_preset_close({}, options)));
    await click(button(picker, m.condition_saved_filter_add({}, options)));
    expect(draft).toEqual({ and: [ordinary, { saved: option.value }] });
    expect(applied.condition).toBeUndefined();
    expect(conditionAdmission(metadata)(draft, applied)).toEqual([]);
    await click(button(host, 'Apply'));
    const params = new URL(discoverySearchHref(locale, applied), 'https://site.test').searchParams;
    const reopened = searchLoaderDeps(Object.fromEntries(params));
    expect(reopened.condition).toEqual(draft);
    expect(discoveryRequest(reopened, ['ja']).filter).toEqual({ and: [draft!] });
    expect(host.querySelector('[data-search-coverage]')!.textContent).toContain(nativeName);
    // An unfinished editor draft cannot change the applied reference or its explanation.
    draft = { saved: 'anime/all' };
    await draw();
    expect(host.querySelector('[data-search-coverage]')!.textContent).toContain(nativeName);
    draft = reopened.condition;
    await draw();
    expect(host.querySelector('[data-condition-editor]')!.textContent).toContain(nativeName);
  });
});

test('duplicate names, missing labels, finite windows and invalid current definitions keep their exact identities', () => {
  const type: FilterDocument = { type: { in: ['schema:Movie'] } };
  const metadata = conditionMetadata(bundledRelease);
  metadata.filters = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`preset/${i}`, { filter: type, labels: { en: 'Shared name' } }]),
  );
  metadata.filters['unnamed'] = { filter: type };
  metadata.filters['cycle'] = { filter: { saved: 'cycle' } };
  metadata.filters['nested'] = { filter: { saved: 'preset/0' } };
  metadata.filters['obsolete'] = { filter: { type: { in: ['retired:Type'] } } };
  const catalogue = conditionPresetCatalogue(metadata, 'ja');
  expect(catalogue.window('', 0).choices).toHaveLength(PRESET_WINDOW);
  expect(catalogue.window('', 1).choices[0]!.id).toBe('preset/12');
  expect(catalogue.window('preset/29', 0).choices.map(({ id }) => id)).toEqual(['preset/29']);
  expect(catalogue.name('unnamed').text).toBe('unnamed');
  const html = renderToStaticMarkup(
    createElement(ConditionSavedFilter, {
      catalogue,
      owner: {},
      locale: 'ja',
      canSelect: () => true,
      onSelect: () => true,
    }),
  );
  expect(html).toContain('lang="en">Shared name (preset/0)');
  expect(html).toContain('Shared name (preset/1)');
  expect([...html.matchAll(/<option /g)]).toHaveLength(PRESET_WINDOW + 1);
  for (const id of ['missing', 'cycle', 'nested', 'obsolete']) expect(catalogue.preview(id)).toBeUndefined();
  const malformed = conditionMetadata({ ...bundledRelease, filters: { malformed: { filter: { and: [] } } } });
  expect(conditionPresetCatalogue(malformed, 'en').preview('malformed')).toBeUndefined();
  metadata.filters['wide'] = { filter: { and: Array.from({ length: 25 }, () => type) } };
  const bounded = conditionPresetCatalogue(metadata, 'en').preview('wide')!;
  expect(bounded.nodes.size).toBe(16);
  const preview = renderToStaticMarkup(
    createElement(PredicateDescription, {
      value: bounded.value,
      previewNodes: bounded.nodes,
      locale: 'en',
      presentation: {
        property: (id) => id,
        catalogueType: (id) => id,
        discoveryType: (id) => id,
        value: (_property, id) => id,
        conceptScheme: (id) => id,
      },
    }),
  );
  expect(preview).toContain(m.condition_preset_shortened());
  expect(metadata.filters['wide'].filter).toEqual({ and: Array.from({ length: 25 }, () => type) });
});

test('equivalent rerenders retain inspection and focus; reader, request, locale, document and release replacement retire them', async () => {
  await mounted(async (host, render, change) => {
    setLocale('en', { reload: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    let metadata = conditionMetadata(bundledRelease);
    let value: FilterDocument = { and: [{ saved: 'anime/all' }] };
    let requestIdentity = 'first';
    let locale = 'en';
    const draw = () =>
      render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ConditionEditor, {
            metadata,
            value,
            requestIdentity,
            locale,
            onChange(next) {
              value = next!;
              void draw();
            },
          }),
        ),
      );
    const open = async () => {
      await click(button(host, m.condition_preset_inspect({}, { locale: locale as 'en' | 'ja' })));
      expect(host.querySelector('[role="region"]')).not.toBeNull();
    };
    try {
      await draw();
      await open();
      const close = button(host, m.condition_preset_close());
      close.focus();
      await draw();
      expect(host.ownerDocument.activeElement).toBe(close);
      expect(host.querySelector('[role="region"]')).not.toBeNull();
      requestIdentity = 'replacement';
      await draw();
      expect(host.querySelector('[role="region"]')).toBeNull();
      await open();
      value = structuredClone(value);
      await draw();
      expect(host.querySelector('[role="region"]')).toBeNull();
      await open();
      metadata = conditionMetadata({ ...bundledRelease, filters: {} });
      await draw();
      expect(host.textContent).not.toContain('All anime');
      expect(host.textContent).toContain('anime/all');
      await open();
      expect(host.querySelector('[role="region"]')!.textContent).toContain(
        m.condition_saved_filter_unavailable_reference({ id: 'anime/all' }),
      );
      metadata = conditionMetadata(bundledRelease);
      await draw();
      await open();
      locale = 'ja';
      setLocale(locale, { reload: false });
      await draw();
      expect(host.querySelector('[role="region"]')).toBeNull();
      locale = 'en';
      setLocale(locale, { reload: false });
      await draw();
      await open();
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, {
          state: 'signed-in',
          subject: 'replacement',
          csrfToken: 'replacement',
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(host.querySelector('[role="region"]')).toBeNull();
      // A replacement is staged even when its label is available; it never silently repairs the authored ID.
      const picker = host.querySelector('[data-condition-saved-filter]')!;
      await change(picker.querySelector('select')!, 'anime/before-2000');
      expect(value).toEqual({ and: [{ saved: 'anime/all' }] });
      const replace = button(picker as HTMLElement, m.condition_preset_replace());
      replace.focus();
      await click(replace);
      expect(value).toEqual({ and: [{ saved: 'anime/before-2000' }] });
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(host.contains(host.ownerDocument.activeElement)).toBe(true);
    } finally {
      await act(async () => {
        await client.cancelQueries();
        client.clear();
      });
    }
  });
});
