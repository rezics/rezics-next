import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { act, createElement, useState, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { m } from '../src/paraglide/messages.js';
import { ConditionEditor } from '../src/search/condition-editor';
import { CONDITION_POINTER, conditionAdmission, conditionMetadata } from '../src/search/condition-editor-model';
import { HeaderSearchFilterProvider } from '../src/search/header-search/filter-region';
import { Refinement } from '../src/search/refinement/refinement';
import { refinementProperties, type RefinementConditions } from '../src/search/refinement/model';
import { SearchCoverage } from '../src/search/search-context/coverage';
import { searchLoaderDeps } from '../src/search/search-params';

const units = {
  seconds: 'http://www.wikidata.org/entity/Q11574',
  minutes: 'http://www.wikidata.org/entity/Q7727',
  metres: 'http://www.wikidata.org/entity/Q11573',
  centimetres: 'http://www.wikidata.org/entity/Q174728',
} as const;
const as_of = '2026-10-31T00:00:00Z';

async function mounted(
  run: (
    host: HTMLElement,
    render: (element: ReactNode) => Promise<void>,
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
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('div');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    await run(
      host as unknown as HTMLElement,
      async (element) => act(async () => root!.render(element)),
      async (element, value) =>
        act(async () => {
          const prototype =
            element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
          element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        }),
    );
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}

const click = (button: HTMLButtonElement) => act(async () => button.click());
const button = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)!;

test('a unitless count stays explicit through open-bound Apply, combination, reopen, and executed coverage', async () => {
  await mounted(async (host, render, change) => {
    const metadata = conditionMetadata(recording.release);
    const definition = refinementProperties(recording.release, 'schema:Book').find(
      (entry) => entry.property === 'schema:wordCount',
    )!;
    const language = refinementProperties(recording.release, 'schema:Book').find(
      (entry) => entry.property === 'schema:inLanguage',
    )!;
    const conditions: RefinementConditions = {
      type: 'schema:Book',
      facetValues: { 'schema:inLanguage': ['en'] },
      ranges: { 'schema:wordCount': { gte: 300, unit: '1' } },
    };
    const initial = {
      status: 'ready' as const,
      page: {
        facets: [
          { property: definition.property, values: [], next: null },
          { property: language.property, values: [{ value: 'en', labels: { en: 'English' } }], next: null },
        ],
        as_of,
      },
    };
    const navigations: string[] = [];
    const draw = (next: RefinementConditions) =>
      render(
        createElement(HeaderSearchFilterProvider, {
          children: createElement(Refinement, {
            data: { key: 'released-count', properties: [definition, language], initial },
            conditions: next,
            query: 'books',
            locale: 'en',
            load: async () => initial,
            onNavigate: (href: string) => navigations.push(href),
          }),
        }),
      );

    await draw(conditions);
    expect(host.querySelector<HTMLInputElement>('input[value="en"]')?.checked).toBe(true);
    const lower = host.querySelector<HTMLInputElement>('input[type="number"][id$="-lower"]')!;
    const upper = host.querySelector<HTMLInputElement>('input[type="number"][id$="-upper"]')!;
    expect(host.textContent).toContain('Unitless count (1)');
    expect(lower.value).toBe('300');
    await change(lower, '400');
    await change(upper, '200');
    await click(button(host, m.search_apply()));
    expect(navigations).toHaveLength(0);
    expect(host.textContent).toContain(m.refinement_invalid_range());
    expect(lower.value).toBe('400');
    expect(upper.value).toBe('200');

    await change(lower, '');
    await change(upper, '');
    await click(button(host, m.search_apply()));
    expect(navigations).toHaveLength(0);
    expect(lower.value).toBe('');
    expect(upper.value).toBe('');

    await change(lower, '400');
    await click(button(host, m.search_apply()));
    expect(navigations).toHaveLength(1);
    const params = new URL(navigations[0]!, 'https://site.test').searchParams;
    const reopened = searchLoaderDeps(Object.fromEntries(params));
    expect(reopened.type).toBe('schema:Book');
    expect(reopened.ranges).toEqual({ 'schema:wordCount': { gte: 400, unit: '1' } });
    expect(reopened.facets).toEqual({ 'schema:inLanguage': ['en'] });
    expect(reopened.cursor).toBeUndefined();

    await draw({ type: reopened.type!, facetValues: {}, ranges: reopened.ranges ?? {} });
    expect(host.querySelector<HTMLInputElement>('input[type="number"][id$="-lower"]')!.value).toBe('400');
    expect(host.querySelector<HTMLInputElement>('input[type="number"][id$="-upper"]')!.value).toBe('');
    const state = searchLoaderDeps(Object.fromEntries(params));
    const coverage = renderToStaticMarkup(
      createElement(SearchCoverage, {
        state,
        data: { conditionMetadata: metadata, hitTypes: {}, selectedFacetLabels: {} },
        observation: { as_of },
        locale: 'en',
        refreshHref: '/en/search',
      }),
    );
    expect(coverage).toContain('≥ 400');
    expect(coverage).toContain('Unitless count (1)');
    expect(coverage).not.toContain('≤ 200');
  });
});

test('replacing a multi-unit property unit asks first and keeps the applied range until Apply', async () => {
  await mounted(async (host, render, change) => {
    const definition = refinementProperties(recording.release, 'wd:Q95074').find(
      (entry) => entry.property === 'schema:height',
    )!;
    const initial = {
      status: 'ready' as const,
      page: { facets: [{ property: definition.property, values: [], next: null }], as_of },
    };
    const conditions = {
      type: 'wd:Q95074',
      facetValues: {},
      ranges: { 'schema:height': { gte: 170, lte: 180, unit: units.metres } },
    };
    const navigations: string[] = [];
    await render(
      createElement(HeaderSearchFilterProvider, {
        children: createElement(Refinement, {
          data: { key: 'released-height', properties: [definition], initial },
          conditions,
          query: 'people',
          locale: 'en',
          load: async () => initial,
          onNavigate: (href: string) => navigations.push(href),
        }),
      }),
    );
    const lower = host.querySelector<HTMLInputElement>('input[type="number"][id$="-lower"]')!;
    const upper = host.querySelector<HTMLInputElement>('input[type="number"][id$="-upper"]')!;
    const unit = host.querySelector<HTMLSelectElement>('select[id$="-unit"]')!;
    expect(unit.options[unit.selectedIndex]?.textContent).toBe('m');
    const centimetres = Array.from(unit.options).find((option) => option.value === units.centimetres)!;
    expect(centimetres.textContent).toBe('cm');
    expect(centimetres.title).toBe(units.centimetres);

    await change(unit, units.centimetres);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(m.search_quantity_unit_change_title());
    expect(unit.value).toBe(units.metres);
    expect(lower.value).toBe('170');
    expect(upper.value).toBe('180');
    await click(button(host, m.search_quantity_unit_change_cancel()));
    expect(unit.value).toBe(units.metres);

    await change(unit, units.centimetres);
    await click(button(host, m.search_quantity_unit_change_confirm()));
    expect(unit.value).toBe(units.centimetres);
    expect(lower.value).toBe('170');
    expect(upper.value).toBe('180');
    expect(host.textContent).toContain('≥ 170');
    expect(host.textContent).toContain('m'); // Applied coverage still reflects the executed predicate.
    await click(button(host, m.search_apply()));
    const saved = JSON.parse(new URL(navigations[0]!, 'https://site.test').searchParams.get('r.schema:height')!);
    expect(saved).toEqual({ gte: 170, lte: 180, unit: units.centimetres });
  });
});

test('a retained non-roster unit stays visible and repairs without losing its bound', async () => {
  await mounted(async (host, render, change) => {
    const metadata = conditionMetadata(recording.release);
    metadata.types = { 'wd:Q95074': metadata.types['wd:Q95074']! };
    const state = searchLoaderDeps({ q: 'person' });
    const observation = { as_of };
    let value: FilterDocument = {
      statement: { property: 'schema:height', range: { gte: 170, unit: units.minutes } },
    };
    function Harness() {
      const [current, setCurrent] = useState(value);
      return createElement(ConditionEditor, {
        value: current,
        metadata,
        locale: 'en',
        onChange: (next) => {
          if (next) value = next;
          setCurrent(next);
        },
      });
    }
    await render(createElement(Harness));
    const unit = host.querySelector<HTMLSelectElement>(
      `[data-condition-field-pointer="${CONDITION_POINTER}/statement/range/unit"] select`,
    )!;
    const lower = host.querySelector<HTMLInputElement>(
      `[data-condition-field-pointer="${CONDITION_POINTER}/statement/range/gte"] input`,
    )!;
    expect(unit.value).toBe(units.minutes);
    expect(unit.options[unit.selectedIndex]?.textContent).toContain('Not admitted for this property: min');
    expect(lower.value).toBe('170');
    expect(conditionAdmission(metadata)(value, { ...state, condition: value })[0]?.code).toBe('unsupported');
    const coverage = (condition: FilterDocument) =>
      renderToStaticMarkup(
        createElement(SearchCoverage, {
          state: { ...state, condition },
          data: { conditionMetadata: metadata, hitTypes: {}, selectedFacetLabels: {} },
          observation,
          locale: 'en',
          refreshHref: '/en/search',
        }),
      );
    const executedCoverage = coverage(value);
    expect(executedCoverage).toContain('≥ 170');
    expect(executedCoverage).toContain('Not admitted for this property: min');

    await change(unit, units.centimetres);
    expect(unit.value).toBe(units.minutes);
    await click(button(host, m.search_quantity_unit_change_confirm()));
    expect('statement' in value && 'range' in value.statement ? value.statement.range : undefined).toEqual({
      gte: 170,
      unit: units.centimetres,
    });
    const repairedUnit = host.querySelector<HTMLSelectElement>(
      `[data-condition-field-pointer="${CONDITION_POINTER}/statement/range/unit"] select`,
    )!;
    const repairedLower = host.querySelector<HTMLInputElement>(
      `[data-condition-field-pointer="${CONDITION_POINTER}/statement/range/gte"] input`,
    )!;
    expect(repairedUnit.value).toBe(units.centimetres);
    expect(repairedLower.value).toBe('170');
    expect(conditionAdmission(metadata)(value, { ...state, condition: value })).toEqual([]);
    expect(coverage(value)).toContain('cm');
    expect(coverage(value)).toContain('≥ 170');
    expect(executedCoverage).toContain('Not admitted for this property: min');
  });
});
