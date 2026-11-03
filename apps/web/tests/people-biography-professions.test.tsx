import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';
import { peopleCandidateId, peoplePersonId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import {
  peopleBiographyGroups,
  peopleBiographyHref,
  peopleScalarFields,
  peopleSelectedFact,
} from '../src/features/catalogue/people-biography';
import { sealFacts, sendFacts, type FactDraft } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

function itemProperty(id: string, label: string): PropertyDefinition {
  return {
    iri: `http://schema.org/${id.split(':')[1]}`,
    value: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    labels: { en: label, ja: label },
    descriptions: { en: label },
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
    mappings: [],
    qualifiers: [],
    multivalued: true,
    relation: { group: 'classification', order: 'name', inverse: 'none' },
  };
}

function admitPeopleBiography(release: Release) {
  release.properties['wdt:P106'] = itemProperty('wdt:P106', 'occupation');
  release.properties['schema:knowsLanguage'] = itemProperty('schema:knowsLanguage', 'knows language');
  const person = release.types['schema:Person']!;
  for (const id of ['schema:abstract', 'wdt:P106', 'schema:knowsLanguage'])
    if (!person.properties.includes(id)) person.properties.push(id);
}

function statement(
  id: string,
  property: string,
  content: unknown,
  datatype: SubjectRead['subject']['statements'][string][number]['property']['data_type'],
) {
  return {
    id,
    rank: 'normal' as const,
    property: { id: property, data_type: datatype },
    value: { type: 'value' as const, content },
    qualifiers: [],
    references: [
      {
        hash: 'bio-source',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' as const },
            value: { type: 'value' as const, content: 'https://example.org/bio' },
          },
        ],
      },
    ],
    rezics: { release: 'sha256:fixture', revision: 1 },
  };
}

test('Person biography groups bind admitted multilingual documents, occupations and languages and keep unreleased fields named unsupported', async () => {
  const fixture = peopleProfileFixture('ready', 'en', 'person');
  const closed = peopleBiographyGroups(fixture.release, 'schema:Person', 'en', fixture.person);
  expect(closed.map((group) => group.kind)).toEqual(['biography', 'occupations', 'languages', 'affiliations']);
  expect(
    closed
      .filter((group) => group.kind !== 'affiliations')
      .flatMap((group) => group.fields)
      .every((field) => field.status === 'unsupported'),
  ).toBe(true);
  expect(peopleScalarFields(fixture.release, 'schema:Person', 'en')).toContain('schema:url');
  expect(peopleBiographyHref(peoplePersonId, 'Mira Sato', 'en', 'schema:abstract')).toContain(
    '/authored?property=schema%3Aabstract',
  );

  admitPeopleBiography(fixture.release);
  const occupation = '00000000-0000-4000-8000-00000000d201';
  const writer = '00000000-0000-4000-8000-00000000d202';
  const japanese = '00000000-0000-4000-8000-00000000d203';
  const english = '00000000-0000-4000-8000-00000000d204';
  fixture.person.subject.statements['schema:abstract'] = [
    statement(
      '00000000-0000-4000-8000-00000000d211',
      'schema:abstract',
      { language: 'en', document: { id: 'en-bio' } },
      'document',
    ),
    statement(
      '00000000-0000-4000-8000-00000000d212',
      'schema:abstract',
      { language: 'ja', document: { id: 'ja-bio' } },
      'document',
    ),
  ];
  fixture.person.subject.statements['wdt:P106'] = [
    statement('00000000-0000-4000-8000-00000000d221', 'wdt:P106', occupation, 'wikibase-item'),
    statement('00000000-0000-4000-8000-00000000d222', 'wdt:P106', writer, 'wikibase-item'),
  ];
  fixture.person.subject.statements['schema:knowsLanguage'] = [
    statement('00000000-0000-4000-8000-00000000d231', 'schema:knowsLanguage', japanese, 'wikibase-item'),
    statement('00000000-0000-4000-8000-00000000d232', 'schema:knowsLanguage', english, 'wikibase-item'),
  ];
  fixture.person.related = {
    [occupation]: { type: 'skos:Concept', labels: { en: 'Director', ja: '監督' } },
    [writer]: { type: 'skos:Concept', labels: { en: 'Writer', ja: '脚本家' } },
    [japanese]: { type: 'skos:Concept', labels: { ja: '日本語', en: 'Japanese' } },
    [english]: { type: 'skos:Concept', labels: { en: 'English' } },
  };
  const groups = peopleBiographyGroups(fixture.release, 'schema:Person', 'ja', fixture.person);
  const biography = groups.find((group) => group.kind === 'biography')!;
  const occupations = groups.find((group) => group.kind === 'occupations')!;
  const languages = groups.find((group) => group.kind === 'languages')!;
  expect(biography.fields[0]).toMatchObject({ id: 'schema:abstract', status: 'current', editor: 'authored' });
  expect(biography.fields[0]!.facts.map((fact) => fact.statement.value)).toEqual([
    { type: 'value', content: { language: 'en', document: { id: 'en-bio' } } },
    { type: 'value', content: { language: 'ja', document: { id: 'ja-bio' } } },
  ]);
  expect(occupations.fields.find((field) => field.id === 'wdt:P106')?.facts.map((fact) => fact.target?.label)).toEqual([
    '監督',
    '脚本家',
  ]);
  expect(languages.fields[0]?.facts.map((fact) => fact.target?.id)).toEqual([japanese, english]);
  expect(occupations.fields.find((field) => field.id === 'schema:hasOccupation')?.status).toBe('unsupported');
  const hidden = structuredClone(fixture.person);
  delete hidden.related[occupation];
  expect(peopleBiographyGroups(fixture.release, 'schema:Person', 'en', hidden)[1]!.fields[0]!.status).toBe(
    'unreadable',
  );
  expect(peopleSelectedFact('00000000-0000-4000-8000-00000000d221', occupations.fields[0]!.facts)?.id).toBe(
    '00000000-0000-4000-8000-00000000d221',
  );
  expect(peopleSelectedFact('missing', occupations.fields[0]!.facts)).toBeUndefined();
  expect(peopleScalarFields(fixture.release, 'schema:Person', 'en')).not.toContain('schema:abstract');
  expect(peopleScalarFields(fixture.release, 'schema:Person', 'en')).not.toContain('wdt:P106');

  const draft: FactDraft = {
    property: 'wdt:P106',
    source: '00000000-0000-4000-8000-00000000d221',
    included: true,
    baseline: {
      property: { id: 'wdt:P106' },
      value: { type: 'value', content: occupation },
      qualifiers: [],
      references: [],
      rank: 'normal',
    },
    statement: {
      property: { id: 'wdt:P106' },
      value: { type: 'value', content: writer },
      qualifiers: [],
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credits' } }],
        },
      ],
      rank: 'normal',
    },
  };
  let sealed = sealFacts(fixture.id, fixture.release, [draft]);
  await sendFacts(sealed, fixture.propose, (_property, outcome) => {
    sealed = sealed.map((entry) => ({ ...entry, result: outcome }));
  });
  expect(sealed[0]?.result).toMatchObject({ ok: true, kind: 'proposed-awaiting-review', candidate: peopleCandidateId });
  const review = await fixture.review('wdt:P106').read('wdt:P106');
  expect(review.ok && review.page?.candidates[0]?.id).toBe(peopleCandidateId);
  expect(fixture.person.subject.statements['wdt:P106']![0]!.value.content).toBe(occupation);
});

