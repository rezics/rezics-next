import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import definitions from '../../../packages/definitions/release/rezics.json';
import { qualifiedRelationsPage } from '../src/kernel/fake/qualified-relations';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';
import type { Subject } from '../src/subject/types';
import type { OverviewValue } from '../src/features/pages/overview';
import { directedWorkRelations, workDestinations } from '../src/features/pages/showcase-work/model';
import { createConnectionWindow } from '../src/features/pages/subject-connections-window';
import {
  connectionReturnHref,
  connectionReturnWindow,
  subjectVisitReturn,
  withSubjectVisitReturn,
} from '../src/features/pages/subject-visit-navigation';
import type { ConnectionVisit, ConnectionWork } from '../src/features/pages/subject-connections';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { readConnectionVisit, connectionStreams } = await import('../src/features/pages/subject-connections');
const { subjectBody } = await import('../src/features/pages/subject');
const { loadSubjectPage, selectWorkFranchiseRegion } = await import('../src/features/pages/showcase-work');
const { OverviewContext } = await import('../src/features/pages/overview');
const { SubjectConnections } = await import('../src/features/pages/subject-connections-view');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const property = 'wdt:P155';
const release = { ...definitions, digest: `sha256:${'a'.repeat(64)}` } as unknown as GuideRelease;
const original = (n = 10, target = id(2), rank = 'normal') => ({
  id: id(n),
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'value', content: target },
  rank,
  qualifiers: [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: '2' } }],
  references: [
    {
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://source.test/original' },
        },
      ],
    },
  ],
  rezics: { release: release.digest, revision: 7 },
});
const summary = (target = id(2), type = 'schema:Book') => ({
  id: target,
  type,
  types: [type],
  label: { value: '海の物語與跨媒體作品', language: 'ja' },
  cover: null,
});
const forward = (n = 10, target = id(2)) => ({
  target,
  statement: original(n, target),
  summary: summary(target),
  label: '海の物語與跨媒體作品',
  related: {},
});
function pageFor(subject = id(1), type = 'wd:Q689445') {
  const page = qualifiedRelationsPage();
  const reading = subjectBody(page)!;
  page.subject = subject;
  Object.assign(reading.subject, { id: subject, type, labels: { en: 'Source work' } });
  page.document = { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, { subject, context: page.context });
  page.reads = Object.fromEntries(Object.entries(plan.reads).map(([key]) => [key, { status: 200, body: reading }]));
  return page;
}
const stream = (direction: 'in' | 'out' = 'out') =>
  connectionStreams(release, 'schema:Book', id(1), 'en').find(
    (s) => s.property === property && s.direction === direction,
  )!;

test('unselected previews use best rank; native slot-selected previews preserve separate originals', () => {
  const source = {
    id: id(1),
    statements: { [property]: [original(10, id(2), 'deprecated'), original(11), original(12, id(3), 'preferred')] },
  } as unknown as Subject;
  const related = {
    [id(2)]: { labels: { en: 'Book' }, type: 'schema:Book' },
    [id(3)]: { labels: { en: 'Anime' }, type: 'schema:TVSeries' },
  };
  const relation = {
    [property]: { label: 'Followed by', forwardLabel: 'Follows', symmetric: false, group: 'order' as const },
  };
  expect(workDestinations(source, related, relation).map((row) => row.statement.id)).toEqual([id(12)]);
  source.relationCounts = { [property]: 2 };
  expect(workDestinations(source, related, relation).map((row) => row.statement.id)).toEqual([id(11), id(12)]);
  const inverse = {
    subject: id(2),
    property,
    statement: id(10),
    assertion: original(10, id(1)),
    summary: summary(),
    related: {},
  };
  const projected = directedWorkRelations(id(1), property, 'in', {
    links: [inverse, { ...inverse, statement: id(11), assertion: original(11, id(1)) }, { ...inverse, summary: null }],
  })!;
  expect(projected.map((row) => [row.holder, row.statement.id, row.direction])).toEqual([
    [id(2), id(10), 'in'],
    [id(2), id(11), 'in'],
  ]);
  expect(projected[0]!.statement).toBe(inverse.assertion);
  expect(
    directedWorkRelations(id(1), property, 'in', { links: [{ ...inverse, summary: summary(id(3)) }] }),
  ).toBeUndefined();
});

