import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  GRAPH_LIMIT,
  graphShapeBound,
  jsonBytes,
  mergeGraphPage,
  readSubjectGraphPage,
  replaceExploreSelection,
  type GraphPage,
} from '../src/features/pages/graph-browser';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

const anchor = '00000000-0000-4000-8000-00000000a001';
const neighbour = '00000000-0000-4000-8000-00000000a002';
const cycle = '00000000-0000-4000-8000-00000000a003';
const hidden = '00000000-0000-4000-8000-00000000a004';

function subject(id: string, label: string, type = 'schema:Book'): SubjectRead {
  return {
    subject: {
      id,
      type,
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: label, ja: label },
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  };
}

function release(): Release {
  return {
    types: {
      'schema:Book': {
        iri: 'http://schema.org/Book',
        labels: { en: 'book' },
        mappings: [],
        bases: ['schema:CreativeWork', 'schema:Thing'],
        properties: ['wdt:P737'],
        facets: [],
        coverRatio: '5:7',
        listPresentation: { imageAspect: 'portrait', keyFacts: [] },
      },
    },
    properties: {
      'wdt:P737': {
        iri: 'http://www.wikidata.org/prop/direct/P737',
        labels: { en: 'influenced by' },
        descriptions: { en: 'influence' },
        datatype: 'wikibase-item',
        targets: ['schema:Book'],
        mappings: [],
        qualifiers: [],
        multivalued: true,
        value: { type: 'string', pattern: '^[0-9a-f-]+$' },
        relation: { group: 'derivation', order: 'name', inverse: 'rezics:influenced', inverseLabels: { en: 'influenced' } },
      },
    },
  } as Release;
}

function node(id: string, label: string) {
  return { id, type: 'schema:Book', label, summary: { id, type: 'schema:Book', label: { value: label, language: 'en' } } };
}

function graphClient(mode: 'cycle' | 'truncated' | 'hidden' | 'unavailable' | 'empty', population = 32) {
  const calls: string[] = [];
  const books = Array.from({ length: population }, (_, index) =>
    `00000000-0000-4000-8000-${(0xb000 + index).toString(16).padStart(12, '0')}`,
  );
  const page: GraphPage = {
    nodes: [node(anchor, 'Anchor'), node(neighbour, 'Neighbour'), node(cycle, 'Cycle')],
    edges: [
      { from: anchor, property: 'wdt:P737', to: neighbour, statement: '00000000-0000-4000-8000-00000000e001' },
      { from: neighbour, property: 'wdt:P737', to: cycle, statement: '00000000-0000-4000-8000-00000000e002' },
      { from: cycle, property: 'wdt:P737', to: anchor, statement: '00000000-0000-4000-8000-00000000e003' },
      { from: neighbour, property: 'wdt:P737', to: anchor, statement: '00000000-0000-4000-8000-00000000e004' },
    ],
    truncated:
      mode === 'truncated'
        ? [{ node: neighbour, property: 'wdt:P737', direction: 'out', cursor: 'native-next' }]
        : [],
  };
  if (mode === 'empty') {
    page.nodes = [node(anchor, 'Anchor')];
    page.edges = [];
  }
  const limited = {
    ...page,
    nodes: page.nodes.slice(0, Math.min(page.nodes.length, GRAPH_LIMIT + 1)),
    edges: page.edges.slice(0, GRAPH_LIMIT),
  };
  const client = {
    subjects: ({ id }: { id: string }) => ({
      get: async () => {
        calls.push(`GET /v1/subjects/${id}`);
        if (mode === 'unavailable') return { status: 503 };
        if (id === hidden) return { status: 404 };
        return { status: 200, data: subject(id, id === anchor ? 'Anchor' : 'Neighbour') };
      },
      counts: {
        get: async () => {
          calls.push(`GET /v1/subjects/${id}/counts`);
          return { status: 200, data: { properties: { 'wdt:P737': { out: 3, in: 2 } } } };
        },
      },
      graph: {
        get: async () => {
          calls.push(`GET /v1/subjects/${id}/graph`);
          void books;
          return { status: 200, data: limited };
        },
      },
      relations: {
        get: async ({ query }: { query: { cursor?: string } }) => {
          calls.push(`GET /v1/subjects/${id}/relations`);
          return {
            status: 200,
            data: {
              relations: [
                {
                  statement: { id: '00000000-0000-4000-8000-00000000e005', property: { id: 'wdt:P737', data_type: 'wikibase-item' }, value: { type: 'value', content: cycle }, rank: 'normal', qualifiers: [], references: [] },
                  summary: { id: cycle, type: 'schema:Book', label: { value: 'Cycle', language: 'en' } },
                  related: {},
                },
              ],
              next: query.cursor ? null : 'native-next',
              freshness: { caught_up: true },
            },
          };
        },
      },
      links: { get: async () => ({ status: 200, data: { links: [], next: null, freshness: { caught_up: true } } }) },
    }),
  } as unknown as KernelClient;
  return { client, calls, limited };
}

