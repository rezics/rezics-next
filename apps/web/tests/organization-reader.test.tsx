import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { peopleOrganizationId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import {
  organizationCurrent,
  organizationHistory,
  type OrganizationFact,
  type OrganizationCurrent,
} from '../src/features/catalogue/organization-reader';
import { OrganizationReader } from '../src/features/catalogue/organization-reader/view';
import { OrganizationOverview } from '../src/features/catalogue/organization-reader/overview';
import type { PeopleRead } from '../src/features/catalogue/people-profile';
import { m } from '../src/paraglide/messages.js';

const target = '00000000-0000-4000-8000-00000000d301';
function fixture() {
  const fixture = peopleProfileFixture('ready', 'en', 'organization');
  const { release, organization: publicRead } = fixture;
  publicRead.subject.descriptions = { en: 'A historical studio', ja: '歴史ある制作会社' };
  publicRead.related[target] = {
    type: 'schema:Organization',
    labels: { en: 'Earlier Studio' },
    redirect: peopleOrganizationId,
  };
  const fact: OrganizationFact = {
    id: '00000000-0000-4000-8000-00000000d302',
    rank: 'preferred',
    property: { id: 'wdt:P1365', data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: [
      {
        property: { id: 'schema:startDate', data_type: 'time' },
        value: {
          type: 'value',
          content: {
            time: '+1999-00-00T00:00:00Z',
            precision: 9,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      },
      {
        property: { id: 'schema:endDate', data_type: 'time' },
        value: {
          type: 'value',
          content: {
            time: '+2001-03-00T00:00:00Z',
            precision: 10,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      },
    ],
    references: [
      {
        hash: 'original-source',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.org/history' },
          },
        ],
      },
    ],
    rezics: { release: publicRead.subject.release, revision: 7 },
  };
  publicRead.subject.statements['wdt:P1365'] = [fact];
  const read: OrganizationCurrent = { ok: true, public: publicRead, release, work: null, profiles: [], credits: [] };
  return { read, fact };
}

test('ordinary Organization reading keeps directed history, partial dates, ranks and provenance only for admitted facts', () => {
  const { read, fact } = fixture();
  const model = organizationHistory(read, 'en')!;
  expect(model.fields.find((field) => field.id === 'wdt:P1365')!.facts).toEqual([fact]);
  expect(model.unreleased).toEqual([]);
  expect(model.authoredUnsupported).toBe(false);
  fact.qualifiers = Array.from({ length: 33 }, () => fact.qualifiers[0]!);
  const bounded = organizationHistory(read, 'en')!;
  expect(bounded.limited).toBe(true);
  expect(bounded.fields.find((field) => field.id === 'wdt:P1365')).toMatchObject({ facts: [], unavailable: true });
  delete read.release.properties['wdt:P1365'];
  expect(organizationHistory(read, 'en')!.fields.some((field) => field.id === 'wdt:P1365')).toBe(false);
  expect(organizationHistory(read, 'en')!.unreleased.map((field) => field.meaning)).toEqual(['predecessor']);
  expect(organizationCurrent(read, target, read.public.subject.context)).toBeUndefined();
  read.public.subject.type = 'schema:Person';
  expect(organizationHistory(read, 'en')).toBeUndefined();
});

test('history inspection follows the exact disclosed identity, returns focus, and retires controls with source and authority', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/organization/studio' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { read } = fixture();
  let source = {};
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <OrganizationReader read={read} source={source} locale="en" />
        </QueryClientProvider>,
      ),
    );
  const button = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === name)!;
  const settle = (change: () => void) =>
    act(async () => {
      change();
      await Promise.resolve();
    });
  try {
    await show();
    const targetLink = [...host.querySelectorAll('a')].find((link) => link.textContent === 'Earlier Studio')!;
    expect(targetLink.href).toContain(target);
    expect(new URL(targetLink.href).searchParams.get('via')).toContain(peopleOrganizationId);
    expect(host.textContent).toContain('A historical studio');
    expect(host.textContent).toContain('歴史ある制作会社');
    const opener = button(m.organization_reader_inspect());
    opener.focus();
    await settle(() => opener.click());
    expect(host.textContent).toContain('1999');
    expect(host.textContent).toContain('March 2001');
    expect(host.textContent).not.toContain('January 1');
    expect(host.textContent).toContain(m.candidate_rank_preferred());
    expect(host.querySelector('a[href="https://example.org/history"]')).not.toBeNull();
    const correction = [...host.querySelectorAll('a')].find((link) =>
      new URL(link.href).searchParams.has('statement'),
    )!;
    expect(new URL(correction.href).searchParams.get('statement')).toBe(
      read.public.subject.statements['wdt:P1365']![0]!.id,
    );
    await settle(() => button(m.organization_reader_return()).click());
    expect(window.document.activeElement).toBe(opener);
    await settle(() => opener.click());
    await settle(() => client.setQueryData(['exposure', 'viewer'], { revision: 2 }));
    expect(host.textContent).toContain(m.organization_reader_unavailable());
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect([...host.querySelectorAll('a')].map((link) => link.textContent)).toEqual([m.organization_reader_refresh()]);
    expect(correction.isConnected).toBe(false);
    source = {};
    await show();
    expect(host.textContent).toContain('Earlier Studio');
    delete read.public.related[target];
    source = {};
    await show();
    expect(host.textContent).toContain(m.people_biography_unreadable());
    expect([...host.querySelectorAll('a')].some((link) => link.href.includes(target))).toBe(false);
    await settle(() => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect([...host.querySelectorAll('a')].map((link) => link.textContent)).toEqual([m.organization_reader_refresh()]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('delayed profile reads cannot cross a source, locale, authority or page lifetime', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const pending: ((read: PeopleRead) => void)[] = [];
  const read = () => new Promise<PeopleRead>((resolve) => pending.push(resolve));
  const current = fixture().read;
  let source = {};
  const show = (locale: string) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <OrganizationOverview
            id={peopleOrganizationId}
            context={current.public.subject.context}
            source={source}
            reader={null}
            locale={locale}
            read={read}
          />
        </QueryClientProvider>,
      ),
    );
  try {
    await show('en');
    source = {};
    await show('ja');
    await act(async () => pending[0]!(current));
    expect(host.textContent).not.toContain('Earlier Studio');
    await act(async () => pending[1]!(current));
    expect(host.textContent).toContain('Earlier Studio');
    await act(async () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(host.textContent).not.toContain('Earlier Studio');
    source = {};
    await show('en');
    await act(async () => root.unmount());
    await act(async () => pending[2]!(current));
    expect(host.textContent).toBe('');
  } finally {
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('authorized historical documents follow exact statement, identity, digest, language and current selected-document policy', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { personReaderExample } = await import('../src/features/catalogue/person-reader/examples');
  const { read } = fixture();
  const example = personReaderExample();
  const statement = example.read.subject.statements['schema:abstract']![0]!;
  read.public.subject.statements['schema:abstract'] = [statement];
  const documents = structuredClone(example.documents) as Record<string, Record<string, unknown>>;
  documents[statement.id]!.subjectId = read.public.subject.id;
  const render = (authorized: unknown = documents) =>
    renderToStaticMarkup(<OrganizationReader read={read} locale="en" documents={authorized} />);
  expect(render()).toContain('Mira directs independent films.');
  expect(render()).toContain('lang="en"');
  for (const [key, value] of Object.entries({
    subjectId: target,
    candidateId: target,
    id: target,
    digest: 'b'.repeat(64),
    language: 'ja',
    availability: 'unavailable',
  })) {
    const mismatch = structuredClone(documents);
    mismatch[statement.id]![key] = value;
    expect(render(mismatch)).not.toContain('Mira directs independent films.');
  }
  expect(render({})).not.toContain('Mira directs independent films.');
  const alternative = { ...statement, id: target, rank: 'preferred' as const };
  read.public.subject.statements['schema:abstract'] = [alternative, statement];
  expect(render()).not.toContain('Mira directs independent films.');
  delete read.public.related['00000000-0000-4000-8000-00000000d301'];
  expect(render()).not.toContain('00000000-0000-4000-8000-00000000d301');
  statement.qualifiers = [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+2', unit: '1' } },
    },
  ];
  read.public.subject.statements['schema:abstract'] = [statement];
  expect(render()).not.toContain('Mira directs independent films.');
  expect(
    renderToStaticMarkup(
      <OrganizationReader
        read={read}
        locale="en"
        documents={documents}
        preferences={{ spoilerLevel: 2, suitability: 'blur' }}
      />,
    ),
  ).toContain('Mira directs independent films.');
});
