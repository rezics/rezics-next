import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement, useState, type FormEvent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFilter, type FilterDocument, type FilterStatement } from '@rezics/filter';
import type { ConditionMetadata } from '../src/search/condition-editor-model';
import {
  conditionConceptProperty,
  conditionConceptSelection,
  conditionConceptSuggestionFilter,
  conditionConceptReferenceFor,
  conditionConceptReferenceForRequest,
  parseConditionConceptReference,
} from '../src/search/condition-concept-model';
import { readConditionConceptReference, searchConditionConcepts } from '../src/search/condition-concept';
import { changeStatementProperty } from '../src/search/condition-property-edit';
import { ConditionConceptPicker } from '../src/search/condition-concept-picker';
import { useConditionComposition } from '../src/search/condition-composition';
import { PredicateDescription } from '../src/search/search-context/predicate';

const metadata: ConditionMetadata = {
  types: {
    'skos:Concept': {},
    'app:Genre': { bases: ['skos:Concept'] },
    'app:Work': {},
  },
  properties: {
    'schema:genre': {
      datatype: 'wikibase-item',
      relation: { group: 'classification' },
      targets: ['skos:Concept'],
      qualifiers: ['rezics:spoilerLevel'],
    },
    'schema:keywords': {
      datatype: 'wikibase-item',
      relation: { group: 'classification' },
      targets: ['skos:Concept'],
      qualifiers: ['rezics:spoilerLevel'],
    },
    'schema:name': { datatype: 'string' },
    'rezics:spoilerLevel': { datatype: 'quantity' },
  },
};

const lookup = {
  enabled: false,
  blocked: 'scope' as const,
  releaseDigest: 'release-current',
  key: 'current-reader-locale-request',
};
type ConceptDocument = { statement: Extract<FilterStatement, { in: readonly string[] }> };
const conceptId = '00000000-0000-4000-8000-000000000001';
const schemeId = '00000000-0000-4000-8000-000000000002';
const retryLookup = {
  enabled: true,
  filter: JSON.stringify({ type: { in: ['app:Genre'] } }),
  releaseDigest: 'release-current',
  key: 'reader-locale-release-request',
  lifetimeKey: 'reader-locale-release',
};
const initialCondition: FilterDocument = {
  statement: {
    property: 'schema:genre',
    in: [],
    qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
  },
};

function suggestionPage(): Response {
  return Response.json({
    subjects: [{ id: conceptId, type: 'app:Genre', labels: { en: 'Drama' }, summary: null }],
    as_of: '2026-11-05T00:00:00.000Z',
    types: { 'app:Genre': { en: 'Genre' } },
  });
}

async function withFetch(fetcher: typeof fetch, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetcher });
  try {
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'fetch', previous);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
}

async function mountedConceptForm(
  fetcher: typeof fetch,
  run: (host: HTMLElement, render: (element: ReactNode) => Promise<void>) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://search.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: import('react-dom/client').Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('main');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    await withFetch(fetcher, () =>
      run(host as unknown as HTMLElement, async (element) => act(async () => root!.render(element))),
    );
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}

function ConceptForm({ onApplied, onSubmit }: { onApplied(next: FilterDocument): void; onSubmit(): void }) {
  const [value, setValue] = useState(initialCondition);
  const composition = useConditionComposition('concept-condition-form');
  return createElement(
    'form',
    {
      ...composition.handlers,
      method: 'get',
      onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        onSubmit();
      },
    },
    createElement(ConditionConceptPicker, {
      value,
      lookup: retryLookup,
      locale: 'en',
      disabled: false,
      preventImplicitSubmit: composition.preventImplicitSubmit,
      onChange(next) {
        onApplied(next);
        setValue(next);
      },
    }),
  );
}

function controlButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

async function changeInput(host: HTMLElement, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing Concept search input');
    const view = host.ownerDocument.defaultView!;
    Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
  });
}

async function changeSelect(host: HTMLElement, select: HTMLSelectElement, value: string) {
  await act(async () => {
    const view = host.ownerDocument.defaultView!;
    Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new view.Event('change', { bubbles: true }));
  });
}

