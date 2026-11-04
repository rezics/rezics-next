import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { dirname } from 'node:path';
import type { CompositionDocument, SelectedContext } from '@rezics/composition';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';
import type { OverviewValue } from '../src/features/pages/overview';
import type { ConnectionAddress, ConnectionStream, ConnectionVisit, ConnectionWork } from '../src/features/pages/subject-connections';
import type { ConnectionRead } from '../src/features/pages/subject-connections-window';
import type { SubjectPageData } from '../src/features/pages/subject';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { createKernelClient } = await import('@rezics/client');
const { planReads, platformRegistry } = await import('@rezics/composition');
const definitions = (await import('../../../packages/definitions/release/rezics.json')).default;
const { qualifiedRelationsPage } = await import('../src/kernel/fake/qualified-relations');
const { identityProperty } = await import('../src/features/catalogue/character-relationships/reading');
const { connectionStreams, readConnectionVisit } = await import('../src/features/pages/subject-connections');
const { connectionReturnWindow, subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const { OverviewContext } = await import('../src/features/pages/overview');
const { SubjectConnections } = await import('../src/features/pages/subject-connections-view');
const { subjectBody } = await import('../src/features/pages/subject');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = id(1);
const target = id(2);
const parent = id(4);
const release = { ...definitions, digest: `sha256:${'a'.repeat(64)}` } as unknown as GuideRelease;
const streams = connectionStreams(release, 'wd:Q95074', source, 'en');
const identity = streams.find((stream) => stream.property === identityProperty && stream.direction === 'out')!;
const father = streams.find((stream) => stream.property === 'wdt:P22' && stream.direction === 'in')!;
const summary = (subject: string, label: string, type = 'wd:Q95074') => ({
  id: subject,
  type,
  types: [type],
  label: { value: label, language: 'ja' },
  creativeWork: false,
  cover: null,
});

function statement(id: string, property: string, value: string, spoiler = false) {
  return {
    id,
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: value },
    qualifiers: spoiler
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '1', unit: '1' } },
          },
        ]
      : [],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://source.test/character-assertion' },
          },
        ],
        hash: 'reference-hash',
      },
    ],
    rezics: { release: release.digest, revision: 7 },
  };
}

function identityRow(n: number, label: string, hidden = false, destination = n === 2 ? target : id(n)) {
  return {
    target: destination,
    statement: statement(id(100 + n), identity.property, destination, hidden),
    label,
    type: 'wd:Q95074',
    summary: summary(destination, label),
    related: { [destination]: summary(destination, label) },
  };
}

function parentRow() {
  return {
    subject: parent,
    property: father.property,
    statement: id(140),
    assertion: statement(id(140), father.property, source),
    label: 'Mina’s father',
    type: 'wd:Q95074',
    summary: summary(parent, 'Mina’s father'),
    related: {},
  };
}

function visit(stream: ConnectionStream, rows: unknown[], next: string | null = 'current-next', subject = source): ConnectionVisit {
  const kind = stream.direction === 'in' ? 'links' : 'relations';
  return {
    ok: true,
    id: subject,
    release: release.digest,
    streams,
    sections: {
      relations: {
        stream,
        reading: 'b'.repeat(64),
        section: {
          ok: true,
          read: { kind, id: subject, property: stream.property, limit: 12, cursor: 'selected-cursor' },
          body: { [kind]: rows, next },
        },
      },
    },
  } as unknown as ConnectionVisit;
}

function pageForCharacter(context?: SelectedContext, subject = source): SubjectPageData {
  const page = qualifiedRelationsPage();
  const reading = subjectBody(page)!;
  page.subject = subject;
  Object.assign(reading.subject, {
    id: subject,
    type: 'wd:Q95074',
    labels: { en: 'Mina' },
    relationCounts: { [identity.property]: 1 },
    ...(context ? { context: context.id } : {}),
  });
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'identity' } }],
  };
  page.document = document;
  const plan = planReads(platformRegistry, document, { subject, context: page.context });
  page.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
  if (context) page.context = context;
  return page;
}

