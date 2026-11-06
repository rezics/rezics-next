import './support/ensure-document.ts';
import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { relationActor, relationFixture, relationProperty } from '../src/kernel/fake/catalogue-relations';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { personCrossSourceIdentity, personGroups } from '../src/features/catalogue/person-reader/model';
import { creditVisit } from '../src/features/catalogue/credit-inspection/model';
import { creditReturn, creditWindowHref } from '../src/features/catalogue/credit-inspection/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { OverviewValue } from '../src/features/pages/overview';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonReader } = await import('../src/features/catalogue/person-reader/reader');
const { holderItems } = await import('../src/features/pages/overview');
const { m } = await import('../src/paraglide/messages.js');

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
    expect(html).toContain(m.person_identity_unconfirmed({}, { locale }));
    expect(html).toContain(m.people_biography_unsupported({}, { locale }));
    const filter = /<input[^>]*type="search"[^>]*>/.exec(html)?.[0] ?? '';
    expect(filter).toContain('min-h-11');
    expect(filter).toContain('min-w-11');
    expect(html).toContain('whitespace-normal [overflow-wrap:anywhere]');
    expect(
      personGroups(fixture.release, fixture.read, locale)[1]!
        .fields.filter((field) => !field.admitted)
        .map((field) => field.id),
    ).toEqual(['schema:hasOccupation', 'schema:occupation']);
  }
  const empty = personReaderExample('empty');
  expect(personCrossSourceIdentity(empty.read)).toBe('unconfirmed');
  expect(
    renderToStaticMarkup(
      h(PersonReader, { public: empty.read, release: empty.release, documents: empty.documents, locale: 'en' }),
    ),
  ).toContain(m.people_biography_absent({}, { locale: 'en' }));

  const credits = relationFixture();
  const assertion = credits.original;
  const section = {
    ok: true as const,
    read: {
      kind: 'links' as const,
      id: relationActor,
      property: relationProperty,
      limit: 20,
      cursor: 'continued:opaque+cursor',
    },
    body: {
      links: [
        {
          subject: credits.id,
          property: relationProperty,
          statement: assertion.id,
          assertion,
          creditSlot: credits.slot,
          label: 'The same work',
          related: Object.fromEntries(
            Object.entries(credits.publicRead.related).map(([id, value]) => [
              id,
              { id, type: value.type, label: { value: value.labels.en, language: 'en' } },
            ]),
          ),
        },
      ],
    },
  };
  const visit = creditVisit(
    {
      subject: relationActor,
      context: { id: credits.publicRead.subject.context },
      realm: '00000000-0000-8000-8000-000000000011',
      releaseDigest: credits.publicRead.subject.release,
      candidatePropertyLabel: (id: string) => definitions.release.properties[id]?.labels.ja,
      relations: { [relationProperty]: { forwardLabel: 'Voice actor' } },
      relationDirections: [
        {
          state: 'admitted',
          property: relationProperty,
          direction: 'inverse',
          release: credits.publicRead.subject.release,
        },
      ],
    } as unknown as OverviewValue,
    'voice',
    section,
    'works',
  )!;
  const item = holderItems(section.body, 20)!.items[0]!;
  const origin = creditWindowHref(visit, 'ja', item.credit);
  expect(origin.startsWith('/ja/subjects/')).toBe(true);
  expect(new URL(origin, 'https://site.test').searchParams.get('cursor')).toBe('continued:opaque+cursor');
  expect(subjectVisitReturn(origin, 'ja')).toBe(origin);
  expect(subjectVisitReturn(origin, 'en')).toBeUndefined();
  expect(creditReturn(new URL(origin, 'https://site.test').hash)).toMatchObject({ statement: assertion.id });
  expect(holderItems({ links: [] }, 20)!.items).toEqual([]);
});

test('Person names filter accepts keyboard entry and keeps the supplied identity readable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { sessionQuery } = await import('../src/session/query');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
  const fixture = personReaderExample();
  try {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(PersonReader, {
            public: fixture.read,
            release: fixture.release,
            documents: fixture.documents,
            locale: 'en',
          }),
        ),
      ),
    );
    expect(host.textContent).toContain('Mira Sato');
    expect(host.textContent).toContain(m.person_identity_unconfirmed({}, { locale: 'en' }));
    const summary = host.querySelector<HTMLElement>('#supplied-names summary')!;
    summary.focus();
    await act(async () => summary.click());
    const input = host.querySelector<HTMLInputElement>('#supplied-names input')!;
    expect(input.className).toContain('min-w-11');
    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'ミラ');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('ミラ');
    expect(
      [...host.querySelectorAll('#supplied-names [data-supplied-name]')].some(
        (node) => node.textContent === '佐藤ミラ',
      ),
    ).toBe(true);
    expect(host.textContent).toContain('Mira Sato');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
