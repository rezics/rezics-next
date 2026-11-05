import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRequire } from 'node:module';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionAddress, ConnectionVisit } from '../src/features/pages/subject-connections';
import type { ConnectionRead } from '../src/features/pages/subject-connections-window';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { characterPublicExample } = await import('../src/features/catalogue/character-public-reading/examples');
const { identityProperty } = await import('../src/features/catalogue/character-relationships/reading');
const { connectionStreams } = await import('../src/features/pages/subject-connections');
const { connectionReturnWindow, subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const { CharacterOverview } = await import('../src/features/pages/showcase-people/character');
const { CharacterAssociationBridge } = await import('../src/features/catalogue/character-public-reading/bridge');
const { OverviewContext } = await import('../src/features/pages/overview');
const { SubjectConnections } = await import('../src/features/pages/subject-connections-view');
const { subjectBody } = await import('../src/features/pages/subject');
const { qualifiedRelationsPage } = await import('../src/kernel/fake/qualified-relations');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(2);
const performer = id(4);
const related = id(6);
const gender = id(5);
const appearance = id(11);
const identityStatement = id(30);

function pageFor(character: string) {
  const page = qualifiedRelationsPage();
  const reading = subjectBody(page)!;
  page.subject = character;
  Object.assign(reading.subject, { id: character, type: 'wd:Q95074' });
  page.document = { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: character,
    ...(page.context ? { context: page.context } : {}),
  });
  page.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
  return page;
}

function prepare(locale: string) {
  const fixture = characterPublicExample(locale);
  const character = fixture.value.subject!;
  fixture.profile.read.subject.aliases = { ja: ['助手'] };
  fixture.profile.read.related[gender] = {
    type: 'skos:Concept',
    labels: { en: 'Female', ja: '女性', 'zh-Hant': '女性' },
  };
  fixture.profile.read.subject.statements = {
    'schema:gender': [fixture.profile.statement('schema:gender', gender, 'wikibase-item')],
    'schema:height': [
      fixture.profile.statement(
        'schema:height',
        { amount: '+165.5', unit: 'http://www.wikidata.org/entity/Q174728' },
        'quantity',
      ),
    ],
  };
  const identity = connectionStreams(fixture.profile.release as GuideRelease, 'wd:Q95074', character, locale).find(
    (stream) => stream.property === identityProperty && stream.direction === 'out',
  )!;
  const identitySection = {
    stream: identity,
    reading: 'd'.repeat(64),
    section: {
      ok: true as const,
      read: { kind: 'relations' as const, id: character, property: identity.property, limit: 12 },
      body: {
        relations: [
          {
            target: related,
            statement: {
              id: identityStatement,
              rank: 'normal',
              property: { id: identity.property, data_type: 'wikibase-item' },
              value: { type: 'value', content: related },
              qualifiers: [],
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url', data_type: 'url' },
                      value: { type: 'value', content: 'https://vndb.org/c5' },
                    },
                  ],
                },
              ],
              rezics: { release: fixture.profile.read.subject.release, revision: 1 },
            },
            label: 'Amadeus',
            type: 'wd:Q95074',
            summary: {
              id: related,
              type: 'wd:Q95074',
              types: ['wd:Q95074'],
              label: { value: 'Amadeus', language: 'en' },
              creativeWork: false,
              cover: null,
            },
            related: {},
          },
        ],
        next: null,
      },
    },
  };
  const read: ConnectionRead = async (address, signal) => {
    if (address.only === 'relations')
      return {
        ok: true,
        id: character,
        release: fixture.profile.read.subject.release,
        streams: [...fixture.streams, identity],
        sections: { relations: identitySection },
      };
    const visit = (await fixture.read(address, signal)) as Extract<ConnectionVisit, { ok: true }>;
    visit.streams = [...visit.streams, identity];
    if (!address.only) visit.sections.relations = identitySection;
    return visit;
  };
  return { fixture, character, read };
}

