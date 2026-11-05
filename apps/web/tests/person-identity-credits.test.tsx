import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { relationActor, relationFixture, relationProperty } from '../src/kernel/fake/catalogue-relations';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { personGroups } from '../src/features/catalogue/person-reader/model';
import { creditVisit } from '../src/features/catalogue/credit-inspection/model';
import { creditReturn, creditWindowHref } from '../src/features/catalogue/credit-inspection/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { OverviewValue, RowValue } from '../src/features/pages/overview';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { PersonReader } = await import('../src/features/catalogue/person-reader/reader');
const { m } = await import('../src/paraglide/messages.js');

function creditRows(fixture: ReturnType<typeof relationFixture>, cursor: string) {
  const rows = [fixture.original, fixture.sibling].map((assertion) => ({
    subject: fixture.id,
    property: relationProperty,
    statement: assertion.id,
    assertion,
    creditSlot: {
      ...fixture.slot,
      key: assertion.id === fixture.original.id ? fixture.slot.key : '00000000-0000-8000-8000-000000000103',
    },
    label: 'The same work',
    related: Object.fromEntries(
      Object.entries(fixture.publicRead.related).map(([id, value]) => [
        id,
        { id, type: value.type, label: { value: value.labels.en, language: 'en' } },
      ]),
    ),
  }));
  return {
    ok: true as const,
    read: {
      kind: 'links' as const,
      id: relationActor,
      property: relationProperty,
      limit: 20,
      cursor,
    },
    body: { links: rows, next: 'continued:opaque+cursor' },
  };
}

function personCreditVisit(
  fixture: ReturnType<typeof relationFixture>,
  section: ReturnType<typeof creditRows>,
  locale: string,
) {
  const labels = Object.fromEntries(
    Object.entries(definitions.release.properties).map(([id, value]) => [id, value.labels[locale] ?? value.labels.en]),
  );
  return creditVisit(
    {
      subject: relationActor,
      context: { id: fixture.publicRead.subject.context },
      realm: '00000000-0000-8000-8000-000000000011',
      releaseDigest: fixture.publicRead.subject.release,
      candidatePropertyLabel: (id: string) => labels[id],
      relations: { [relationProperty]: { forwardLabel: 'Voice actor' } },
      relationDirections: [
        {
          state: 'admitted',
          property: relationProperty,
          direction: 'inverse',
          release: fixture.publicRead.subject.release,
        },
      ],
    } as unknown as OverviewValue,
    'voice',
    section,
    'works',
  )!;
}

test('Person identity keeps names, sites, biography and named unsupported occupations beside qualified credit return', () => {
  const fixture = personReaderExample();
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    const html = renderToStaticMarkup(
      h(PersonReader, { public: fixture.read, release: fixture.release, documents: fixture.documents, locale }),
    );
    expect(html).toContain('Mira Sato');
    expect(html).toContain('佐藤ミラ');
    expect(html).toContain('Mira directs independent films.');
    expect(html).toContain('https://example.org/original');
    expect(html).toContain('https://example.org/biography');
    expect(html).toContain(m.showcase_people_credits({}, { locale }));
    expect(html).toContain('href="#connections"');
    expect(html).toContain(m.people_biography_unsupported({}, { locale }));
    expect(
      personGroups(fixture.release, fixture.read, locale)[1]!.fields
        .filter((field) => !field.admitted)
        .map((field) => field.id),
    ).toEqual(['schema:hasOccupation', 'schema:occupation']);
  }
  const empty = personReaderExample('empty');
  expect(
    renderToStaticMarkup(
      h(PersonReader, { public: empty.read, release: empty.release, documents: empty.documents, locale: 'en' }),
    ),
  ).toContain(m.people_biography_absent({}, { locale: 'en' }));
});

test('qualified credit inspection opens the exact work, preserves locale on return, and walks a continued or empty page', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'Element',
        'Node',
        'Text',
        'NodeFilter',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'DOMRect',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CoverList } = await import('../src/features/pages/cover-list');
  const { holderItems } = await import('../src/features/pages/overview');
  const { sessionQuery } = await import('../src/session/query');
  const { defaultReader } = await import('../src/subject/reader');
  const fixture = relationFixture();
  const first = creditRows(fixture, 'current:opaque+cursor');
  const continued = creditRows(fixture, 'continued:opaque+cursor');
  continued.body.links = [continued.body.links[1]!];
  continued.body.next = null;
  const visit = personCreditVisit(fixture, first, 'en');
  const continuedVisit = personCreditVisit(fixture, continued, 'ja');
  const continuedItems = holderItems(continued.body, 20)!.items;
  const continuedOrigin = creditWindowHref(continuedVisit, 'ja', continuedItems[0]!.credit!);
  expect(continuedOrigin.startsWith('/ja/subjects/')).toBe(true);
  expect(new URL(continuedOrigin, 'https://site.test').searchParams.get('cursor')).toBe('continued:opaque+cursor');
  expect(subjectVisitReturn(continuedOrigin, 'ja')).toBe(continuedOrigin);
  expect(subjectVisitReturn(continuedOrigin, 'en')).toBeUndefined();
  expect(holderItems({ links: [] }, 20)!.items).toEqual([]);
  const value: RowValue = {
    locale: 'en',
    link: (props) => h('a', props),
    reader: defaultReader,
    labels: {
      spoilerShow: 'Show',
      documentSpoiler: 'Spoiler',
      cover: { withheld: '', reveal: '', credit: '', via: '' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show',
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
  let items = holderItems(first.body, 20)!.items;
  const render = (key = 'credits') =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(CoverList, { key, items, value, label: 'Current credits', creditVisit: visit }),
        ),
      ),
    );
  const click = async (name: string) =>
    act(async () => {
      const button = [...window.document.querySelectorAll('button')].find((button) => button.textContent === name)!;
      button.focus();
      button.click();
    });
  try {
    await render();
    await click(m.credit_inspect());
    await act(async () => {
      await import('../src/features/catalogue/credit-inspection/session');
    });
    const dialog = window.document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Original credit');
    expect(dialog!.textContent).toContain(m.relation_sign_in());
    const work = [...dialog!.querySelectorAll('a')].find((link) => link.pathname.includes('/subjects/'))!;
    const origin = new URL(work.href).searchParams.get('via')!;
    expect(origin.startsWith('/en/subjects/')).toBe(true);
    expect(subjectVisitReturn(origin, 'en')).toBe(origin);
    expect(subjectVisitReturn(origin, 'ja')).toBeUndefined();
    expect(new URL(origin, 'https://site.test').searchParams.get('cursor')).toBe('current:opaque+cursor');
    expect(creditReturn(new URL(origin, 'https://site.test').hash)).toMatchObject({
      statement: fixture.original.id,
    });
    await click(m.credit_close());
    items = [];
    await render('empty');
    expect(host.querySelector('button[data-credit-statement]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
