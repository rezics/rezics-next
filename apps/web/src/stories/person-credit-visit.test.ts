import { expect, mock, test } from 'bun:test';
import type { OverviewValue } from '../features/pages/overview';
import type { ConnectionSection, ConnectionStream } from '../features/pages/subject-connections';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { connectionCreditVisit } = await import('../features/pages/subject-connections');
const { creditAssertion } = await import('../features/catalogue/credit-inspection/model');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = id(1);
const release = `sha256:${'a'.repeat(64)}`;

function credit(property: string, statementId: string, title: string): ConnectionSection {
  const stream: ConnectionStream = {
    key: `in:${property}`,
    property,
    direction: 'in',
    group: 'credits',
    label: property,
    forwardLabel: property,
    language: 'en',
  };
  return {
    stream,
    section: {
      ok: true,
      read: { kind: 'links', id: person, property, limit: 12, cursor: `cursor:${title}` },
      body: {
        links: [
          {
            subject: id(title === 'VN' ? 2 : 3),
            property,
            statement: statementId,
            assertion: {
              id: statementId,
              property: { id: property, data_type: 'wikibase-item' },
              value: { type: 'value', content: person },
              qualifiers: [
                { property: { id: 'wdt:P1932', data_type: 'string' }, value: { type: 'value', content: title } },
                {
                  property: { id: 'wdt:P3831', data_type: 'wikibase-item' },
                  value: { type: 'value', content: id(30) },
                },
              ],
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url', data_type: 'url' },
                      value: { type: 'value', content: `https://source.test/${title}` },
                    },
                  ],
                },
              ],
              rezics: { release, revision: 1 },
            },
            related: {
              [id(30)]: { id: id(30), type: 'skos:Concept', label: { value: 'Credit role', language: 'en' } },
            },
          },
        ],
      },
    },
  };
}

test('Person credit visits retain each admitted VN and anime window and its exact cited statement', () => {
  const vn = credit('schema:author', id(10), 'VN');
  const anime = credit('wdt:P725', id(11), 'Anime');
  const value = {
    subject: person,
    context: { id: id(20), population: { kind: 'global' } },
    releaseDigest: release,
    unlabelled: 'Unlabelled',
    relations: { 'schema:author': { forwardLabel: 'Author' }, 'wdt:P725': { forwardLabel: 'Voice performer' } },
    relationDirections: ['schema:author', 'wdt:P725'].map((property) => ({
      state: 'admitted',
      property,
      direction: 'inverse',
      release,
    })),
    relationNodes: [
      { id: 'author', props: { property: 'schema:author' } },
      { id: 'voice', props: { property: 'wdt:P725' } },
    ],
    candidatePropertyLabel: (property: string) =>
      ({ 'wdt:P1932': 'Credited name', 'wdt:P3831': 'Credit role' })[property],
  } as unknown as OverviewValue;

  expect([connectionCreditVisit(value, vn), connectionCreditVisit(value, anime)]).toMatchObject([
    {
      person,
      node: 'author',
      stream: { kind: 'links', id: person, property: 'schema:author', limit: 12, cursor: 'cursor:VN' },
      propertyLabel: 'Author',
      labels: { 'wdt:P1932': 'Credited name', 'wdt:P3831': 'Credit role' },
    },
    {
      person,
      node: 'voice',
      stream: { kind: 'links', id: person, property: 'wdt:P725', limit: 12, cursor: 'cursor:Anime' },
      propertyLabel: 'Voice performer',
      labels: { 'wdt:P1932': 'Credited name', 'wdt:P3831': 'Credit role' },
    },
  ]);
  for (const [section, title] of [
    [vn, 'VN'],
    [anime, 'Anime'],
  ] as const) {
    const row = section.section.ok && Array.isArray(section.section.body.links) ? section.section.body.links[0] : {};
    const statement = creditAssertion(row as Record<string, unknown>)!.statement;
    expect(statement.qualifiers.map((part) => part.property.id)).toEqual(['wdt:P1932', 'wdt:P3831']);
    expect(statement.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: `https://source.test/${title}`,
    });
  }
  expect(
    connectionCreditVisit(value, { ...vn, stream: { ...vn.stream, property: 'schema:contributor' } }),
  ).toBeUndefined();
});

test('Character credit visits use the live inverse window when RelationGroups nodes are absent', () => {
  const vn = credit('schema:author', id(10), 'VN');
  const value = {
    subject: person,
    context: { id: id(20), population: { kind: 'global' } },
    releaseDigest: release,
    unlabelled: 'Unlabelled',
    relations: { 'schema:author': { forwardLabel: 'Author' } },
    relationDirections: [{ state: 'admitted', property: 'schema:author', direction: 'inverse', release }],
    relationNodes: [],
    candidatePropertyLabel: (property: string) =>
      ({ 'wdt:P1932': 'Credited name', 'wdt:P3831': 'Credit role' })[property],
  } as unknown as OverviewValue;
  expect(connectionCreditVisit(value, vn)).toMatchObject({
    person,
    node: 'in:schema:author',
    stream: { kind: 'links', id: person, property: 'schema:author', limit: 12, cursor: 'cursor:VN' },
    propertyLabel: 'Author',
  });
  expect(
    connectionCreditVisit(
      { ...value, relationNodes: [{ id: 'other', props: { property: 'wdt:P725' } }] } as unknown as OverviewValue,
      vn,
    ),
  ).toBeUndefined();
});

test('Person and Character visits keep the active subpage, search and hash on a canonical redirect', async () => {
  const { canonicalRedirect, keepSearch } = await import('../subject/subject-href');
  const search = '?context=00000000-0000-4000-8000-000000000020&cursor=native-next';
  const hash = '#connections';
  expect(keepSearch('/en/subjects/survivor/slug/people', search, hash)).toBe(
    `/en/subjects/survivor/slug/people${search}${hash}`,
  );
  expect(canonicalRedirect('/en/subjects/survivor/slug/character-relationships', search, hash)).toEqual({
    href: `/en/subjects/survivor/slug/character-relationships${search}${hash}`,
    statusCode: 301,
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