test('labelled People groups show admitted occupations, unreleased fields and return to the original profile', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/person/mira' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { PeopleBiographyGroups } = await import('../src/features/catalogue/people-biography/groups');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const fixture = peopleProfileFixture('ready', 'en', 'person');
  admitPeopleBiography(fixture.release);
  const occupation = '00000000-0000-4000-8000-00000000d201';
  fixture.person.subject.statements['wdt:P106'] = [
    statement('00000000-0000-4000-8000-00000000d221', 'wdt:P106', occupation, 'wikibase-item'),
  ];
  fixture.person.related = { [occupation]: { type: 'skos:Concept', labels: { en: 'Director' } } };
  try {
    await act(async () =>
      root.render(
        h(
          CandidateReaderBoundary,
          {
            observed: { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'token' },
            address: 'people-biography',
          },
          h(
            CatalogueCurrentReading,
            { visible: true, ready: true, revision: '1' },
            h(PeopleBiographyGroups, {
              read: { ok: true, public: fixture.person, release: fixture.release, source: null },
              locale: 'en',
              search: async () => [],
              transport: {
                propose: fixture.propose,
                read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
              },
              review: fixture.review,
            }) as ReactNode,
          ) as ReactNode,
        ),
      ),
    );
    expect(host.textContent).toContain(m.people_biography_title());
    expect(host.textContent).toContain(m.people_occupations_title());
    expect(host.textContent).toContain(m.people_languages_title());
    expect(host.textContent).toContain(m.people_biography_unsupported());
    expect(host.textContent).toContain('Director');
    const authored = [...host.querySelectorAll('a')].find((link) => link.getAttribute('href')?.includes('/authored'));
    expect(authored?.getAttribute('href')).toContain('property=schema%3Aabstract');
    expect(authored?.getAttribute('href')).toContain('return=');
    expect([...host.querySelectorAll('a')].some((link) => link.textContent === m.people_biography_return())).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
