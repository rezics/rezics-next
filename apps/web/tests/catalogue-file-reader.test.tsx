import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry } from '@rezics/composition';
import { act, createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  catalogueFileProfileFixture,
  catalogueFile,
  catalogueEpisode,
} from '../src/kernel/fake/catalogue-file-profile';
import { catalogueFileReaderVisit } from '../src/features/catalogue/catalogue-file-reader/model';
import { timePresentation } from '../src/subject/time-presentation';
import type { SubjectPageData } from '../src/features/pages/subject';
import { subjectPageMessages } from '../src/features/pages/route-support';
import {
  catalogueFileDestinationHref,
  catalogueFileSourceReturnHref,
} from '../src/features/catalogue/catalogue-file-reader/navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');
const { CatalogueFileReader } = await import('../src/features/catalogue/catalogue-file-reader/reader');

async function mounted(
  run: (context: { host: HTMLElement; window: Window; render: (element: ReactNode) => Promise<void> }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/catalogue-file' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      window: window as unknown as Window,
      render: async (element) => act(async () => root.render(element)),
    });
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function ordinaryPage(publicRead: SubjectRead): SubjectPageData {
  const document: SubjectPageData['document'] = {
    root: { props: {} },
    content: [
      {
        type: 'Slot',
        props: {
          id: 'header',
          name: 'header',
          children: [
            { type: 'SubjectHeader', props: { id: 'subject-header' } },
            { type: 'Slot', props: { id: 'actions', name: 'actions', children: [] } },
          ],
        },
      },
      { type: 'Statements', props: { id: 'file-facts', properties: ['schema:name', 'wdt:P4092'] } },
      { type: 'RelationGroups', props: { id: 'file-relations', property: 'schema:encodesCreativeWork', limit: 20 } },
    ],
  };
  const page: SubjectPageData = {
    subject: publicRead.subject.id,
    profile: 'catalogue-file-reader-test',
    template: { scope: 'base', key: 'schema:MediaObject' },
    document,
    reads: {},
  };
  const plan = planReads(platformRegistry, document, {
    subject: page.subject,
    account: null,
  });
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') page.reads[key] = { status: 200, body: publicRead };
    else if (read.kind === 'relations') page.reads[key] = { status: 200, body: { relations: [], next: null } };
    else if (read.kind === 'links') page.reads[key] = { status: 200, body: { links: [], next: null } };
  }
  return page;
}

function renderSubject(
  page: SubjectPageData,
  read: SubjectRead,
  release: Release,
  digest: string,
  fileSource?: string,
  statementPropose: 'allowed' | 'denied' | 'unavailable' = 'allowed',
) {
  const supported = !!release.types[read.subject.type];
  page.catalogue = {
    state: supported ? 'released' : 'unsupported',
    type: read.subject.type,
    ...(supported ? { digest, definitions: { types: release.types, properties: release.properties } } : {}),
  };
  page.viewer = {
    state: 'account',
    account: '019a1b2c-3d4e-7f00-8a00-ed170e000195',
    context: read.subject.context,
    actions: { statementPropose },
  };
  const client = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SubjectPage, {
        page,
        locale: 'en',
        messages: subjectPageMessages(),
        fileSource,
        renderJsonLd: false,
      }),
    ),
  );
}

