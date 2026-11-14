import { expect, mock, test } from 'bun:test';
import { act, useState, type ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import native from '@rezics/composition/profiles/platform.json';
import type { SubjectRead } from '@rezics/client';
import type { SubjectPageData } from '../src/features/pages/subject';
import { defaultReader } from '../src/subject/reader';
import { workFranchiseReturnHref } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');
const { WorkFranchiseReading } = await import('../src/features/pages/showcase-work');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const property = 'wdt:P144';
const selection = { node: 'franchise', property, direction: 'forward' as const, cursor: 'native+current' };
const definitions = { [property]: { label: 'Related', forwardLabel: 'Related', group: 'credit', symmetric: false } };
const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};

function fixture(finite: boolean): SubjectPageData {
  const statements = [0, 1, 2].map((level) => ({
    id: id(100 + level),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: id(200 + level) },
    qualifiers: level
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: `+${level}`, unit: '1' } },
          },
        ]
      : [],
    references: [],
    rezics: { release: 'sha256:showcase', revision: 1 },
  })) as SubjectRead['subject']['statements'][string];
  const source: SubjectRead = {
    subject: {
      id: id(1),
      type: 'schema:TVSeries',
      revision: 1,
      release: 'sha256:showcase',
      context: '00000000-0000-8000-8000-000000000000',
      labels: { en: 'Work' },
      descriptions: {},
      aliases: {},
      resolution: {},
      relationCounts: { [property]: 3 },
      sourceRecords: [],
      statements: { [property]: statements },
    },
    account: null,
    summary: null,
    related: Object.fromEntries(
      [0, 1, 2].map((level) => [
        id(200 + level),
        { type: 'schema:TVSeries', types: ['schema:TVSeries'], labels: { en: `Related ${level}` }, cover: null },
      ]),
    ),
  };
  const base = (
    native.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
      views: { overview: CompositionDocument };
    }
  ).views.overview;
  const document = {
    ...base,
    content: [
      base.content[0]!,
      { type: 'OutgoingRelations', props: { id: selection.node, property, limit: 8, paged: true } },
    ],
  } as CompositionDocument;
  const continuation = finite ? { node: selection.node, cursor: selection.cursor } : undefined;
  const plan = planReads(platformRegistry, document, { subject: id(1), ...(continuation ? { continuation } : {}) });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') reads[key] = { status: 200, body: source };
    if (read.kind === 'relations')
      reads[key] = {
        status: 200,
        body: {
          relations: statements!.map((statement, level) => ({
            target: id(200 + level),
            statement,
            summary: {
              id: id(200 + level),
              type: 'schema:TVSeries',
              label: { value: `Related ${level}`, language: 'en' },
            },
            related: {},
          })),
          next: 'native-next',
        },
      };
  }
  return {
    subject: id(1),
    profile: source.subject.release,
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document,
    views: ['overview', 'relations'],
    reads,
    requestedRealm: id(20),
    ...(continuation ? { continuation } : {}),
  };
}