async function clickButton(host: HTMLElement, label: string) {
  await act(async () => {
    const button = controlButton(host, label);
    button.focus();
    button.click();
  });
}

async function settle(host: HTMLElement) {
  await act(async () => {
    await new Promise<void>((resolve) => host.ownerDocument.defaultView!.setTimeout(resolve, 0));
  });
}

describe('Search Concept conditions', () => {
  it('admits only released Concept classification properties and derives suggestion types from inheritance', () => {
    expect(conditionConceptProperty(metadata.properties['schema:genre'])).toBe(true);
    expect(conditionConceptProperty(metadata.properties['schema:name'])).toBe(false);
    expect(conditionConceptSuggestionFilter(metadata)).toBe(
      JSON.stringify({ type: { in: ['skos:Concept', 'app:Genre'] } }),
    );
  });

  it('writes exact and descendant meaning explicitly while retaining same-statement qualifiers', () => {
    const original: FilterDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-old'],
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    };
    const exact = conditionConceptSelection(original, conceptId, schemeId, false);
    const descendants = conditionConceptSelection(original, conceptId, schemeId, true);
    expect(exact).toEqual({
      statement: {
        property: 'schema:genre',
        in: [conceptId],
        concept: { scheme: schemeId, includeChildren: false },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    });
    expect(descendants).toEqual({
      statement: {
        property: 'schema:genre',
        in: [conceptId],
        concept: { scheme: schemeId, includeChildren: true },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    });
    expect(parseFilter(JSON.parse(JSON.stringify(descendants)))).toEqual(descendants);
  });

  it('keeps native meaning when moving between admitted tag properties and requires confirmation to leave them', () => {
    const existing: FilterDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-a'],
        concept: { scheme: 'scheme-a', includeChildren: true },
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['2'] }],
      },
    };
    const retained = changeStatementProperty(existing, 'schema:keywords', metadata);
    expect(retained.requiresConfirmation).toBe(false);
    expect(retained.next).toEqual({
      statement: { ...existing.statement, property: 'schema:keywords' },
    });
    expect(changeStatementProperty(existing, 'schema:name', metadata).requiresConfirmation).toBe(true);
  });

  it('shows a retained shared filter with its scheme and exact or descendant meaning while lookups are closed', () => {
    const exact: ConceptDocument = {
      statement: { property: 'schema:genre', in: ['concept-a'], concept: { scheme: 'scheme-a' } },
    };
    const descendants: ConceptDocument = {
      statement: {
        property: 'schema:genre',
        in: ['concept-a'],
        concept: { scheme: 'scheme-a', includeChildren: true },
      },
    };
    const render = (value: ConceptDocument) =>
      renderToStaticMarkup(
        <ConditionConceptPicker value={value} lookup={lookup} locale="en" disabled onChange={() => {}} />,
      );
    expect(render(exact)).toContain('Scheme scheme-a · Exact Concept');
    expect(render(descendants)).toContain('Scheme scheme-a · This Concept and its admitted descendants');
  });

  it('does not reuse a label or identity after a reader or current Concept replacement', () => {
    const stale = { status: 'ready' as const, id: 'concept-old', label: 'Old label', schemes: [{ id: 'scheme-a' }] };
    expect(conditionConceptReferenceFor('concept-new', stale)).toBeUndefined();
    expect(
      conditionConceptReferenceForRequest('reader-new:concept-old', 'concept-old', {
        owner: 'reader-old:concept-old',
        value: stale,
      }),
    ).toBeUndefined();
    expect(parseConditionConceptReference(stale, 'concept-new')).toEqual({
      status: 'unavailable',
      id: 'concept-new',
    });
  });

  it('keeps HTTP and body preparation, refusal, unsupported and restart outcomes distinct', async () => {
    const responses = [
      Response.json({ code: 'index_not_ready' }, { status: 202, headers: { 'retry-after': '3' } }),
      Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '1' } }),
      Response.json({ status: 'preparing', id: conceptId, retryAfter: '2' }),
      Response.json(null, { status: 202, headers: { 'retry-after': '4' } }),
      Response.json({ code: 'forbidden' }, { status: 401 }),
      Response.json({ code: 'unsupported_query' }, { status: 422 }),
      Response.json({ code: 'search_restart_required' }, { status: 409 }),
      Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '5' } }),
    ];
    await withFetch(
      async () => {
        const response = responses.shift();
        if (!response) throw new Error('No test response remains');
        return response;
      },
      async () => {
        const signal = new AbortController().signal;
        expect(await searchConditionConcepts('drama', 'en', signal, retryLookup)).toMatchObject({
          status: 'preparing',
          retryAfter: '3',
        });
        expect(await searchConditionConcepts('drama', 'en', signal, retryLookup)).toMatchObject({
          status: 'preparing',
          retryAfter: '1',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'preparing',
          retryAfter: '2',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'preparing',
          retryAfter: '4',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'refused',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'unsupported',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'restart',
        });
        expect(await readConditionConceptReference(conceptId, 'en', retryLookup, signal)).toMatchObject({
          status: 'preparing',
          retryAfter: '5',
        });
      },
    );
    expect(responses).toHaveLength(0);
  });

  it('recovers the mounted query and exact Concept reads without changing the query or selected identity', async () => {
    let queryReads = 0;
    let referenceReads = 0;
    let applied: FilterDocument | undefined;
    let submissions = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input), 'https://search.test');
      if (url.searchParams.has('q')) {
        queryReads += 1;
        return queryReads === 1
          ? Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '1' } })
          : suggestionPage();
      }
      referenceReads += 1;
      return referenceReads === 1
        ? Response.json({ status: 'unavailable', id: conceptId })
        : Response.json({ status: 'ready', id: conceptId, label: 'Drama', schemes: [{ id: schemeId, label: 'Film' }] });
    };

    await mountedConceptForm(fetcher, async (host, render) => {
      await render(
        createElement(ConceptForm, {
          onApplied(next) {
            applied = next;
          },
          onSubmit() {
            submissions += 1;
          },
        }),
      );
      await clickButton(host, 'Add Concept');
      const input = host.querySelector<HTMLInputElement>('input')!;
      expect(input.id).toBeTruthy();
      expect(host.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
      expect(host.ownerDocument.activeElement === input).toBe(true);
      await changeInput(host, 'drama');
      await settle(host);
      expect(queryReads).toBe(1);
      expect(host.textContent).toContain('Concept suggestions are preparing; your query stays unchanged.');
      await clickButton(host, 'Retry Concept search');
      await settle(host);
      expect(queryReads).toBe(2);
      expect(input.value).toBe('drama');
      expect(host.querySelector('ul')?.id).toBeTruthy();
      expect(host.ownerDocument.activeElement === host.querySelector('ul')).toBe(true);

      const composingEnter = new host.ownerDocument.defaultView!.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      input.dispatchEvent(composingEnter);
      expect(composingEnter.defaultPrevented).toBe(true);
      input.dispatchEvent(new host.ownerDocument.defaultView!.KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      expect(submissions).toBe(0);

      await clickButton(host, 'Drama');
      await settle(host);
      expect(referenceReads).toBe(1);
      expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain(conceptId);
      const [scheme, match] = Array.from(host.querySelectorAll('select'));
      expect(scheme!.disabled).toBe(true);
      expect(match!.disabled).toBe(false);
      await changeSelect(host, match!, 'descendants');
      const apply = controlButton(host, 'Apply Concept filter');
      expect(apply.disabled).toBe(true);
      await clickButton(host, 'Retry Concept read');
      await settle(host);
      expect(referenceReads).toBe(2);
      expect(input.value).toBe('drama');
      expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain(conceptId);
      expect(host.ownerDocument.activeElement === scheme).toBe(true);
      expect(apply.disabled).toBe(true);
      expect(host.querySelector(`label[for="${scheme!.id}"]`)).toBeTruthy();
      expect(host.querySelector(`label[for="${match!.id}"]`)).toBeTruthy();
      await changeSelect(host, scheme!, schemeId);
      expect(apply.disabled).toBe(false);
      expect(apply.type).toBe('button');
      await clickButton(host, 'Apply Concept filter');
      expect(applied).toEqual({
        statement: {
          property: 'schema:genre',
          in: [conceptId],
          concept: { scheme: schemeId, includeChildren: true },
          qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
        },
      });
      expect(parseFilter(applied!)).toEqual(applied);
      expect(submissions).toBe(0);
      expect(host.ownerDocument.activeElement === controlButton(host, 'Change Concept tag')).toBe(true);
    });
  });

  it('retires an older same-target completion after a deliberate retry and keeps focus on the current visit', async () => {
    const pending: ((response: Response) => void)[] = [];
    let applied: FilterDocument | undefined;
    const fetcher: typeof fetch = (input) => {
      const url = new URL(String(input), 'https://search.test');
      if (url.searchParams.has('q')) return Promise.resolve(suggestionPage());
      return new Promise<Response>((resolve) => pending.push(resolve));
    };

    await mountedConceptForm(fetcher, async (host, render) => {
      await render(
        createElement(ConceptForm, {
          onApplied(next) {
            applied = next;
          },
          onSubmit() {},
        }),
      );
      await clickButton(host, 'Add Concept');
      await changeInput(host, 'drama');
      await settle(host);
      await clickButton(host, 'Drama');
      await settle(host);
      expect(pending).toHaveLength(1);
      await act(async () => pending[0]!(Response.json({ status: 'unavailable', id: conceptId })));
      await settle(host);
      const candidate = controlButton(host, 'Drama');
      const [, match] = Array.from(host.querySelectorAll('select'));
      await changeSelect(host, match!, 'descendants');
      await clickButton(host, 'Retry Concept read');
      await settle(host);
      expect(pending).toHaveLength(2);
      expect(controlButton(host, 'Retry Concept read').getAttribute('aria-disabled')).toBe('true');
      expect(controlButton(host, 'Apply Concept filter').disabled).toBe(true);
      await act(async () => {
        candidate.focus();
        candidate.click();
      });
      await settle(host);
      expect(pending).toHaveLength(3);
      expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain(conceptId);
      expect(match!.value).toBe('descendants');

      await act(async () =>
        pending[2]!(
          Response.json({ status: 'ready', id: conceptId, label: 'Drama', schemes: [{ id: schemeId, label: 'Film' }] }),
        ),
      );
      await settle(host);
      const [scheme] = Array.from(host.querySelectorAll('select'));
      expect(host.ownerDocument.activeElement === scheme).toBe(true);
      await changeSelect(host, scheme!, schemeId);
      expect(controlButton(host, 'Apply Concept filter').disabled).toBe(false);

      await act(async () => pending[1]!(Response.json({ status: 'unavailable', id: conceptId })));
      await settle(host);
      expect(host.textContent).not.toContain('Concept labels are unavailable');
      expect(controlButton(host, 'Apply Concept filter').disabled).toBe(false);
      expect(host.ownerDocument.activeElement === scheme).toBe(true);
      await clickButton(host, 'Apply Concept filter');
      expect(applied).toMatchObject({
        statement: { in: [conceptId], concept: { scheme: schemeId, includeChildren: true } },
      });
    });
  });

  it('explains exact and descendant execution in the result predicate', () => {
    const describe = (includeChildren: boolean) => {
      const label = (id: string) =>
        ({ 'schema:genre': 'Genre', 'concept-a': 'Drama', 'scheme-a': 'Film genres' })[id] ?? id;
      return renderToStaticMarkup(
        <PredicateDescription
          value={{
            statement: {
              property: 'schema:genre',
              in: ['concept-a'],
              concept: { scheme: 'scheme-a', includeChildren },
            },
          }}
          locale="en"
          presentation={{
            property: label,
            catalogueType: label,
            discoveryType: label,
            value: (_property, value) => label(value),
            conceptScheme: label,
          }}
        />,
      ).replace(/<[^>]*>/g, '');
    };
    expect(describe(false)).toContain('Scheme Film genres: Exact Concept');
    expect(describe(true)).toContain('Scheme Film genres: This Concept and its admitted descendants');
  });
});