test('native page acquisition selects the second exact region and never borrows a cursor or substitutes a successful sibling', async () => {
  const page = pageFor();
  page.catalogue = { state: 'unsupported', type: 'schema:Book' };
  const reading = subjectBody(page)!;
  page.continuation = { node: 'second', cursor: 'opaque-current' };
  page.document = {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'identity' } },
      { type: 'OutgoingRelations', props: { id: 'first', property, limit: 2, paged: true } },
      { type: 'OutgoingRelations', props: { id: 'second', property, limit: 2, paged: true } },
    ],
  };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    context: page.context,
    continuation: page.continuation,
  });
  const rows = [forward(10), forward(11)];
  page.reads = Object.fromEntries(
    Object.entries(plan.reads).map(([key, read]) => [
      key,
      read.kind === 'subject'
        ? { status: 200, body: reading }
        : read.kind === 'relations' && read.cursor
          ? { status: 200, body: { relations: rows, next: 'opaque-next' } }
          : { status: 204, body: {} },
    ]),
  );
  const aliasPage = { ...page, continuation: undefined };
  const aliasPlan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    context: page.context,
  });
  expect(aliasPlan.nodes.first).toBe(aliasPlan.nodes.second);
  aliasPage.reads = Object.fromEntries(
    Object.entries(aliasPlan.reads).map(([key, read]) => [
      key,
      { status: 200, body: read.kind === 'subject' ? reading : { relations: rows, next: 'alias-next' } },
    ]),
  );
  expect(selectWorkFranchiseRegion(aliasPage, { node: 'second', property, direction: 'forward' })?.window.node).toBe(
    'second',
  );
  const requests: unknown[] = [];
  const client = createKernelClient('https://native.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/v1/pages:read');
      requests.push(await request.json());
      return Response.json(page);
    }) as typeof fetch,
  });
  const loaded = await loadSubjectPage(client, id(1), 'relations', 'en', {
    realm: id(4),
    continuation: page.continuation,
  });
  expect(loaded.kind).toBe('page');
  if (loaded.kind !== 'page') throw Error('Expected native page');
  expect(requests).toMatchObject([
    {
      target: { subject: id(1), view: 'relations', realm: id(4) },
      continuation: { node: 'second', cursor: 'opaque-current' },
    },
  ]);
  const selection = { node: 'second', property, direction: 'forward' as const, cursor: 'opaque-current' };
  const region = selectWorkFranchiseRegion(loaded.page, selection)!;
  expect(region.window.rows).toBe((loaded.page.reads[plan.nodes.second!]!.body as { relations: unknown[] }).relations);
  expect(region.window.limit).toBe(2);
  expect(region.continuation).toEqual({ node: 'second', cursor: 'opaque-next' });
  for (const change of [
    { node: 'first' },
    { node: 'missing' },
    { property: 'wdt:P156' },
    { direction: 'inverse' as const },
    { cursor: 'borrowed' },
  ])
    expect(selectWorkFranchiseRegion(loaded.page, { ...selection, ...change })).toBeUndefined();
  loaded.page.reads[plan.nodes.second!] = { status: 503, body: {} };
  const failed = selectWorkFranchiseRegion(loaded.page, selection)!;
  expect(failed.window.status).toBe(503);
  expect(failed.window.valid).toBe(false);
  expect(failed.continuation).toBeUndefined();
});

test('64/512/4096 composition counts requests, decoded rows and bytes; exact return detects current disclosure changes', async () => {
  const samples: ConnectionWork[] = [];
  for (const population of [64, 512, 4096]) {
    const unrelated = Array.from({ length: population }, (_, n) => ({
      subject: id(n + 100),
      obsolete: original(n + 5000),
    }));
    const page = pageFor();
    let changed = false;
    const requests: URL[] = [];
    const client = createKernelClient('https://native.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        requests.push(url);
        if (url.pathname.endsWith('/pages:read')) return Response.json(page);
        if (url.pathname.includes('/definitions'))
          return Response.json(
            url.pathname.endsWith('active') ? { digest: release.digest } : { digest: release.digest, release },
          );
        expect(url.searchParams.get('limit')).toBe('12');
        const row = forward();
        if (changed) row.summary.label.value = 'Current replacement';
        return Response.json(
          url.pathname.endsWith('/links') ? { links: [], next: null } : { relations: [row], next: 'next-window' },
        );
      }) as typeof fetch,
    });
    const deps = { observe: (work: Readonly<ConnectionWork>) => samples.push({ ...work }) };
    const address = {
      id: id(1),
      locale: 'en',
      only: 'relations' as const,
      selection: { relations: { stream: stream().key, cursor: 'same-window' } },
    };
    const first = await readConnectionVisit(client, address, undefined, undefined, deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw Error('Unavailable');
    const reading = first.sections.relations!.reading!;
    const current = await readConnectionVisit(
      client,
      { ...address, selection: { relations: { ...address.selection.relations, reading } } },
      undefined,
      undefined,
      deps,
    );
    expect(current.ok && current.sections.relations!.section.ok).toBe(true);
    changed = true;
    const replaced = await readConnectionVisit(
      client,
      { ...address, selection: { relations: { ...address.selection.relations, reading } } },
      undefined,
      undefined,
      deps,
    );
    expect(replaced.ok && replaced.sections.relations!.section).toEqual({ ok: false, status: 409 });
    expect(requests).toHaveLength(15);
    expect(
      requests
        .filter((url) => url.pathname.endsWith('/relations'))
        .every((url) => url.searchParams.get('cursor') === 'same-window'),
    ).toBe(true);
    expect(unrelated.length).toBe(population); // Remains outside the adapter's native finite input.
  }
  expect(samples.filter((_, index) => index % 3 === 0)).toEqual(Array(3).fill(samples[0]));
  expect(samples[0]!.calls).toBe(5);
  expect(samples[0]!.values).toBe(1);
  expect(samples[0]!.bytes).toBeLessThan(1_048_576);
});

