import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { quotationTypeAdmitted, readQuotationPage } from '../src/features/catalogue/quotation';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

const work = '00000000-0000-4000-8000-00000000b001';
const quote = '00000000-0000-4000-8000-00000000b002';
const speaker = '00000000-0000-4000-8000-00000000b003';
const voice = '00000000-0000-4000-8000-00000000b004';

function item(
  id: string,
  type: string,
  labels: Record<string, string>,
  statements: SubjectRead['subject']['statements'],
  related: SubjectRead['related'] = {},
): SubjectRead {
  return {
    subject: {
      id,
      type,
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels,
      descriptions: {},
      aliases: {},
      statements,
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related,
    summary: null,
  };
}

function admit(release: Release) {
  release.types['schema:Quotation'] = {
    iri: 'http://schema.org/Quotation',
    labels: { en: 'quotation' },
    mappings: [],
    bases: ['schema:CreativeWork', 'schema:Thing'],
    properties: ['schema:text', 'schema:spokenByCharacter', 'schema:isPartOf', 'schema:recordedBy'],
    facets: [],
    coverRatio: '5:7',
    listPresentation: { imageAspect: 'portrait', keyFacts: [] },
  };
  const itemValue = {
    iri: 'http://schema.org/Thing',
    labels: { en: 'item' },
    descriptions: { en: 'item' },
    datatype: 'wikibase-item' as const,
    targets: ['wd:Q95074'],
    mappings: [],
    qualifiers: [],
    multivalued: true,
    value: { type: 'string' as const, pattern: '^[0-9a-f-]+$' },
    relation: { group: 'credit' as const, order: 'name' as const, inverse: 'none' as const },
  };
  release.properties['schema:spokenByCharacter'] = {
    ...itemValue,
    iri: 'http://schema.org/spokenByCharacter',
    labels: { en: 'speaker' },
  };
  release.properties['schema:isPartOf'] = {
    ...itemValue,
    iri: 'http://schema.org/isPartOf',
    labels: { en: 'work' },
    targets: ['schema:Book'],
  };
  release.properties['schema:recordedBy'] = {
    ...itemValue,
    iri: 'http://schema.org/recordedBy',
    labels: { en: 'voice' },
  };
  release.properties['schema:text'] = {
    iri: 'http://schema.org/text',
    labels: { en: 'text' },
    descriptions: { en: 'text' },
    datatype: 'monolingualtext',
    mappings: [],
    qualifiers: [],
    multivalued: false,
    value: { type: 'object' },
  };
  release.types['schema:Book']!.properties.push('schema:hasPart');
  release.properties['schema:hasPart'] = {
    ...itemValue,
    iri: 'http://schema.org/hasPart',
    labels: { en: 'has part' },
    targets: ['schema:Quotation'],
  };
  return release;
}

function client(mode: 'ok' | 'missing' | 'restricted' | 'stale' | 'unavailable') {
  const quotation = item(
    quote,
    'schema:Quotation',
    { en: 'I will return', ja: '必ず戻る' },
    {
      'schema:text': [
        {
          id: '00000000-0000-4000-8000-00000000e011',
          rank: 'normal',
          property: { id: 'schema:text', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text: 'I will return', language: 'en' } },
          qualifiers: [],
          references: [],
        },
      ],
      'schema:spokenByCharacter':
        mode === 'missing'
          ? []
          : [
              {
                id: '00000000-0000-4000-8000-00000000e012',
                rank: 'normal',
                property: { id: 'schema:spokenByCharacter', data_type: 'wikibase-item' },
                value: { type: 'value', content: speaker },
                qualifiers: [],
                references: [],
              },
            ],
      'schema:isPartOf': [
        {
          id: '00000000-0000-4000-8000-00000000e013',
          rank: 'normal',
          property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
          value: { type: 'value', content: work },
          qualifiers: [],
          references: [],
        },
      ],
    },
    {
      [work]: { type: 'schema:Book', labels: { en: 'Work' } },
      ...(mode === 'restricted'
        ? { [speaker]: { type: 'wd:Q95074', labels: {} } }
        : { [speaker]: { type: 'wd:Q95074', labels: { en: 'Hero' } } }),
      [voice]: { type: 'schema:Person', labels: { en: 'Voice' } },
    },
  );
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async () => {
        if (mode === 'unavailable') return { status: 503 };
        if (id === work) return { status: 200, data: item(work, 'schema:Book', { en: 'Work' }, {}) };
        if (id === quote) return { status: 200, data: quotation };
        return { status: 404 };
      },
      relations: {
        get: async ({ query }: { query: { cursor?: string } }) => {
          if (mode === 'stale') return { status: 409 };
          return {
            status: 200,
            data: {
              relations: [
                {
                  statement: {
                    id: quote,
                    property: { id: 'schema:hasPart', data_type: 'wikibase-item' },
                    value: { type: 'value', content: quote },
                    rank: 'normal',
                    qualifiers: [],
                    references: [],
                  },
                  summary: { id: quote, type: 'schema:Quotation', label: { value: 'I will return', language: 'en' } },
                  related: {},
                },
              ],
              next: query.cursor ? null : 'more-quotes',
              freshness: { caught_up: true },
            },
          };
        },
      },
    }),
  } as unknown as KernelClient;
}

