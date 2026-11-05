import './support/ensure-document.ts';
import { expect, mock, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
    expect(/<input[^>]*type="search"[^>]*>/.exec(html)?.[0] ?? '').toContain('min-h-11');
    expect(
      personGroups(fixture.release, fixture.read, locale)[1]!.fields
        .filter((field) => !field.admitted)
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