test('graph explorer keeps cycles and both directions, continues a truncated branch, and hides unavailable endpoints', async () => {
  const current = graphClient('cycle');
  const read = await readSubjectGraphPage(current.client, 'Bearer reader', release(), anchor, 'en', {
    property: 'wdt:P737',
    direction: 'both',
    depth: 1,
  });
  if (!read.ok) throw new Error('expected graph');
  expect(read.graph.edges.some((edge) => edge.from === cycle && edge.to === anchor)).toBe(true);
  expect(read.graph.edges.some((edge) => edge.from === neighbour && edge.to === anchor)).toBe(true);
  expect(new Set(read.graph.edges.map((edge) => JSON.stringify(edge))).size).toBe(read.graph.edges.length);
  const truncated = graphClient('truncated');
  const first = await readSubjectGraphPage(truncated.client, 'Bearer reader', release(), anchor, 'en', {
    property: 'wdt:P737',
    expansion: { node: neighbour, property: 'wdt:P737', direction: 'out', cursor: 'native-next' },
  });
  if (!first.ok) throw new Error('expected continuation');
  expect(first.graph.nodes.some((node) => node.id === cycle)).toBe(true);
  const hiddenRead = await readSubjectGraphPage(graphClient('hidden').client, 'Bearer reader', release(), hidden, 'en', {
    property: 'wdt:P737',
  });
  expect(hiddenRead).toEqual({ ok: false, reason: 'unavailable' });
  const merged = mergeGraphPage(first.graph, { nodes: [], edges: [], truncated: [] }, neighbour);
  expect(merged.truncated.some((entry) => entry.node === neighbour)).toBe(false);
  expect(catalogueEntries.graph({ id: anchor, label: 'Anchor', locale: 'en' }).href).toContain('/graph');
});

test('graph work stays response-bounded as the catalogue grows and selection replaces old detail', async () => {
  for (const scale of [32, 256, 2048]) {
    for (const depth of [1, 2] as const) {
      const fixture = graphClient('cycle', scale);
      const read = await readSubjectGraphPage(fixture.client, 'Bearer reader', release(), anchor, 'en', {
        property: 'wdt:P737',
        direction: 'both',
        depth,
        selection: { kind: 'node', id: neighbour },
      });
      if (!read.ok) throw new Error('expected bounded graph');
      expect(read.cost.nativeCalls).toBe(4);
      expect(read.cost.valuesProcessed).toBeLessThanOrEqual(graphShapeBound(depth) + 2);
      expect(read.cost.bytesRetained).toBe(jsonBytes({ graph: read.graph, detail: read.detail, query: read.query }));
      expect(read.graph.nodes.length).toBeLessThanOrEqual(GRAPH_LIMIT + 1);
      const replaced = replaceExploreSelection(read, { kind: 'node', id: cycle });
      expect(replaced.detail).toBeNull();
      expect(replaced.cost.bytesRetained).toBeLessThanOrEqual(read.cost.bytesRetained);
    }
  }
  const sparse = await readSubjectGraphPage(graphClient('empty').client, 'Bearer reader', release(), anchor, 'en', {
    property: 'wdt:P737',
  });
  expect(sparse.ok && sparse.graph.edges.length).toBe(0);
});

test('graph page offers a table and diagram and recovers keyboard selection without leaking a failed graph', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/book/anchor/graph' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'Document', 'IS_REACT_ACT_ENVIRONMENT'];
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
  const { GraphBrowserPage } = await import('../src/features/pages/graph-browser/view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fixture = graphClient('truncated');
  const initial = await readSubjectGraphPage(fixture.client, 'Bearer reader', release(), anchor, 'en', {
    property: 'wdt:P737',
    direction: 'both',
    depth: 1,
  });
  async function show(node: ReactNode) {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(CandidateReaderBoundary, { observed: { state: 'signed-out', csrfToken: null }, address: 'graph' }, node),
        ),
      ),
    );
  }
  try {
    await show(h(GraphBrowserPage, { id: anchor, locale: 'en', transport: { read: async () => initial }, initial }));
    expect(host.textContent).toContain(m.graph_explore_title());
    expect(host.querySelector('table')).toBeTruthy();
    expect(host.querySelector('svg')).toBeTruthy();
    const buttons = [...host.querySelectorAll('button')];
    const neighbourButton = buttons.find((button) => button.textContent === 'Neighbour');
    await act(async () => neighbourButton?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(host.textContent).toContain('Neighbour');
    await show(
      h(GraphBrowserPage, {
        key: 'failed',
        id: hidden,
        locale: 'en',
        transport: { read: async () => ({ ok: false, reason: 'unavailable' }) },
        initial: { ok: false, reason: 'unavailable' },
      }),
    );
    expect(host.textContent).toContain(m.graph_explore_unavailable());
    expect(host.textContent).not.toContain('Neighbour');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
