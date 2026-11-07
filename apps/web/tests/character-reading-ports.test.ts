import { expect, test } from 'bun:test';
import {
  CHARACTER_WORK_PAGE_LIMIT,
  characterWorkStream,
  characterWorkRows,
  characterRelationRelated,
  type CharacterPage,
} from '../src/features/catalogue/character-reading-port';
import { creditVisit } from '../src/features/catalogue/credit-inspection/model';
import { creditDestinationHref } from '../src/features/catalogue/credit-inspection/destinations';
import { creditReturn, creditWindowHref } from '../src/features/catalogue/credit-inspection/navigation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('Character work streams keep appearance and P453-qualified voice credits distinct', () => {
  expect(
    characterWorkStream(
      {
        key: 'in:schema:character',
        property: 'schema:character',
        direction: 'in',
        group: 'characters',
        label: 'Appearances',
        forwardLabel: 'Character',
        language: 'en',
      },
      id(1),
    ),
  ).toBe('appearance');
  expect(
    characterWorkStream(
      {
        key: 'in:wdt:P725:qualified',
        property: 'wdt:P725',
        direction: 'in',
        group: 'credits',
        label: 'Voice',
        forwardLabel: 'Voice actor',
        language: 'en',
        filter: id(1),
        qualifier: 'wdt:P453',
      },
      id(1),
    ),
  ).toBe('performance');
  expect(
    characterWorkStream(
      {
        key: 'out:schema:character',
        property: 'schema:character',
        direction: 'out',
        group: 'characters',
        label: 'Characters',
        forwardLabel: 'Character',
        language: 'en',
      },
      id(1),
    ),
  ).toBeUndefined();
  expect(CHARACTER_WORK_PAGE_LIMIT).toBe(12);
});

test('an appearance naming a merged original keeps its statement only through the related redirect', () => {
  const section = {
    stream: {
      key: 'in:schema:character',
      property: 'schema:character',
      direction: 'in' as const,
      group: 'characters' as const,
      label: 'Appearances',
      forwardLabel: 'Character',
      language: 'en',
    },
    section: {
      ok: true as const,
      read: { kind: 'links' as const, id: id(1), property: 'schema:character', limit: 12 },
      body: {
        links: [
          {
            subject: id(2),
            statement: id(10),
            property: 'schema:character',
            summary: { id: id(2), type: 'schema:Book', label: { value: 'Work', language: 'en' } },
            assertion: {
              id: id(10),
              property: { id: 'schema:character', data_type: 'wikibase-item' },
              value: { type: 'value', content: id(5) },
              rank: 'normal',
              qualifiers: [],
              references: [],
            },
            related: { [id(5)]: { id: id(5), label: { value: 'Original', language: 'en' }, redirect: id(1) } },
          },
        ],
      },
    },
  };
  expect(characterWorkRows(section, id(1), 'en', 0)[0]?.original).toMatchObject({ id: id(10) });
  const related = section.section.body.links[0]!.related[id(5)]!;
  delete (related as { redirect?: string }).redirect;
  expect(characterWorkRows(section, id(1), 'en', 0)[0]?.original).toBeUndefined();
  expect(characterRelationRelated(section.section.body.links[0]!.related)[id(5)]?.labels.en).toBe('Original');
});

test('credit inspection destinations carry the installed visit-return without a page import', () => {
  const visit = {
    person: id(1),
    node: 'voice',
    stream: { kind: 'links' as const, id: id(1), property: 'wdt:P725', limit: 12 },
    context: id(8),
    reader: null,
    release: `sha256:${'a'.repeat(64)}`,
    propertyLabel: 'Voice actor',
    definition: `sha256:${'a'.repeat(64)}`,
  };
  const credit = {
    holder: id(2),
    statement: {
      id: id(10),
      property: { id: 'wdt:P725', data_type: 'wikibase-item' },
      value: { type: 'value', content: id(1) },
      rank: 'normal',
      qualifiers: [],
      references: [],
      rezics: { release: visit.release, revision: 1 },
    },
    related: {},
  };
  const href = creditDestinationHref(
    `/en/subjects/${id(2)}/overview`,
    visit,
    credit,
    'en',
    (path, returned) => `${path}#via=${returned}`,
  );
  expect(href).toContain(`/en/subjects/${id(2)}/overview`);
  expect(href).toContain('#via=');
  const page = {
    subject: null,
    locale: 'en',
    link: () => null,
    reader: { spoilerLevel: 0, suitability: 'blur' },
    labels: {},
    unlabelled: '',
    spoilerShow: '',
    relations: {},
  } as unknown as CharacterPage;
  expect(creditVisit(page, 'voice', { ok: true, read: visit.stream, body: {} }, 'credits')).toBeUndefined();
  const window = creditWindowHref(visit, 'en', credit);
  expect(creditReturn(new URL(window, 'https://rezics.invalid').hash)?.holder).toBe(id(2));
});
