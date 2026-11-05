import { expect, mock, test } from 'bun:test';
import { act, createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  catalogueFileProfileFixture,
  catalogueFile,
  catalogueEpisode,
} from '../src/kernel/fake/catalogue-file-profile';
import type { SubjectPageData } from '../src/features/pages/subject';
import {
  admittedCatalogueFileSelection,
  parseCatalogueFileCorrectionOrigin,
} from '../src/features/catalogue/catalogue-file-profile/origin';
import { catalogueFileReaderVisit } from '../src/features/catalogue/catalogue-file-reader/model';
import {
  fileEvidenceAt,
  fileEvidenceReturn,
  catalogueFileSourceReturnHref,
} from '../src/features/catalogue/catalogue-file-reader/navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { CatalogueFileReader, CatalogueFileReaderOverview, CatalogueFileReturnLink } =
  await import('../src/features/catalogue/catalogue-file-reader/reader');
const { CatalogueFileProfilePage } = await import('../src/features/catalogue/catalogue-file-profile/view');
const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
const { Route: FileRoute } = await import('../src/routes/subjects/$id_.$slug_.file');
const realm = '00000000-0000-4000-8000-00000000b001';
const sourceHref = `/en/subjects/${catalogueFile}/episode-1-file-a?realm=${realm}`;

async function mounted(
  run: (host: HTMLElement, render: (element: ReactNode) => Promise<void>, client: QueryClient) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.test${sourceHref}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  try {
    await run(
      host,
      async (element) => {
        await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
        await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
      },
      client,
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function fixture() {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok) throw new Error('Expected current File');
  const read = structuredClone(result.public);
  const hash = read.subject.statements['wdt:P4092']![0]!;
  const item = {
    property: { id: 'schema:encodesCreativeWork', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: catalogueEpisode },
  };
  hash.qualifiers.push(item);
  hash.references.push({ hash: '0000000000000000000000000000000000000001', parts: [item] });
  const visit = () =>
    catalogueFileReaderVisit({ public: read, locale: 'en', release: result.release, digest: result.digest });
  return { read, visit };
}

function link(host: HTMLElement, selector: string): string {
  const href = host.querySelector<HTMLAnchorElement>(selector)?.getAttribute('href');
  if (!href) throw new Error(`Expected disclosed link: ${selector}`);
  return href;
}

test('ordinary item, qualifier, reference and association visits return to the exact current Context and inspection', async () => {
  const { visit } = await fixture();
  await mounted(async (host, render) => {
    for (const kind of ['item', 'qualifier', 'reference', 'association']) {
      const locale = kind === 'qualifier' ? 'zh-Hant' : kind === 'reference' ? 'ja' : 'en';
      const origin = sourceHref
        .replace('/en/', `/${locale}/`)
        .replace('episode-1-file-a', encodeURIComponent('証拠'.repeat(30)));
      const current = { ...visit(), locale };
      await render(createElement(CatalogueFileReader, { key: `source-${kind}`, visit: current, currentHref: origin }));
      if (kind === 'qualifier' || kind === 'reference') {
        await act(async () => host.querySelector<HTMLButtonElement>('[data-property="wdt:P4092"] button')!.click());
      }
      const selector =
        kind === 'association'
          ? '[data-evidence-kind="association"] a'
          : kind === 'item'
            ? '[data-property="schema:encodesCreativeWork"] a'
            : `[data-slot="catalogue-file-inspection-${kind === 'qualifier' ? 'qualifiers' : 'references'}"] a`;
      const destination = link(host, selector);
      const receipt = fileEvidenceAt(destination, locale)!;
      expect(receipt.context).toBe(current.public.subject.context);
      expect(receipt.realm).toBe(realm);
      expect(receipt.kind).toBe(kind === 'association' ? 'association' : 'assertion');
      expect(receipt.part).toBe(kind === 'qualifier' ? 'q:1' : kind === 'reference' ? 'r:0:0' : 'value');
      expect(new URL(destination, 'https://site.test').searchParams.get('fileSource')).toBe(catalogueFile);
      expect(destination).not.toContain('/file?');
      await render(createElement(CatalogueFileReturnLink, { id: catalogueFile, locale, currentHref: destination }));
      const back = link(host, 'a');
      expect(back.split('#')[0]).toBe(origin);
      expect(back).not.toContain('via=');
      // The route supplies a new current composition; the receipt cannot supply a response body.
      await render(
        createElement(CatalogueFileReader, { key: `return-${kind}`, visit: { ...visit(), locale }, currentHref: back }),
      );
      const panel = host.querySelector<HTMLElement>('[data-slot="catalogue-file-inspection"]')!;
      expect(panel).not.toBeNull();
      expect(host.ownerDocument.activeElement).toBe(
        receipt.part === 'value'
          ? panel.querySelector('h2')
          : panel.querySelector(`[data-file-evidence-part="${receipt.part}"]`),
      );
      expect(host.querySelector('[aria-expanded="true"][data-inspection-trigger]')).not.toBeNull();
    }
  });
});

test('changed, historical and unavailable assertions explain return and focus the current group', async () => {
  const { read, visit } = await fixture();
  let back = '';
  await mounted(async (host, render) => {
    await render(createElement(CatalogueFileReader, { visit: visit(), currentHref: sourceHref }));
    const destination = link(host, '[data-evidence-kind="association"] a');
    back = catalogueFileSourceReturnHref(catalogueFile, 'en', '', fileEvidenceAt(destination, 'en'))!;
    for (const state of ['changed', 'historical', 'unavailable'] as const) {
      const current = visit();
      if (state === 'changed')
        current.associations[0]!.statement = {
          ...current.associations[0]!.statement,
          rezics: { ...current.associations[0]!.statement.rezics, revision: 2 },
        };
      if (state === 'historical') current.associations[0]!.historical = true;
      if (state === 'unavailable') current.associations[0]!.readability = 'concealed';
      await render(createElement(CatalogueFileReader, { key: state, visit: current, currentHref: back }));
      expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
      expect(host.querySelector('[data-slot="catalogue-file-return-outcome"]')?.textContent).toContain(
        state === 'changed' ? 'changed' : state === 'historical' ? 'historical' : 'unavailable',
      );
      expect(host.ownerDocument.activeElement).toBe(
        host.querySelector('[data-slot="catalogue-file-reader-associations"] h2'),
      );
    }
    expect(read.subject.labels.en).toBe('Episode 1 file A');
  });
});

test('return receipt cannot replay after session or Context ABA', async () => {
  const { visit } = await fixture();
  await mounted(async (host, render, client) => {
    const current = visit();
    await render(createElement(CatalogueFileReader, { visit: current, currentHref: sourceHref }));
    const destination = link(host, '[data-evidence-kind="association"] a');
    const back = catalogueFileSourceReturnHref(catalogueFile, 'en', '', fileEvidenceAt(destination, 'en'))!;
    const session = { status: 'authenticated', subject: catalogueFile, csrfToken: 'one' };
    await act(async () => client.setQueryData(['session'], session));
    const reader = (source: object, descriptor: string) =>
      createElement(CatalogueFileReader, { key: 'returned', visit: current, source, descriptor, currentHref: back });
    await render(reader(current, 'A'));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).not.toBeNull();
    await act(async () => client.setQueryData(['session'], { ...session, csrfToken: 'two' }));
    await act(async () => client.setQueryData(['session'], session));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    await render(reader({}, 'B'));
    await render(reader(current, 'A'));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).toContain('earlier selection was not restored');
  });
});