test('quotation reading keeps multilingual text, two contexts, missing and restricted speakers, and stale lists', async () => {
  const closed = { types: { 'schema:Book': { properties: [] } }, properties: {} } as unknown as Release;
  expect(quotationTypeAdmitted(closed)).toBe(false);
  const definitions = admit({
    types: {
      'schema:Book': {
        properties: [],
        bases: ['schema:CreativeWork'],
        labels: { en: 'book' },
        iri: '',
        mappings: [],
        facets: [],
        coverRatio: '5:7',
        listPresentation: { imageAspect: 'portrait', keyFacts: [] },
      },
    },
    properties: {},
  } as Release);
  const current = await readQuotationPage(client('ok'), 'Bearer reader', definitions, quote, 'en', {});
  if (!current.ok) throw new Error('expected quotation');
  expect(current.selected?.text).toBe('I will return');
  expect(current.selected?.language).toBe('en');
  expect(current.selected?.contexts.map((context) => [context.kind, context.status])).toEqual([
    ['speaker', 'current'],
    ['work', 'current'],
    ['voice', 'unknown'],
    ['source', 'unknown'],
  ]);
  const missing = await readQuotationPage(client('missing'), 'Bearer reader', definitions, quote, 'en', {});
  expect(missing.ok && missing.selected?.contexts.find((context) => context.kind === 'speaker')?.status).toBe(
    'missing',
  );
  const restricted = await readQuotationPage(client('restricted'), 'Bearer reader', definitions, quote, 'en', {});
  expect(restricted.ok && restricted.selected?.contexts.find((context) => context.kind === 'speaker')?.status).toBe(
    'restricted',
  );
  expect(await readQuotationPage(client('stale'), 'Bearer reader', definitions, work, 'en', { quote })).toEqual({
    ok: false,
    reason: 'stale',
  });
  expect(await readQuotationPage(client('unavailable'), 'Bearer reader', definitions, quote, 'en', {})).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(catalogueEntries.quotations({ id: work, label: 'Work', locale: 'en' }).href).toContain('/quotations');
});

test('quotation page returns from candidate review and names unavailable configuration', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/work/work/quotations' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { QuotationView } = await import('../src/features/pages/quotation-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const clientQuery = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  async function show(node: ReactNode) {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client: clientQuery },
          h(CandidateReaderBoundary, { observed: { state: 'signed-out', csrfToken: null }, address: 'quote' }, node),
        ),
      ),
    );
  }
  try {
    await show(
      h(QuotationView, {
        id: quote,
        locale: 'en',
        returnTo: '/en/subjects/work/work/graph',
        transport: {
          read: async () => ({
            ok: true,
            public: item(quote, 'schema:Book', { en: 'Work' }, {}),
            admitted: false,
            rows: [],
            selected: null,
            next: null,
          }),
        },
        initial: {
          ok: true,
          public: item(quote, 'schema:Book', { en: 'Work' }, {}),
          admitted: false,
          rows: [],
          selected: null,
          next: null,
        },
      }),
    );
    expect(host.textContent).toContain(m.quotation_unsupported());
    expect(
      [...host.querySelectorAll('a')].some((link) => link.getAttribute('href') === '/en/subjects/work/work/graph'),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    clientQuery.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