test('ordinary Subject separates file facts from its directed episode relation and returns to its reader anchor', async () => {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok || !result.stream) throw new Error('Expected the admitted file read');
  const page = ordinaryPage(result.public);
  const html = renderSubject(page, result.public, result.release, result.digest);
  const destination = catalogueFileDestinationHref(`/en/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en');
  expect(html).toContain('data-slot="catalogue-file-reader-technical"');
  expect(html).toContain('data-slot="catalogue-file-reader-associations"');
  expect(html).toContain('data-direction="forward"');
  expect(html).toContain(`href="${destination}"`);
  expect(catalogueFileSourceReturnHref(catalogueFile, 'en')).toContain('#catalogue-file-reader');
  expect(html).toContain('not proof of possession');
  expect(html).toContain('data-slot="catalogue-file-reader-correction"');
  const correction = html.match(/<nav[^>]*data-slot="catalogue-file-reader-correction"[^>]*>[\s\S]*?href="([^"]+)"/);
  expect(correction?.[1]).toContain('?fileSource=' + catalogueFile);
  expect(html).not.toContain('data-slot="catalogue-file-reader-ownership"');
});

test('retired associations cannot add a destination return, and unsupported file types keep ordinary facts', async () => {
  const current = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!current.ok) throw new Error('Expected the current file read');
  const retiredRead = structuredClone(current.public);
  const assertion = retiredRead.subject.statements['schema:encodesCreativeWork']?.[0];
  if (!assertion) throw new Error('Expected the current file association');
  retiredRead.subject.statements['schema:encodesCreativeWork'] = [
    {
      ...assertion,
      rezics: { ...assertion.rezics, release: 'sha256:retired' },
    },
  ];
  const retiredHtml = renderSubject(ordinaryPage(retiredRead), retiredRead, current.release, current.digest);
  expect(retiredHtml).not.toContain(`/subjects/${catalogueEpisode}/episode-1?fileSource=`);

  const missing = await catalogueFileProfileFixture('unreleased').read();
  if (!missing.ok) throw new Error('Expected generic facts without file definitions');
  const unsupportedRead = structuredClone(missing.public);
  unsupportedRead.subject.type = 'wd:Q82753';
  const source = current.public.subject.statements['wdt:P4092']?.[0];
  if (!source) throw new Error('Expected a generic fact example');
  unsupportedRead.subject.statements['schema:name'] = [
    {
      ...source,
      id: '00000000-0000-4000-8000-00000000a219',
      property: { id: 'schema:name', data_type: 'string' },
      value: { type: 'value', content: 'Generic file title' },
      rezics: { ...source.rezics, release: missing.digest },
    },
  ];
  const unsupportedPage = ordinaryPage(unsupportedRead);
  const unsupportedHtml = renderSubject(
    unsupportedPage,
    unsupportedRead,
    missing.release,
    missing.digest,
    unsupportedRead.subject.id,
  );
  expect(unsupportedHtml).toContain(
    'Current definitions do not admit this subject as a catalogue file or release group.',
  );
  expect(unsupportedHtml).toContain('Generic file title');
  expect(unsupportedHtml).not.toContain('data-slot="catalogue-file-reader-recovery"');
  expect(unsupportedHtml).not.toMatch(/href="\/en\/subjects\/[^\"]+\/file(?:\?|\")/);
});

test('native page action decisions keep denied and unavailable correction controls closed', async () => {
  const result = await catalogueFileProfileFixture('ready').read();
  if (!result.ok) throw new Error('Expected the current recorded catalogue definitions');
  const denied = renderSubject(
    ordinaryPage(result.public),
    result.public,
    result.release,
    result.digest,
    undefined,
    'denied',
  );
  const unavailable = renderSubject(
    ordinaryPage(result.public),
    result.public,
    result.release,
    result.digest,
    undefined,
    'unavailable',
  );
  expect(denied).not.toContain('data-slot="catalogue-file-reader-correction"');
  expect(unavailable).not.toContain('data-slot="catalogue-file-reader-correction"');
  expect(denied).toContain('Episode 1 file A');
  expect(unavailable).toContain('Episode 1 file A');
});

test('return destinations stay in the same locale and accept only a subject path', () => {
  expect(catalogueFileDestinationHref(`/en/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en')).toContain(
    `fileSource=${catalogueFile}#catalogue-file-reader`,
  );
  expect(
    catalogueFileDestinationHref(`/ja/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en'),
  ).toBeUndefined();
  expect(catalogueFileDestinationHref('https://example.test/en/subjects/episode', catalogueFile, 'en')).toBeUndefined();
});

test('one exact inspection keeps value provenance and grouped evidence while concealed and historical targets stay closed', async () => {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok) throw new Error('Expected the admitted current catalogue read');
  const publicRead = structuredClone(result.public);
  const hash = publicRead.subject.statements['wdt:P4092']?.[0];
  if (!hash) throw new Error('Expected the admitted hash assertion');
  const timeValue = {
    time: '-0044-03-15T00:00:00Z',
    precision: 11,
    calendarmodel: 'http://www.wikidata.org/entity/Q1985786',
    timezone: 0,
    before: 1,
    after: 2,
  };
  hash.rezics = { release: 'sha256:accepted-statement', revision: 9 };
  hash.qualifiers.push(
    { property: { id: 'schema:startDate', data_type: 'time' }, value: { type: 'value', content: timeValue } },
    { property: { id: 'schema:description', data_type: 'string' }, value: { type: 'somevalue' } },
    { property: { id: 'schema:description', data_type: 'string' }, value: { type: 'novalue' } },
  );
  hash.references = [
    {
      parts: [
        { property: { id: 'schema:datePublished', data_type: 'time' }, value: { type: 'value', content: timeValue } },
      ],
    },
    {
      parts: [{ property: { id: 'schema:description', data_type: 'string' }, value: { type: 'novalue' } }],
    },
  ];
  const visit = catalogueFileReaderVisit({
    locale: 'en',
    public: publicRead,
    release: result.release,
    digest: result.digest,
  });
  await mounted(async ({ host, window, render }) => {
    await render(createElement(CatalogueFileReader, { visit }));
    const assertion = host.querySelector<HTMLButtonElement>('[data-property="wdt:P4092"] [data-inspection-trigger]');
    if (!assertion) throw new Error('Expected an exact assertion inspection control');
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).not.toContain('sha256');
    await act(async () => assertion.click());
    const panel = host.querySelector<HTMLElement>('[data-slot="catalogue-file-inspection"]');
    expect(panel?.textContent).toContain('Evidence inspection');
    expect(panel?.textContent).toContain('abc123def456');
    expect(panel?.textContent).toContain('sha256');
    expect(panel?.textContent).toContain('Unknown value');
    expect(panel?.textContent).toContain('No value');
    expect(panel?.textContent).toContain(timePresentation(timeValue, 'en').text);
    expect(panel?.textContent).toContain('sha256:accepted-statement');
    expect(panel?.textContent).toContain(String(hash.rezics.revision));
    expect(panel?.querySelectorAll('[data-slot="catalogue-file-inspection-references"] ol > li')).toHaveLength(2);
    expect(panel?.querySelector('[data-qualifier-property="schema:description"] ol')?.children).toHaveLength(2);
    expect(window.document.activeElement).toBe(panel?.querySelector('#catalogue-file-inspection-heading'));

    const association = host.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]');
    if (!association) throw new Error('Expected an admitted episode association');
    await act(async () => association.click());
    expect(host.querySelectorAll('[data-slot="catalogue-file-inspection"]')).toHaveLength(1);
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')?.textContent).toContain('Episode 1');
    expect(association.getAttribute('aria-expanded')).toBe('true');
    const close = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-inspection"] button');
    if (!close) throw new Error('Expected the inspection close control');
    await act(async () => {
      close.click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(window.document.activeElement).toBe(association);
  });

  const concealedResult = await catalogueFileProfileFixture('concealed-episode').read(
    'forward:schema:encodesCreativeWork',
  );
  if (!concealedResult.ok) throw new Error('Expected the admitted concealed-episode read');
  const concealed = catalogueFileReaderVisit({
    locale: 'en',
    public: concealedResult.public,
    release: concealedResult.release,
    digest: concealedResult.digest,
  });
  const concealedMarkup = renderToStaticMarkup(createElement(CatalogueFileReader, { visit: concealed }));
  expect(concealedMarkup).toContain('currently concealed');
  expect(concealedMarkup).not.toContain(catalogueEpisode);

  const historicalRead = structuredClone(result.public);
  historicalRead.subject.statements['schema:encodesCreativeWork']![0]!.rezics.release = 'sha256:historical';
  const historical = catalogueFileReaderVisit({
    locale: 'en',
    public: historicalRead,
    release: result.release,
    digest: result.digest,
  });
  const historicalAssociation = historical.associations.find((item) => item.target.id === catalogueEpisode);
  expect(historicalAssociation?.historical).toBe(true);
  const episodeDestination = catalogueFileDestinationHref(
    '/en/subjects/' + catalogueEpisode + '/episode-1',
    catalogueFile,
    'en',
  );
  if (!episodeDestination) throw new Error('Expected the same-locale episode destination');
  const historicalMarkup = renderToStaticMarkup(createElement(CatalogueFileReader, { visit: historical }));
  expect(historicalMarkup).toContain('This value was accepted under an earlier definition release.');

  historical.associations.forEach((item) => {
    item.readability = 'unreadable';
  });
  const unreadableMarkup = renderToStaticMarkup(createElement(CatalogueFileReader, { visit: historical }));
  expect(unreadableMarkup).toContain('unreadable');
  const emptyRead = structuredClone(result.public);
  emptyRead.subject.statements = {};
  emptyRead.subject.sourceRecords = [];
  const empty = catalogueFileReaderVisit({
    locale: 'en',
    public: emptyRead,
    release: result.release,
    digest: result.digest,
  });
  expect(empty.state).toBe('empty');
  const emptyMarkup = renderToStaticMarkup(createElement(CatalogueFileReader, { visit: empty }));
  expect(emptyMarkup).toContain('data-slot="catalogue-file-reader-empty"');
  expect(emptyMarkup).toContain('Nothing was returned on this page.');
});