test.each([
  [false, 'browse'],
  [false, 'evidence'],
  [true, 'browse'],
  [true, 'evidence'],
] as const)('Work finite=%s retains prepared %s return and retires later replacements', async (finite, focus) => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/' });
  const requests = mock(async () => new Response(null, { status: 503 }));
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    fetch: requests,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const page = fixture(finite);
  const origin = `/en/subjects/${id(1)}/work${finite ? `/relations?realm=${id(20)}&node=franchise&streamProperty=wdt%3AP144&streamDirection=forward&cursor=native%2Bcurrent` : `?realm=${id(20)}`}`;
  const returnHref = (level = 1) =>
    workFranchiseReturnHref(origin, origin, 'en', {
      stream: `out:${property}`,
      node: selection.node,
      holder: id(1),
      statement: id(100 + level),
      focus,
      spoiler: 1,
      release: 'sha256:showcase',
      revision: 1,
    });
  const initial: ComponentProps<typeof SubjectPage> = {
    page,
    currentHref: returnHref(),
    locale: 'en',
    view: finite ? 'relations' : 'overview',
    messages,
    relations: definitions,
    renderJsonLd: false,
    ...(finite
      ? {
          selectedNode: selection.node,
          selectedStreamProperty: property,
          selectedStreamDirection: selection.direction,
          selectedCursor: selection.cursor,
          finiteWorkRegionReader: WorkFranchiseReading,
        }
      : {}),
  };
  let update!: (patch: Partial<typeof initial>) => void;
  const route = createRootRoute({
    component: () => {
      const [props, setProps] = useState(initial);
      update = (patch) => setProps((old) => ({ ...old, ...patch }));
      return <SubjectPage {...props} />;
    },
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: [origin] }) });
  const draw = (patch: Partial<typeof initial>) => act(async () => update(patch));
  const region = () => host.querySelector<HTMLElement>('[data-slot="work-franchise"]')!;
  const browse = (level: number) =>
    region().querySelector<HTMLAnchorElement>(`a[href*="/subjects/${id(200 + level)}/"]`);
  const evidence = (level: number) => {
    for (let node = browse(level)?.parentElement; node && node !== region(); node = node.parentElement) {
      const summary = node.querySelector<HTMLElement>('summary');
      if (summary) return summary;
    }
    throw new Error(`Missing evidence for Related ${level}`);
  };
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    const stream = region().querySelector('[data-work-node="franchise"]');
    const retainedEvidence = evidence(0);
    const retainedDetails = retainedEvidence.closest('details')!;
    retainedDetails.open = true;
    expect(browse(1)).toBeNull();
    expect(browse(2)).toBeNull();
    expect(window.document.activeElement === region().querySelector('h2')).toBe(false);
    await draw({ reader: defaultReader });
    expect(region().querySelector('[data-work-node="franchise"]')).toBe(stream);
    expect(evidence(0)).toBe(retainedEvidence);
    expect(retainedDetails.open).toBe(true);
    if (focus === 'evidence') retainedDetails.open = false;
    const nativeCalls = requests.mock.calls.length;
    await draw({ reader: { ...defaultReader, spoilerLevel: 1 } });
    expect(region().querySelector('[data-work-node="franchise"]')).toBe(stream);
    expect(evidence(0)).toBe(retainedEvidence);
    expect(retainedDetails.open).toBe(focus === 'browse');
    expect(browse(1)).not.toBeNull();
    expect(browse(2)).toBeNull();
    expect(window.document.activeElement === (focus === 'browse' ? browse(1) : evidence(1))).toBe(true);
    expect(requests.mock.calls.length).toBe(nativeCalls);
    retainedDetails.open = false;
    await draw({ reader: { ...defaultReader, spoilerLevel: 1 } });
    expect(retainedDetails.open).toBe(false);
    expect(evidence(0)).toBe(retainedEvidence);
    // A later actual A/B/A preference cannot re-admit the unchanged source or replay focus.
    await draw({ reader: { ...defaultReader, spoilerLevel: 2 } });
    expect(browse(1)).toBeNull();
    await draw({ reader: { ...defaultReader, spoilerLevel: 1 } });
    expect(browse(1)).toBeNull();
    // A fresh admitted source recovers rows, but does not inherit the consumed URL intent.
    const fresh = structuredClone(page);
    await draw({ page: fresh });
    expect(browse(1)).not.toBeNull();
    expect(window.document.activeElement === (focus === 'browse' ? browse(1) : evidence(1))).toBe(false);
    const replacedReader = { ...defaultReader, spoilerLevel: 1, suitabilityLevel: 1 };
    await draw({ reader: replacedReader });
    expect(browse(1)).toBeNull();
    await draw({ page: structuredClone(page) });
    // A hidden control is consumed at the heading; later preference/source replacement cannot revive it.
    await draw({ currentHref: returnHref(2) });
    expect(browse(2)).toBeNull();
    expect(window.document.activeElement === region().querySelector('h2')).toBe(true);
    await draw({ reader: { ...defaultReader, spoilerLevel: 2 } });
    await draw({ page: structuredClone(page) });
    expect(browse(2)).not.toBeNull();
    expect(window.document.activeElement === (focus === 'browse' ? browse(2) : evidence(2))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
