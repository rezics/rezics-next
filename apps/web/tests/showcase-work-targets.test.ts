import { expect, mock, test } from 'bun:test';
import type { RelationDefinition } from '../src/subject/relations';
import type { Related, Subject } from '../src/subject/types';

// The projection needs no Workers bindings; match the existing Bun component-control environment.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { directedWorkRelations, showcaseWorkKind, uncoveredWorkDestinations, workDestinations, workTargetKind } =
  await import('../src/features/pages/showcase-work/model');

// Authored native-response controls. These UUIDs do not identify seeded catalogue objects.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const anime = id(233);
const series = id(2815);
const volume = id(10862);
const episode = id(10);
const voice = id(11);
const publisher = id(12);

function assertion(property: string, target: string, n: number) {
  return {
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: [],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://bgm.tv/subject/233' },
          },
        ],
      },
    ],
  };
}

function summary(target: string, type: string, label: { language: string; value: string }) {
  return { id: target, type, label };
}

const familyDefinitions: Record<string, RelationDefinition> = {
  'wdt:P179': { label: 'part of series', forwardLabel: 'series', group: 'membership', symmetric: false },
  'schema:publisher': { label: 'publisher', forwardLabel: 'publisher', group: 'association', symmetric: false },
  'rezics:crossMediaCounterpart': {
    label: 'counterpart',
    forwardLabel: 'counterpart',
    group: 'association',
    symmetric: true,
  },
  'wdt:P725': { label: 'voice', forwardLabel: 'voice', group: 'association', symmetric: false },
  'schema:director': { label: 'director', forwardLabel: 'director', group: 'association', symmetric: false },
  'schema:isPartOf': { label: 'has part', forwardLabel: 'part of', group: 'membership', symmetric: false },
};

test('released staff, cast, episode and publisher targets keep their kinds, exact und names and citations', () => {
  const actor = assertion('schema:actor', voice, 20);
  const credited = directedWorkRelations(anime, 'schema:actor', 'out', {
    relations: [
      {
        target: voice,
        statement: actor,
        summary: summary(voice, 'schema:Person', { language: 'und', value: 'Voice Name' }),
      },
    ],
  })!;
  expect(credited.map(({ kind, id: target, holder, direction }) => ({ kind, id: target, holder, direction }))).toEqual([
    { kind: 'person', id: voice, holder: anime, direction: 'out' },
  ]);
  expect(credited[0]!.related[voice]!.labels).toEqual({ und: 'Voice Name' });
  expect(credited[0]!.statement.references).toHaveLength(1);

  const membership = assertion('schema:isPartOf', anime, 21);
  const members = directedWorkRelations(anime, 'schema:isPartOf', 'in', {
    links: [
      {
        subject: episode,
        statement: membership.id,
        assertion: membership,
        summary: summary(episode, 'schema:Episode', { language: 'ja', value: '第一話' }),
      },
    ],
  })!;
  expect(members.map(({ kind, id: target }) => ({ kind, id: target }))).toEqual([{ kind: 'episode', id: episode }]);

  const publishers = directedWorkRelations(series, 'schema:publisher', 'out', {
    relations: [
      {
        target: publisher,
        statement: assertion('schema:publisher', publisher, 22),
        summary: summary(publisher, 'schema:Organization', { language: 'und', value: '講談社' }),
      },
    ],
  })!;
  expect(publishers.map(({ kind, id: target }) => ({ kind, id: target }))).toEqual([
    { kind: 'organization', id: publisher },
  ]);
  expect(publishers[0]!.related[publisher]!.labels).toEqual({ und: '講談社' });
});

test('people, organizations and episodes never make a Subject a Work', () => {
  expect(showcaseWorkKind('schema:Person')).toBeUndefined();
  expect(showcaseWorkKind('schema:Organization')).toBeUndefined();
  expect(showcaseWorkKind('schema:Episode')).toBeUndefined();
  expect(workTargetKind('schema:Person')).toBe('person');
  expect(workTargetKind('schema:Organization')).toBe('organization');
  expect(workTargetKind('schema:Episode')).toBe('episode');
  expect(workTargetKind('schema:Movie')).toBe('screen');
  expect(workTargetKind('schema:Concept')).toBeUndefined();
});

test('the Work overview lists its own relations before credit targets, which never displace them', () => {
  const work = id(30);
  const person = id(31);
  const definitions: Record<string, RelationDefinition> = {
    'schema:actor': { label: 'performer', forwardLabel: 'voice', group: 'association', symmetric: false },
    'rezics:crossMediaCounterpart': {
      label: 'counterpart',
      forwardLabel: 'counterpart',
      group: 'association',
      symmetric: true,
    },
  };
  const subject = {
    id: anime,
    statements: {
      'schema:actor': [assertion('schema:actor', person, 40)],
      'rezics:crossMediaCounterpart': [assertion('rezics:crossMediaCounterpart', work, 41)],
    },
  } as unknown as Subject;
  const related = {
    [person]: { id: person, type: 'schema:Person', labels: { und: 'Voice Name' } },
    [work]: { id: work, type: 'schema:TVSeries', labels: { en: 'Work' } },
  } as unknown as Related;
  expect(workDestinations(subject, related, definitions).map(({ kind }) => kind)).toEqual(['screen', 'person']);
});

test('family volume, publisher, counterpart, voice and staff statements stay besides already-windowed members', () => {
  const subject = {
    id: series,
    statements: {
      'wdt:P179': [assertion('wdt:P179', volume, 60)],
      'schema:publisher': [assertion('schema:publisher', publisher, 61)],
      'rezics:crossMediaCounterpart': [assertion('rezics:crossMediaCounterpart', anime, 62)],
      'wdt:P725': [assertion('wdt:P725', voice, 63)],
      'schema:director': [assertion('schema:director', voice, 64)],
    },
  } as unknown as Subject;
  const related = {
    [volume]: { id: volume, type: 'schema:Book', labels: { und: '空の境界' } },
    [publisher]: { id: publisher, type: 'schema:Organization', labels: { und: '講談社' } },
    [anime]: { id: anime, type: 'schema:TVSeries', labels: { und: '空の境界' } },
    [voice]: { id: voice, type: 'schema:Person', labels: { und: 'あおきえい' } },
  } as unknown as Related;
  const destinations = workDestinations(subject, related, familyDefinitions);
  expect(destinations.map(({ property, kind }) => ({ property, kind }))).toEqual([
    { property: 'wdt:P179', kind: 'book' },
    { property: 'rezics:crossMediaCounterpart', kind: 'screen' },
    { property: 'schema:publisher', kind: 'organization' },
    { property: 'wdt:P725', kind: 'person' },
    { property: 'schema:director', kind: 'person' },
  ]);
  const windowed = directedWorkRelations(series, 'wdt:P179', 'in', {
    links: [
      {
        subject: volume,
        statement: id(60),
        assertion: assertion('wdt:P179', series, 60),
        summary: summary(volume, 'schema:Book', { language: 'und', value: '空の境界' }),
      },
    ],
  })!;
  expect(uncoveredWorkDestinations(subject, related, familyDefinitions, windowed).map(({ property }) => property)).toEqual(
    ['rezics:crossMediaCounterpart', 'schema:publisher', 'wdt:P725', 'schema:director'],
  );
});
