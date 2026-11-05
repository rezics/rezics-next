import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { quotationTypeAdmitted, readQuotationPage } from '../src/features/catalogue/quotation';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { candidateContext } from '../src/subject/candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));

const work = '00000000-0000-4000-8000-00000000b001';
const quote = '00000000-0000-4000-8000-00000000b002';
const speaker = '00000000-0000-4000-8000-00000000b003';
const voice = '00000000-0000-4000-8000-00000000b004';
const credited = '00000000-0000-4000-8000-00000000b005';
const textStatement = '00000000-0000-4000-8000-00000000e011';
const sourceHash = 'sha256:quotation-source-reference-1';
const sourceUrl = 'https://archive.example.test/record/quotation-42';

function item(
  id: string,
  type: string,
  labels: Record<string, string>,
  statements: SubjectRead['subject']['statements'],
  related: SubjectRead['related'] = {},
  context = candidateContext,
): SubjectRead {
  return {
    subject: {
      id,
      type,
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context,
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
    properties: ['schema:text', 'schema:spokenByCharacter', 'schema:creator', 'schema:isPartOf', 'schema:recordedBy'],
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
  release.properties['schema:creator'] = {
    ...itemValue,
    iri: 'http://schema.org/creator',
    labels: { en: 'credited person' },
  };
  release.properties['schema:text'] = {
    iri: 'http://schema.org/text',
    labels: { en: 'text' },
    descriptions: { en: 'text' },
    datatype: 'monolingualtext',
    mappings: [],
    qualifiers: ['schema:creator'],
    multivalued: false,
    value: { type: 'object' },
  };
  release.properties['schema:url'] = {
    iri: 'http://schema.org/url',
    labels: { en: 'source URL' },
    descriptions: { en: 'source destination' },
    datatype: 'url',
    mappings: [],
    qualifiers: [],
    multivalued: true,
    value: { type: 'string' },
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

function client(
  mode: 'ok' | 'missing' | 'restricted' | 'stale' | 'unavailable' | 'withheld-source' | 'unsafe-source' | 'wrong-type',
  observe?: (kind: string, input: unknown) => void,
  wrongContext?: { id: string; value: string },
) {
  const quotation = item(
    quote,
    'schema:Quotation',
    { en: 'I will return', ja: '必ず戻る' },
    {
      'schema:text': [
        {
          id: textStatement,
          rank: 'normal',
          property: { id: 'schema:text', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text: 'I will return', language: 'en' } },
          qualifiers: [
            {
              property: { id: 'schema:creator', data_type: 'wikibase-item' },
              value: { type: 'value', content: credited },
            },
          ],
          references: [
            {
              hash: sourceHash,
              parts: [
                {
                  property: { id: 'schema:url', data_type: 'url' },
                  value:
                    mode === 'withheld-source'
                      ? { type: 'somevalue' }
                      : {
                          type: 'value',
                          content: mode === 'unsafe-source' ? 'javascript:alert(1)' : sourceUrl,
                        },
                },
              ],
            },
          ],
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
      'schema:creator': [
        {
          id: '00000000-0000-4000-8000-00000000e014',
          rank: 'normal',
          property: { id: 'schema:creator', data_type: 'wikibase-item' },
          value: { type: 'value', content: credited },
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
      [credited]: { type: 'schema:Person', labels: { en: 'Credited author' } },
    },
  );
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async ({ query }: { query?: { context?: string; includeViewerActions?: boolean } } = {}) => {
        observe?.('subject', { id, query });
        if (mode === 'unavailable') return { status: 503 };
        const context = (wrongContext?.id === id ? wrongContext.value : query?.context) ?? candidateContext;
        const withAdvice = <T extends SubjectRead>(data: T) => ({
          ...data,
          ...(query?.includeViewerActions
            ? {
                viewerActions: {
                  state: 'available' as const,
                  actions: [{ action: 'statement:propose', operations: ['subject.propose'] }],
                },
              }
            : {}),
        });
        if (id === work)
          return { status: 200, data: withAdvice(item(work, 'schema:Book', { en: 'Work' }, {}, {}, context)) };
        if (id === quote)
          return { status: 200, data: withAdvice({ ...quotation, subject: { ...quotation.subject, context } }) };
        return { status: 404 };
      },
      relations: {
        get: async ({ query }: { query: { cursor?: string; context?: string } }) => {
          observe?.('relations', { id, query });
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
                  summary: {
                    id: quote,
                    type: mode === 'wrong-type' ? 'schema:Book' : 'schema:Quotation',
                    label: { value: 'I will return', language: 'en' },
                  },
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
    viewerActions: {
      post: async ({ resources }: { resources: { type: string; id: string }[] }) => {
        observe?.('viewerActions', resources);
        return {
          status: 200,
          data: {
            resources: resources.map((resource) => ({
              ...resource,
              viewerActions: [{ action: 'statement:propose', operations: ['subject.propose'] }],
            })),
          },
        };
      },
    },
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
  expect(current.selected?.statements[0]?.text).toBe('I will return');
  expect(current.selected?.statements[0]?.language).toBe('en');
  expect(current.selected?.contexts.map((context) => [context.kind, context.status])).toEqual([
    ['speaker', 'current'],
    ['credited', 'current'],
    ['work', 'current'],
    ['voice', 'unknown'],
  ]);
  expect(current.selected?.contexts.find((context) => context.kind === 'speaker')?.id).toBe(speaker);
  expect(current.selected?.contexts.find((context) => context.kind === 'credited')?.id).toBe(credited);
  expect(current.selected?.statements[0]?.statementId).toBe(textStatement);
  expect(current.selected?.statements[0]?.qualifiers[0]?.id).toBe(credited);
  expect(current.selected?.statements[0]?.references).toEqual([
    {
      statementId: textStatement,
      hash: sourceHash,
      status: 'current',
      parts: [
        {
          property: 'schema:url',
          label: 'source URL',
          status: 'current',
          value: sourceUrl,
          href: sourceUrl,
        },
      ],
    },
  ]);
  expect(current.selected?.statements[0]?.sourceStatus).toBe('current');
  const missing = await readQuotationPage(client('missing'), 'Bearer reader', definitions, quote, 'en', {});
  expect(missing.ok && missing.selected?.contexts.find((context) => context.kind === 'speaker')?.status).toBe(
    'missing',
  );
  const restricted = await readQuotationPage(client('restricted'), 'Bearer reader', definitions, quote, 'en', {});
  expect(restricted.ok && restricted.selected?.contexts.find((context) => context.kind === 'speaker')?.status).toBe(
    'restricted',
  );
  const withheld = await readQuotationPage(client('withheld-source'), 'Bearer reader', definitions, work, 'en', {});
  expect(withheld.ok && withheld.selected?.statements[0]?.sourceStatus).toBe('withheld');
  expect(withheld.ok && withheld.selected?.statements[0]?.references[0]?.parts[0]?.status).toBe('withheld');
  const unsafe = await readQuotationPage(client('unsafe-source'), 'Bearer reader', definitions, work, 'en', {});
  expect(unsafe.ok && unsafe.selected?.statements[0]?.sourceStatus).toBe('unsupported');
  expect(unsafe.ok && unsafe.selected?.statements[0]?.references[0]?.parts[0]?.href).toBeUndefined();
  const unrelated = await readQuotationPage(client('wrong-type'), 'Bearer reader', definitions, work, 'en', {});
  expect(unrelated.ok && unrelated.rows).toEqual([]);
  expect(unrelated.ok && unrelated.unsupportedCount).toBe(1);
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

test('quotation reads bind the relation page, selected Subject and viewer permission to Context', async () => {
  const definitions = admit({ types: {}, properties: {} } as unknown as Release);
  const context = '00000000-0000-4000-8000-00000000c001';
  const calls: { kind: string; input: unknown }[] = [];
  const result = await readQuotationPage(
    client('ok', (kind, input) => calls.push({ kind, input })),
    'Bearer reader',
    definitions,
    work,
    'en',
    { context },
  );
  if (!result.ok) throw new Error('expected a current quotation');
  expect(calls.filter((call) => call.kind === 'subject').map((call) => call.input)).toEqual([
    { id: work, query: { context } },
    { id: quote, query: { context } },
  ]);
  expect(calls.find((call) => call.kind === 'relations')?.input).toEqual({
    id: work,
    query: { property: 'schema:hasPart', language: 'en', limit: 20, context },
  });
  expect(calls.find((call) => call.kind === 'viewerActions')?.input).toEqual([
    { type: 'semantic.subject', id: quote },
    { type: 'semantic.context', id: context },
  ]);
  expect(result.selected?.observation).toContain(`\u0000${context}\u0000`);
  expect(result.actions?.[0]?.state).toBe('unsupported');
  expect(
    await readQuotationPage(
      client('ok', undefined, { id: work, value: candidateContext }),
      'Bearer reader',
      definitions,
      work,
      'en',
      { context },
    ),
  ).toEqual({ ok: false, reason: 'stale' });
  expect(
    await readQuotationPage(
      client('ok', undefined, { id: quote, value: candidateContext }),
      'Bearer reader',
      definitions,
      work,
      'en',
      { context },
    ),
  ).toEqual({ ok: false, reason: 'stale' });
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
            observation: 'subject-observation',
            unsupportedCount: 0,
          }),
        },
        initial: {
          ok: true,
          public: item(quote, 'schema:Book', { en: 'Work' }, {}),
          admitted: false,
          rows: [],
          selected: null,
          next: null,
          observation: 'subject-observation',
          unsupportedCount: 0,
        },
      }),
    );
    expect(host.textContent).toContain(m.quotation_unsupported());
    expect(host.textContent).toContain(m.quotation_facts());
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
