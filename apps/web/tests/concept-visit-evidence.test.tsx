import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ConceptStatement } from '../src/features/catalogue/source-concept-explorer';
import type { FollowWriteInput } from '../src/library/follow-records';

mock.module('cloudflare:workers', () => ({ env: {} }));
const writes: FollowWriteInput[] = [];
mock.module('../src/library/follow-actions', () => ({
  readCurrentFollowState: async ({ data }: { data: { targetId: string } }) => ({
    subject: 'alice',
    targetId: data.targetId,
    edge: { state: 'ready', following: false },
  }),
  readFollowState: async () => ({ state: 'unavailable' }),
  setFollow: async ({ data }: { data: FollowWriteInput }) => {
    writes.push(data);
    return { ok: false, reason: 'unavailable' };
  },
}));
const id = '00000000-0000-4000-8000-00000000a001';
const target = '00000000-0000-4000-8000-00000000a002';
const context = '00000000-0000-4000-8000-00000000a003';
const digest = `sha256:${'a'.repeat(64)}`;
const assertion = (suffix: number, property: string, content: string, spoiler = false): ConceptStatement => ({
  id: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
  rank: 'normal',
  property: { id: property, data_type: property === 'source:code' ? 'external-id' : 'wikibase-item' },
  value: { type: 'value', content },
  qualifiers: spoiler
    ? [
        {
          property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
          value: { type: 'value', content: { amount: '1' } },
        },
      ]
    : [],
  references: [
    {
      hash: '1'.repeat(64),
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: `https://vndb.org/${suffix}` },
        },
      ],
    },
  ],
  rezics: { release: digest, revision: 7 },
});
function source(spoiler = false): SubjectRead {
  return {
    subject: {
      id,
      type: 'skos:Concept',
      revision: 7,
      context,
      release: digest,
      labels: { en: 'Childhood friends' },
      descriptions: { en: 'Friends since childhood.' },
      aliases: { ja: ['幼なじみ'] },
      statements: {
        'skos:inScheme': [
          assertion(1, 'skos:inScheme', target, spoiler),
          assertion(2, 'skos:inScheme', target, spoiler),
        ],
        'source:code': [assertion(3, 'source:code', 'g42', spoiler)],
        'skos:broader': [assertion(4, 'skos:broader', context)],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    related: { [target]: { type: 'skos:ConceptScheme', labels: { en: 'VNDB tags' } } },
    account: null,
    summary: null,
  };
}
async function read(native = source()) {
  const { readSourceConcept } = await import('../src/features/catalogue/source-concept-explorer');
  const client = {
    subjects: () => ({
      get: async () => ({ status: 200, data: native }),
      links: { get: async () => ({ status: 200, data: { links: [], next: null, freshness: { caught_up: true } } }) },
    }),
  } as unknown as KernelClient;
  return readSourceConcept(client, undefined, { ...bundledRelease, digest }, id, 'en', {});
}
async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (name: string) => Promise<void>;
    client: import('@tanstack/react-query').QueryClient;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.test/en/subjects/${id}/friends/concepts` });
  const globals = {
    window,
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
      ].map((key) => [key, window[key]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf-A' });
  const observer = viewerExposureLifetime(client);
  const stopObservation = observer.subscribe(() => {});
  const observation = observer.getSnapshot();
  if (observation.state !== 'signed-in') throw Error('missing observation');
  client.setQueryData(viewerExposureQuery(observation.observation).queryKey, {
    subject: 'alice',
    admitted: ['personal_library'],
  });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await run({
      host,
      client,
      render: async (node) => {
        await act(async () => {
          root.render(h(QueryClientProvider, { client }, node));
        });
        await act(tick);
      },
      click: (name) =>
        act(async () => {
          const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
          expect(button).toBeDefined();
          expect(button!.disabled).toBe(false);
          button!.click();
          await tick();
        }),
    });
  } finally {
    await act(async () => root.unmount());
    stopObservation();
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('Concept name, original assertions, withheld targets and exact native follow recovery share the visit', async () => {
  await mounted(async ({ host, render, click }) => {
    const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
    const native = source();
    const initial = await read(native);
    await render(h(SourceConceptView, { id, locale: 'en', initial, transport: { read: () => read(native) } }));
    expect(host.querySelector('h1')?.textContent).toBe('Childhood friends');
    expect(host.textContent).toContain('Friends since childhood.');
    expect(host.textContent).toContain('Japanese');
    expect([...host.querySelectorAll('a')].filter((node) => node.textContent === 'VNDB tags')).toHaveLength(2);
    const inspections = [...host.querySelectorAll('a')].filter((node) =>
      new URL(node.href).searchParams.has('statement'),
    );
    expect(inspections).toHaveLength(4);
    expect(inspections.map((node) => new URL(node.href).searchParams.get('statement'))).toEqual(
      [1, 2, 3, 4].map((value) => assertion(value, 'skos:inScheme', target).id),
    );
    for (const node of inspections) expect(new URL(node.href).searchParams.get('context')).toBe(context);
    expect(host.querySelector('input[readonly]')?.getAttribute('value')).toBe(id);
    expect(host.textContent).toContain('This value has no readable preview.');
    expect(host.querySelector(`a[href*="${context}"]`)?.textContent).not.toBe(context);
    writes.length = 0;
    await click('Follow');
    await click('Follow');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]);
    expect(writes[0]?.targetId).toBe(id);
    expect(writes[0]?.following).toBe(true);
  });
});

test('native spoiler level gates each whole assertion and resets on exact source replacement', async () => {
  await mounted(async ({ host, render, click }) => {
    const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
    const native = source(true);
    let current = await read(native);
    await render(
      h(SourceConceptView, { id, locale: 'en', initial: current, transport: { read: async () => current } }),
    );
    expect(host.innerHTML).not.toContain('VNDB tags');
    expect(host.innerHTML).not.toContain('g42');
    expect(host.innerHTML).not.toContain('https://vndb.org/1');
    expect(host.innerHTML).not.toContain(target);
    await click('Show spoilers');
    expect(host.textContent).toContain('VNDB tags');
    expect(host.innerHTML).toContain('https://vndb.org/1');
    expect(host.innerHTML).not.toContain('https://vndb.org/2');
    expect(host.innerHTML).not.toContain('g42');
    const next = source(true);
    next.subject.context = id;
    next.subject.release = `sha256:${'b'.repeat(64)}`;
    current = await read(next);
    await click('Refresh source and actions');
    expect(host.innerHTML).not.toContain('VNDB tags');
    expect(host.innerHTML).not.toContain('https://vndb.org/1');
    expect(host.textContent).toContain(next.subject.release);
    await render(
      h(SourceConceptView, {
        id,
        locale: 'en',
        reader: { spoilerLevel: 1, suitability: 'blur' },
        initial: current,
        transport: { read: async () => current },
      }),
    );
    expect(host.textContent).toContain('VNDB tags');
    expect(host.textContent).toContain('g42');
    await render(
      h(SourceConceptView, {
        id,
        locale: 'en',
        reader: { spoilerLevel: 0, suitability: 'blur' },
        initial: current,
        transport: { read: async () => current },
      }),
    );
    expect(host.innerHTML).not.toContain('g42');
  });
});

test('account and session replacement cannot restore a previous reveal through A → B → A', async () => {
  await mounted(async ({ host, render }) => {
    const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const initial = await read(source(true));
    const show = (subject: string, csrfToken: string) =>
      render(
        h(CandidateReaderBoundary, {
          observed: { state: 'signed-in', subject, csrfToken },
          address: id,
          children: h(SourceConceptView, { id, locale: 'en', initial, transport: { read: async () => initial } }),
        }),
      );
    await show('alice', 'one');
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Show spoilers')!.click(),
    );
    expect(host.textContent).toContain('VNDB tags');
    for (const [subject, token] of [
      ['bob', 'two'],
      ['alice', 'one'],
      ['alice', 'three'],
    ]) {
      await show(subject!, token!);
      expect(host.innerHTML).not.toContain('VNDB tags');
      expect(host.innerHTML).not.toContain('https://vndb.org/1');
    }
  });
});

test('source admission counts bytes, parts and repeated disclosed summary expansion before rendering', async () => {
  const { conceptSourceFits } = await import('../src/features/catalogue/source-concept-explorer');
  expect(conceptSourceFits(source())).toBe(true);
  const large = source();
  large.subject.descriptions.en = '界'.repeat(400_000);
  expect(await read(large)).toMatchObject({ ok: false, oversized: true });
  const parts = source();
  parts.subject.statements['skos:inScheme']![0]!.qualifiers = Array.from({ length: 33 }, () => ({
    property: { id: 'schema:url', data_type: 'url' },
    value: { type: 'value', content: 'https://vndb.org' },
  }));
  expect(conceptSourceFits(parts)).toBe(false);
  const expanded = source();
  expanded.related[target] = { labels: { en: '界'.repeat(130_000) } };
  expect(new TextEncoder().encode(JSON.stringify(expanded)).byteLength).toBeLessThan(1024 * 1024);
  expect(conceptSourceFits(expanded)).toBe(false);
});