function overview(context?: SelectedContext, locale = 'en', realm?: string, subject = source): OverviewValue {
  return {
    subject,
    subjectLabel: 'Mina / ミナ',
    locale,
    ...(context ? { context } : {}),
    ...(realm ? { realm } : {}),
    link: (props: any) => createElement('a', props),
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { spoilerHide: 'Hide', cover: {} },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    details: 'Details',
    cover: 'Cover',
    coverVia: 'Cover via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    relations: {},
    sections: new Map(),
    relationNodes: [],
  } as unknown as OverviewValue;
}

async function withMountedPage(run: (input: {
  host: HTMLElement;
  browser: any;
  mount: (props: {
    value?: OverviewValue;
    page?: SubjectPageData;
    viewer?: { state: string; subject?: string | null; csrfToken: string | null };
    read: ConnectionRead;
  }) => Promise<void>;
}) => Promise<void>) {
  const { Window } = await makeWindow();
  const browser = new Window({ url: `https://site.test/en/subjects/${source}/mina` });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      browser,
      mount: async ({ value = overview(), page = pageForCharacter(value.context, value.subject ?? source), viewer = { state: 'signed-out', csrfToken: null }, read }) => {
        await act(async () =>
          root.render(
            createElement(
              OverviewContext.Provider,
              { value },
              createElement(SubjectConnections, { page, viewer, read }),
            ),
          ),
        );
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
}

async function makeWindow() {
  return await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
}

test('directed identity and incoming parent keep released meaning, exact evidence, duplicate assertions and return focus', async () => {
  const realm = id(70);
  const context = { id: realm, population: { kind: 'realm' as const, id: realm, title: 'Mina’s Realm' } };
  await withMountedPage(async ({ host, browser, mount }) => {
    await mount({
      value: overview(context, 'ja', realm),
      read: async () => visit(identity, [
        identityRow(2, '海を渡る長い名前の旅人'),
        identityRow(3, '海を渡る長い名前の旅人', false, target),
      ]),
    });
    expect(host.querySelector('[data-slot="character-identity-visit"]')).not.toBeNull();
    expect(host.querySelectorAll(`[data-connection-statement="${id(102)}"] a[href*="/subjects/${target}/"]`)).toHaveLength(1);
    expect(host.querySelectorAll(`[data-connection-statement="${id(102)}"]`)).toHaveLength(1);
    expect(host.querySelector(`[data-connection-statement="${id(102)}"]`)?.getAttribute('data-connection-holder')).toBe(source);
    expect(host.querySelectorAll(`[data-connection-statement], [data-connection-holder]`)).toHaveLength(2);
    expect(host.querySelectorAll(`a[href*="/subjects/${target}/"]`)).toHaveLength(2);
    const targetLink = host.querySelector<HTMLAnchorElement>(`[data-connection-statement="${id(102)}"] a[href*="/subjects/${target}/"]`)!;
    const targetUrl = new URL(targetLink.href);
    expect(targetUrl.pathname.startsWith('/ja/subjects/')).toBe(true);
    expect(targetUrl.searchParams.get('realm')).toBe(realm);
    const via = targetUrl.searchParams.get('via')!;
    expect(subjectVisitReturn(via, 'ja')).toBe(via);
    expect(new URL(via, 'https://site.test').searchParams.get('realm')).toBe(realm);
    expect(connectionReturnWindow(new URL(via, 'https://site.test').hash)).toMatchObject({
      stream: identity.key,
      cursor: 'selected-cursor',
      reading: 'b'.repeat(64),
      focus: id(102),
      holder: source,
    });
    expect([...host.querySelectorAll<HTMLAnchorElement>('a')].some((link) => link.href.includes(id(102)))).toBe(true);
    expect([...host.querySelectorAll<HTMLAnchorElement>('a')].some((link) => link.href.includes(id(103)))).toBe(true);

    browser.location.href = targetUrl.href;
    await mount({
      value: overview(context, 'ja', realm, target),
      page: pageForCharacter(context, target),
      read: async () => visit(identity, [], null, target),
    });
    browser.location.href = via;
    await mount({
      value: overview(context, 'ja', realm),
      page: pageForCharacter(context),
      read: async () => visit(identity, [identityRow(2, '海を渡る長い名前の旅人'), identityRow(3, '海を渡る長い名前の旅人', false, target)], null),
    });
    expect(document.activeElement?.closest('[data-connection-statement]')?.getAttribute('data-connection-statement')).toBe(id(102));

    browser.location.href = `https://site.test/en/subjects/${source}/mina#connections`;
    await mount({ value: overview(context), read: async () => visit(father, [parentRow()], null) });
    expect(host.textContent).toContain(father.label);
    expect(host.textContent).toContain(father.forwardLabel);
    expect(host.textContent).toContain('Mina’s father');
    expect(host.querySelector(`[data-connection-holder="${parent}"]`)).not.toBeNull();
    expect([...host.querySelectorAll<HTMLAnchorElement>('a')].some((link) => link.href.includes(id(140)))).toBe(true);
  });
});

test('spoiler gating hides the complete association and withheld targets disclose no identifier', async () => {
  await withMountedPage(async ({ host, mount }) => {
    const withheld = id(9);
    const missing = { target: withheld, statement: statement(id(109), identity.property, withheld), summary: null, related: {} };
    await mount({
      read: async () => visit(identity, [identityRow(2, 'Visible identity'), identityRow(8, 'Secret identity, must stay hidden', true, id(8)), missing]),
    });
    expect(host.textContent).toContain('Visible identity');
    expect(host.textContent).toContain('Some relationships are hidden at the current spoiler level.');
    expect(host.textContent).toContain('Some relationships are not available in this reading.');
    expect(host.textContent).not.toContain('Secret identity, must stay hidden');
    expect(host.innerHTML).not.toContain(id(8));
    expect(host.innerHTML).not.toContain(withheld);
    const reveal = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Show hidden'))!;
    await act(async () => reveal.click());
    expect(host.textContent).toContain('Secret identity, must stay hidden');
    expect(host.innerHTML).not.toContain(withheld);
  });
});

test('caller and selected Context A/B/A retirement rejects late rows from both old incarnations', async () => {
  await withMountedPage(async ({ host, mount }) => {
    const realmA = id(71);
    const realmB = id(72);
    const contextA = { id: realmA, population: { kind: 'realm' as const, id: realmA, title: 'Context A' } };
    const contextB = { id: realmB, population: { kind: 'realm' as const, id: realmB, title: 'Context B' } };
    const pending: { address: ConnectionAddress; resolve: (visit: ConnectionVisit) => void }[] = [];
    const read: ConnectionRead = (address) =>
      new Promise((resolve) => pending.push({ address, resolve }));
    const viewerA = { state: 'signed-in', subject: id(80), csrfToken: 'caller-a' };
    const viewerB = { state: 'signed-in', subject: id(81), csrfToken: 'caller-b' };
    await mount({ value: overview(contextA, 'en', realmA), viewer: viewerA, read });
    await mount({ value: overview(contextB, 'en', realmB), viewer: viewerB, read });
    await mount({ value: overview(contextA, 'en', realmA), viewer: viewerA, read });
    expect(pending.map(({ address }) => address.context)).toEqual([realmA, realmB, realmA]);
    await act(async () => {
      pending[0]!.resolve(visit(identity, [identityRow(2, 'Retired A')], null));
      pending[1]!.resolve(visit(identity, [identityRow(2, 'Retired B')], null));
      pending[2]!.resolve(visit(identity, [identityRow(2, 'Current A')], null));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Current A');
    expect(host.textContent).not.toContain('Retired A');
    expect(host.textContent).not.toContain('Retired B');
  });
});

test('64/512/4096 unrelated Subjects leave the adapter calls, current rows and UTF-8 response charge fixed', async () => {
  const samples: { initial: ConnectionWork; more: ConnectionWork; initialRows: number; currentRows: number }[] = [];
  for (const population of [64, 512, 4096]) {
    const unrelated = Array.from({ length: population }, (_, index) => ({ subject: id(1000 + index), obsolete: statement(id(5000 + index), identity.property, target) }));
    const page = pageForCharacter();
    const requests: URL[] = [];
    const client = createKernelClient('https://native.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        requests.push(url);
        if (url.pathname.endsWith('/pages:read')) return Response.json(page);
        if (url.pathname.includes('/definitions'))
          return Response.json(url.pathname.endsWith('active') ? { digest: release.digest } : { digest: release.digest, release });
        const kind = url.pathname.endsWith('/links') ? 'links' : 'relations';
        const stream = streams.find((candidate) => candidate.property === url.searchParams.get('property'))!;
        const rows = Array.from({ length: 12 }, (_, index) => {
          const destination = id(200 + index);
          const assertion = statement(
            id(300 + index),
            stream.property,
            stream.direction === 'in' ? source : destination,
            stream.property === identityProperty,
          );
          return stream.direction === 'in'
            ? { subject: destination, property: stream.property, statement: assertion.id, assertion, type: 'wd:Q95074', label: `Character ${index}`, summary: summary(destination, `Character ${index}`), related: {} }
            : { target: destination, statement: assertion, label: `Character ${index}`, type: 'wd:Q95074', summary: summary(destination, `Character ${index}`), related: { [destination]: summary(destination, `Character ${index}`) } };
        });
        return Response.json({ [kind]: rows, next: url.searchParams.has('cursor') ? null : 'opaque-next' });
      }) as typeof fetch,
    });
    const work: ConnectionWork[] = [];
    const address: ConnectionAddress = {
      id: source,
      locale: 'en',
      selection: { relations: { stream: identity.key } },
    };
    const read: ConnectionRead = (selected, signal) =>
      readConnectionVisit(client, selected, undefined, signal, { observe: (current) => work.push({ ...current }) });
    const window = (await import('../src/features/pages/subject-connections-window')).createConnectionWindow(address, read);
    window.activate();
    await window.load();
    const initialVisit = window.snapshot().visit!;
    const initialRows = Object.values(initialVisit.sections).reduce((total, current) => {
      if (!current?.section.ok) return total;
      const rows = current.stream.direction === 'in' ? current.section.body.links : current.section.body.relations;
      return total + (Array.isArray(rows) ? rows.length : 0);
    }, 0);
    const initialBytes = work.at(-1)!.bytes;
    const measuredBodies = Object.values(initialVisit.sections).reduce((total, current) => {
      if (!current?.section.ok) return total;
      return total + new TextEncoder().encode(JSON.stringify(current.section.body)).byteLength;
    }, 0);
    expect(initialBytes).toBe(measuredBodies);
    await window.load('relations', { stream: identity.key, cursor: 'opaque-next' });
    const currentVisit = window.snapshot().visit!;
    const currentRows = Object.values(currentVisit.sections).reduce((total, current) => {
      if (!current?.section.ok) return total;
      const rows = current.stream.direction === 'in' ? current.section.body.links : current.section.body.relations;
      return total + (Array.isArray(rows) ? rows.length : 0);
    }, 0);
    expect(Object.keys(currentVisit.sections)).toHaveLength(3);
    expect(requests.filter((url) => url.pathname.endsWith('/relations') || url.pathname.endsWith('/links')).every((url) => url.pathname.includes(source))).toBe(true);
    expect(requests.some((url) => unrelated.some((entry) => url.pathname.includes(entry.subject)))).toBe(false);
    samples.push({ initial: work[0]!, more: work[1]!, initialRows, currentRows });
    expect(initialVisit.sections.relations?.section.ok).toBe(true);
    expect(currentVisit.sections.relations?.section.ok).toBe(true);
  }
  expect(samples.map(({ initial }) => initial.calls)).toEqual([7, 7, 7]);
  expect(samples.map(({ initial }) => initial.values)).toEqual([36, 36, 36]);
  expect(samples.map(({ more }) => [more.calls, more.values])).toEqual([[5, 12], [5, 12], [5, 12]]);
  expect(samples.map(({ initialRows, currentRows }) => [initialRows, currentRows])).toEqual([
    [36, 36],
    [36, 36],
    [36, 36],
  ]);
  expect(samples.map(({ initial }) => initial.bytes)).toEqual([samples[0]!.initial.bytes, samples[0]!.initial.bytes, samples[0]!.initial.bytes]);
});