test('concealed and spoiler evidence has no href, identifier or inspection fallback; partial facts survive', async () => {
  const { visit } = await fixture();
  await mounted(async (host, render) => {
    const current = visit();
    const association = current.associations[0]!;
    association.readability = 'concealed';
    association.statement.references = [
      {
        hash: '0000000000000000000000000000000000000002',
        parts: [
          {
            property: { id: 'schema:description', data_type: 'string' },
            value: { type: 'value', content: 'Concealed evidence' },
          },
        ],
      },
    ];
    await render(createElement(CatalogueFileReader, { visit: current, currentHref: sourceHref }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]')!.click());
    const panel = host.querySelector('[data-slot="catalogue-file-inspection"]')!;
    expect(panel.textContent).not.toContain('Concealed evidence');
    expect(panel.innerHTML).not.toContain(catalogueEpisode);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-property="schema:encodesCreativeWork"] button')!.click(),
    );
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')!.textContent).not.toContain(
      'Concealed evidence',
    );
    association.readability = 'readable';
    association.statement.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '2', unit: '1' } },
    });
    await render(createElement(CatalogueFileReader, { key: 'spoiler', visit: current, currentHref: sourceHref }));
    const row = host.querySelector('[data-evidence-kind="association"]')!;
    expect(row.querySelector('a')).toBeNull();
    expect(row.innerHTML).not.toContain(catalogueEpisode);
    expect(row.textContent).not.toContain('Episode 1');
    expect(host.textContent).toContain('abc123def456');
  });
  expect(fileEvidenceReturn('#catalogue-file-reader?evidence=%')).toBeUndefined();
  expect(fileEvidenceAt(`/ja/subjects/${catalogueFile}/file#catalogue-file-reader`, 'en')).toBeUndefined();
});