test('failed continuation retries its exact cursor, preserves siblings and fences retired A-to-B-to-A results', async () => {
  const inputs: unknown[] = [];
  const success: Extract<ConnectionVisit, { ok: true }> = {
    ok: true,
    id: id(1),
    release: release.digest,
    streams: [stream()],
    sections: { relations: { stream: stream(), section: { ok: false, status: 503 } } },
  };
  let settle: ((visit: ConnectionVisit) => void) | undefined;
  const window = createConnectionWindow(
    { id: id(1), locale: 'en', selection: { relations: { stream: stream().key, cursor: 'failed-page' } } },
    async (address) => {
      inputs.push(address);
      return inputs.length < 3
        ? success
        : new Promise((resolve) => {
            settle = resolve;
          });
    },
  );
  await window.load();
  await window.retry('relations');
  expect((inputs[1] as { selection: unknown }).selection).toEqual({
    relations: { stream: stream().key, cursor: 'failed-page' },
  });
  const pending = window.retry('relations');
  window.retire();
  window.activate();
  settle!(success);
  await pending;
  expect(window.snapshot().visit).toBeUndefined();
});

test('mounted VN to anime to book uses one immediate window opener, inverse meaning, exact explanation and focus return', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: `https://site.test/en/subjects/${id(1)}/source` });
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
  let reads = 0;
  const read = async (address: { id: string }): Promise<ConnectionVisit> => {
    reads++;
    const direction = address.id === id(2) ? 'in' : 'out';
    const selected = stream(direction);
    const row =
      direction === 'in'
        ? {
            subject: id(3),
            property,
            statement: id(10),
            assertion: original(10, id(2)),
            summary: summary(id(3)),
            related: {},
          }
        : { ...forward(), summary: summary(id(2), 'schema:TVSeries') };
    return {
      ok: true,
      id: address.id,
      release: release.digest,
      streams: [selected],
      sections: {
        relations: {
          stream: selected,
          reading: 'b'.repeat(64),
          section: {
            ok: true,
            read: {
              kind: direction === 'in' ? 'links' : 'relations',
              id: address.id,
              property,
              limit: 12,
              cursor: 'selected-window',
            },
            body: { [direction === 'in' ? 'links' : 'relations']: [row], next: null },
          },
        },
      },
    };
  };
  async function mount(
    subject: string,
    returnTo?: string,
    page = pageFor(subject, subject === id(1) ? 'wd:Q689445' : subject === id(2) ? 'schema:TVSeries' : 'schema:Book'),
  ) {
    const value = {
      subject,
      subjectLabel: 'Source work',
      locale: 'en',
      link: (props: any) => createElement('a', props),
      reader: { spoilerLevel: 0, suitability: 'show' },
      labels: { cover: {}, spoilerHide: 'Hide' },
      unlabelled: 'Unlabelled',
      spoilerShow: 'Reveal',
      relations: {},
      sections: {},
    } as OverviewValue;
    await act(async () =>
      root.render(
        createElement(
          OverviewContext.Provider,
          { value },
          createElement(SubjectConnections, { page, viewer: { state: 'signed-out', csrfToken: null }, read, returnTo }),
        ),
      ),
    );
  }
  try {
    await mount(id(1));
    expect(host.textContent).toContain(stream().label);
    expect(host.textContent).toContain('https://source.test/original');
    const target = host.querySelector<HTMLAnchorElement>(`a[href*="/subjects/${id(2)}/"]`)!;
    const via = new URL(target.href).searchParams.get('via')!;
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    const locator = connectionReturnWindow(new URL(via, 'https://site.test').hash)!;
    expect(locator).toMatchObject({ cursor: 'selected-window', focus: id(10), holder: id(1) });
    browser.location.href = target.href;
    await mount(id(2), via);
    expect(host.textContent).toContain(stream('in').label);
    const next = host.querySelector<HTMLAnchorElement>(`a[href*="/subjects/${id(3)}/"][href*="via="]`)!;
    const immediate = new URL(next.href).searchParams.get('via')!;
    expect(immediate).toContain(id(2));
    expect(immediate).not.toContain('via=');
    browser.location.href = next.href;
    await mount(id(3), immediate);
    browser.location.href = `https://site.test${via}`;
    await mount(id(1));
    expect(document.activeElement?.closest('[data-work-statement]')?.getAttribute('data-work-statement')).toBe(id(10));
    const sameSource = pageFor();
    await mount(id(1), undefined, sameSource);
    const before = reads;
    subjectBody(sameSource)!.subject.revision++;
    await mount(id(1), undefined, sameSource);
    expect(reads).toBe(before + 1);
    await act(async () => root.render(createElement('p', {}, 'Reader replaced')));
    expect(host.textContent).not.toContain('source.test/original');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