test('composed Character keeps names, traits, appearances, credits, exact Work/Person return and continuation in en, zh-Hant and ja', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(require.resolve('happy-dom', { paths: [require.resolve('@puckeditor/core')] }));
  const browser = new Window({ url: 'https://site.test/en/' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? browser : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : browser[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const member = id(8);
  const calls: ConnectionAddress[] = [];
  try {
    for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
      setLocale(locale, { reload: false });
      const { fixture, character, read } = prepare(locale);
      const page = pageFor(character);
      const wrapped: ConnectionRead = async (address, signal) => {
        calls.push(address);
        return read(address, signal);
      };
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
      browser.location.href = `https://site.test/${locale}/subjects/${character}/character`;
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              OverviewContext.Provider,
              { value: { ...fixture.value, locale } },
              createElement(CharacterAssociationBridge, {
                source: page,
                children: [
                  createElement(CharacterOverview, {
                    key: 'profile',
                    source: page,
                    viewer: null,
                    locale,
                    public: fixture.profile.read,
                    release: fixture.profile.release,
                    link: fixture.value.link,
                  }),
                  createElement(SubjectConnections, {
                    key: 'connections',
                    page,
                    viewer: { state: 'signed-out', csrfToken: null },
                    read: wrapped,
                  }),
                ],
              }),
            ),
          ),
        ),
      );
      expect(host.querySelector('[data-slot="character-reader"]')).not.toBeNull();
      expect(host.textContent).toContain(fixture.profile.read.subject.labels[locale]);
      expect(host.textContent).toContain('助手');
      expect(host.textContent).toContain(locale === 'en' ? 'Female' : '女性');
      expect(host.textContent).toContain('165.5');
      expect(host.querySelector('[data-slot="character-public-reading"]')).not.toBeNull();
      expect(host.querySelector('[data-slot="character-identity-visit"]')).not.toBeNull();
      expect(host.textContent).toContain('STEINS;GATE');
      expect(host.textContent).toContain('今井麻美');
      expect(host.textContent).toContain('Amadeus');
      const next = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === m.subject_connections_next({}, { locale }),
      )!;
      await act(async () => next.click());
      expect(calls.at(-1)?.selection?.characters?.cursor).toBe('native-next');
      expect(host.textContent).toContain('STEINS;GATE 0');
      const workLink = host.querySelector<HTMLAnchorElement>(
        `#connections [data-work-statement="${appearance}"] a[href*="/subjects/${work}/"]`,
      )!;
      const via = new URL(workLink.href).searchParams.get('via')!;
      expect(subjectVisitReturn(via, locale)).toBe(via);
      expect(connectionReturnWindow(new URL(via, 'https://site.test').hash)).toMatchObject({
        stream: 'in:schema:character',
        cursor: 'native-next',
        reading: 'b'.repeat(64),
        focus: appearance,
        holder: work,
      });
      const personLink = [...host.querySelectorAll<HTMLAnchorElement>(`a[href*="/subjects/${performer}/"]`)].find(
        (link) => new URL(link.href).searchParams.get('via'),
      )!;
      expect(subjectVisitReturn(new URL(personLink.href).searchParams.get('via')!, locale)).toBe(
        new URL(personLink.href).searchParams.get('via'),
      );
      browser.location.href = `https://site.test${via}`;
      const returned = pageFor(character);
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              OverviewContext.Provider,
              { value: { ...fixture.value, locale } },
              createElement(CharacterAssociationBridge, {
                source: returned,
                children: [
                  createElement(CharacterOverview, {
                    key: 'profile',
                    source: returned,
                    viewer: null,
                    locale,
                    public: fixture.profile.read,
                    release: fixture.profile.release,
                    link: fixture.value.link,
                  }),
                  createElement(SubjectConnections, {
                    key: 'connections',
                    page: returned,
                    viewer: { state: 'signed-out', csrfToken: null },
                    read: wrapped,
                  }),
                ],
              }),
            ),
          ),
        ),
      );
      expect(calls.at(-1)?.selection?.characters).toMatchObject({ cursor: 'native-next' });
      expect(document.activeElement?.closest('[data-work-statement]')?.getAttribute('data-work-statement')).toBe(
        appearance,
      );
    }
    const { fixture, character, read } = prepare('en');
    const page = pageFor(character);
    setLocale('en', { reload: false });
    browser.location.href = `https://site.test/en/subjects/${character}/character`;
    calls.length = 0;
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: member, csrfToken: 'member' });
    });
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            OverviewContext.Provider,
            { value: fixture.value },
            createElement(CharacterAssociationBridge, {
              source: page,
              children: [
                createElement(CharacterOverview, {
                  key: 'profile',
                  source: page,
                  viewer: member,
                  locale: 'en',
                  public: fixture.profile.read,
                  release: fixture.profile.release,
                  link: fixture.value.link,
                }),
                createElement(SubjectConnections, {
                  key: 'connections',
                  page,
                  viewer: { state: 'signed-in', subject: member, csrfToken: 'member' },
                  read: async (address, signal) => {
                    calls.push(address);
                    return read(address, signal);
                  },
                }),
              ],
            }),
          ),
        ),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.at(-1)?.viewer).toBe(member);
    expect(host.textContent).toContain('今井麻美');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    browser.happyDOM.abort();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