test('the mounted public correction entry carries overview or exact own scalar intent and keeps public evidence separate', async () => {
  const result = await catalogueFileProfileFixture('ready').read();
  if (!result.ok) throw new Error('Expected current File');
  const href = `/en/subjects/${catalogueFile}/episode-file`;
  const page: SubjectPageData = {
    subject: catalogueFile,
    profile: 'file',
    template: { scope: 'base', key: result.public.subject.type },
    document: { root: { props: {} }, content: [] },
    reads: {},
    catalogue: {
      state: 'released',
      type: result.public.subject.type,
      digest: result.digest,
      definitions: result.release,
    },
    viewer: {
      state: 'account',
      account: catalogueFile,
      context: result.public.subject.context,
      actions: { statementPropose: 'allowed' },
    },
  };
  await mounted(async (host, render, client) => {
    const overview = (currentHref = href) =>
      createElement(CatalogueFileReaderOverview, {
        page,
        public: result.public,
        locale: 'en',
        currentHref,
      });
    const origin = () => {
      const url = new URL(link(host, '[data-slot="catalogue-file-reader-correction"] a'), 'https://site.test');
      expect(url.searchParams.get('fileSource')).toBe(catalogueFile);
      const parsed = parseCatalogueFileCorrectionOrigin(url.searchParams.get('origin'), 'en', catalogueFile);
      if (parsed.kind !== 'valid') throw new Error('Expected observed correction origin');
      return parsed.origin;
    };
    await render(overview());
    expect(origin()).toMatchObject({
      subject: catalogueFile,
      context: result.public.subject.context,
      definition: result.digest,
    });
    expect(origin().selection).toBeUndefined();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-property="wdt:P4092"] button')!.click());
    const scalar = origin();
    expect(admittedCatalogueFileSelection(result, scalar)).toEqual({
      property: 'wdt:P4092',
      candidate: result.public.subject.statements['wdt:P4092']![0]!.id,
    });
    expect(fileEvidenceAt(scalar.returnHref, 'en')?.kind).toBe('assertion');
    const search = FileRoute.options.validateSearch as (input: Record<string, unknown>) => {
      origin: ReturnType<typeof parseCatalogueFileCorrectionOrigin>;
    };
    const received = search(
      Object.fromEntries(
        new URL(link(host, '[data-slot="catalogue-file-reader-correction"] a'), 'https://site.test').searchParams,
      ),
    );
    expect(received.origin).toMatchObject({ kind: 'valid', origin: scalar });
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: [href + '/file'] }),
    });
    const unexpected = async (): Promise<never> => {
      throw new Error('Navigation must not submit a command');
    };
    const receiver = catalogueFileProfileFixture('ready');
    await render(
      createElement(
        RouterContextProvider,
        { router },
        createElement(CandidateReaderBoundary, {
          observed: { state: 'signed-in', subject: catalogueFile, csrfToken: 'one' },
          address: href + '/file',
          children: createElement(CatalogueFileProfilePage, {
            id: catalogueFile,
            locale: 'en',
            origin: scalar,
            returnHref: scalar.returnHref,
            returnSourceId: catalogueFile,
            search: async () => [],
            transport: {
              read: receiver.read,
              facts: {
                read: async () => ({ ok: true, public: result.public, release: result.release, source: null }),
                propose: unexpected,
              },
              relation: () => ({ read: unexpected, propose: unexpected, confirm: unexpected }),
              review: () => ({ read: async () => ({ ok: false, reason: 'denied' }), confirm: unexpected }),
            },
          }),
        }),
      ),
    );
    expect(host.querySelector('[data-slot="catalogue-file-profile"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="catalogue-file-correction-restart"]')).toBeNull();
    expect([...host.querySelectorAll('a')].some((anchor) => anchor.getAttribute('href') === scalar.returnHref)).toBe(
      true,
    );
    expect(receiver.calls.every((call) => call.method === 'GET')).toBe(true);
    await render(overview());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]')!.click());
    expect(origin().selection).toBeUndefined();
    expect(fileEvidenceAt(origin().returnHref, 'en')?.kind).toBe('association');
    await render(overview(href.replace('episode-file', 'x'.repeat(768))));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-property="wdt:P4092"] button')!.click());
    expect(
      new URL(link(host, '[data-slot="catalogue-file-reader-correction"] a'), 'https://site.test').searchParams.get(
        'origin',
      ),
    ).toBe('!');
    for (const advice of ['denied', 'unavailable'] as const) {
      page.viewer!.actions.statementPropose = advice;
      await render(overview());
      expect(host.querySelector('[data-slot="catalogue-file-reader-correction"]')).toBeNull();
    }
    page.viewer!.actions.statementPropose = 'allowed';
    page.requestedRealm = realm;
    await render(overview(`${href}?realm=${realm}`));
    expect(host.querySelector('[data-slot="catalogue-file-reader-correction"]')).toBeNull();
    page.requestedRealm = undefined;
    await render(overview());
    const stale = host.querySelector<HTMLAnchorElement>('[data-slot="catalogue-file-reader-correction"] a')!;
    let prevented = false;
    stale.addEventListener('click', (event) => {
      prevented = event.defaultPrevented;
    });
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: catalogueFile, csrfToken: 'changed' });
      stale.click();
    });
    expect(prevented).toBe(true);
    // The ordinary route supplies the new public read. Return never reuses the old response.
    const fresh = catalogueFileReaderVisit({
      public: structuredClone(result.public),
      locale: 'en',
      release: result.release,
      digest: result.digest,
    });
    await render(createElement(CatalogueFileReader, { key: 'fresh', visit: fresh, currentHref: scalar.returnHref }));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).not.toBeNull();
  });
});
