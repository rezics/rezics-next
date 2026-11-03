import { createKernelClient, type SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { valueSchema, type PropertyDefinition, type Release } from '@rezics/definitions';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { candidateContext, type Candidate } from '../../subject/candidates';
import { relationDescriptorReader } from './relation-descriptor';
import {
  confirmRelation,
  proposeRelation,
  readRelationEditor,
  type RelationStatementInput,
} from '../../subject/relation-candidates';
import { characterType } from '../../features/catalogue/character-profile';
import {
  appearanceProperty,
  readCharacterRelationships,
} from '../../features/catalogue/character-relationships/reading';
import type { CharacterRelationshipsTransport } from '../../features/catalogue/character-relationships/view';
import { readTypeDescriptor } from '../../features/catalogue/type-directory-client';
import recording from '../recorded/subject.json';
import type { FakeRoute } from '../fake-modules';

export type CharacterRelationshipsScenario =
  | 'appearances'
  | 'relationship'
  | 'age'
  | 'spoiler'
  | 'vanished'
  | 'unreleased'
  | 'unreadable'
  | 'denied'
  | 'unavailable';

export const characterRelationshipsId = '00000000-0000-4000-8000-000000000c01';
export const appearanceWorkA = '00000000-0000-4000-8000-000000000c02';
export const appearanceWorkB = '00000000-0000-4000-8000-000000000c03';
export const relatedCharacterId = '00000000-0000-4000-8000-000000000c04';
export const voicePersonId = '00000000-0000-4000-8000-000000000c05';
const candidateId = '00000000-0000-4000-8000-000000000c06';
const statementA = '00000000-0000-4000-8000-000000000c11';
const statementB = '00000000-0000-4000-8000-000000000c12';
const statementRel = '00000000-0000-4000-8000-000000000c13';
const relationshipProperty = 'ex:knows';
const ageProperty = 'ex:ageAtAppearance';

function withTestVocabulary(base: Release, extras: boolean): Release {
  const release = structuredClone(base);
  if (!extras) return release;
  const age: PropertyDefinition = {
    iri: 'https://example.test/ageAtAppearance',
    labels: { en: 'Age at appearance' },
    mappings: [],
    datatype: 'quantity',
    multivalued: false,
    units: ['1'],
    minimum: 0,
    qualifiers: [],
    value: valueSchema('quantity', { units: ['1'], integer: true }),
  };
  const knows: PropertyDefinition = {
    iri: 'https://example.test/knows',
    labels: { en: 'Knows' },
    mappings: [],
    datatype: 'wikibase-item',
    multivalued: true,
    targets: [characterType],
    qualifiers: ['rezics:spoilerLevel'],
    relation: {
      group: 'association',
      inverse: relationshipProperty,
      inverseLabels: { en: 'Known by' },
    },
    value: valueSchema('wikibase-item'),
  };
  release.properties[ageProperty] = age;
  release.properties[relationshipProperty] = knows;
  release.properties[appearanceProperty] = {
    ...release.properties[appearanceProperty]!,
    qualifiers: [...release.properties[appearanceProperty]!.qualifiers, ageProperty],
  };
  release.types[characterType] = {
    ...release.types[characterType]!,
    properties: [...release.types[characterType]!.properties, relationshipProperty],
  };
  return release;
}

export function characterRelationshipsFixture(
  initialScenario: CharacterRelationshipsScenario = 'appearances',
  locale = 'en',
) {
  let scenario = initialScenario;
  const extras = scenario === 'relationship' || scenario === 'age';
  const release = withTestVocabulary(bundledRelease, extras);
  const digest = recording.subject.release;
  const snak = (id: string, value: unknown, datatype: Candidate['statement']['property']['data_type']) => ({
    property: { id, data_type: datatype },
    value: { type: 'value' as const, content: value },
  });
  const appearance = (
    id: string,
    work: string,
    title: string,
    qualifiers: Candidate['statement']['qualifiers'],
  ): Candidate['statement'] => ({
    ...snak(appearanceProperty, characterRelationshipsId, 'wikibase-item'),
    id,
    rank: 'normal',
    qualifiers,
    references: [{ hash: 'appearance', parts: [snak('schema:url', `https://example.org/${work}`, 'url')] }],
    rezics: { release: digest, revision: 1 },
  });
  const role = (concept: string) => snak('wdt:P3831', concept, 'wikibase-item');
  const spoiler = (amount: string) => snak('rezics:spoilerLevel', { amount, unit: '1' }, 'quantity');
  const age = (amount: string) => snak(ageProperty, { amount, unit: '1' }, 'quantity');
  const first = appearance(statementA, appearanceWorkA, 'Spring work', [
    role('wd:Q95074'),
    ...(scenario === 'age' ? [age('+16')] : []),
    ...(scenario === 'spoiler' ? [spoiler('+2')] : []),
  ]);
  const second = appearance(statementB, appearanceWorkB, 'Autumn work', [
    role('wd:Q95074'),
    ...(scenario === 'age' ? [age('+18')] : []),
  ]);
  const relatedStatement: Candidate['statement'] = {
    ...snak(relationshipProperty, relatedCharacterId, 'wikibase-item'),
    id: statementRel,
    rank: 'normal',
    qualifiers: [],
    references: [{ hash: 'related', parts: [snak('schema:url', 'https://example.org/related', 'url')] }],
    rezics: { release: digest, revision: 1 },
  };
  const character: SubjectRead = structuredClone({
    ...recording,
    summary: null,
    related: {},
    subject: {
      ...recording.subject,
      id: characterRelationshipsId,
      type: characterType,
      context: candidateContext,
      labels: { en: 'The traveler' },
      statements: scenario === 'relationship' ? { [relationshipProperty]: [structuredClone(relatedStatement)] } : {},
      relationCounts: {},
      sourceRecords: [],
    },
  });
  const summary = (id: string, title: string, type: string) => ({
    id,
    type,
    types: [type],
    label: { value: title, language: 'en' },
    creativeWork: type !== characterType,
    cover: null,
  });
  const related = {
    [characterRelationshipsId]: summary(characterRelationshipsId, 'The traveler', characterType),
    wd: {
      id: 'wd:Q95074',
      type: 'skos:Concept',
      types: ['skos:Concept'],
      label: { value: 'Main', language: 'en' },
      creativeWork: false,
      cover: null,
    },
  };
  let candidate: Candidate | undefined;
  const calls: {
    path: string;
    method: string;
    query: Record<string, string>;
    body: unknown;
    authorization: string | null;
    session: string | null;
    key: string | null;
  }[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'character-assoc-session' },
    });
  const appearanceLinks = () => {
    if (scenario === 'vanished') {
      return [
        {
          subject: appearanceWorkA,
          property: appearanceProperty,
          statement: statementA,
          assertion: first,
          related,
          summary: null,
          type: 'schema:VideoGame',
          label: '',
        },
      ];
    }
    return [
      {
        subject: appearanceWorkA,
        property: appearanceProperty,
        statement: statementA,
        assertion: first,
        related: {
          ...related,
          [characterRelationshipsId]: related[characterRelationshipsId],
          'wd:Q95074': related.wd,
        },
        summary: summary(appearanceWorkA, 'Spring work', 'schema:VideoGame'),
        type: 'schema:VideoGame',
        label: 'Spring work',
      },
      {
        subject: appearanceWorkB,
        property: appearanceProperty,
        statement: statementB,
        assertion: second,
        related: {
          ...related,
          'wd:Q95074': related.wd,
        },
        summary: summary(appearanceWorkB, 'Autumn work', 'schema:VideoGame'),
        type: 'schema:VideoGame',
        label: 'Autumn work',
      },
    ];
  };
  const client = createKernelClient('https://character-assoc.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : undefined;
      const key = request.headers.get('idempotency-key');
      calls.push({
        path: url.pathname,
        method: request.method,
        body,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
        key,
      });
      if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (url.pathname.startsWith('/v1/definition-types/')) {
        const typeId = decodeURIComponent(url.pathname.replace('/v1/definition-types/', ''));
        const definition = release.types[typeId];
        if (!definition) return json({ code: 'not_found' }, 404);
        return json({
          typeId,
          releaseDigest: digest,
          label: definition.labels.en ?? typeId,
          language: 'en',
          description: null,
          descriptionLanguage: null,
          definition,
          properties: Object.fromEntries(
            [
              ...definition.properties,
              ...definition.properties.flatMap((id) => release.properties[id]?.qualifiers ?? []),
            ]
              .filter((id) => release.properties[id])
              .map((id) => [id, release.properties[id]]),
          ),
        });
      }
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${characterRelationshipsId}`)
        return json(character);
      if (url.pathname.endsWith('/links')) {
        if (scenario === 'unreadable' && url.searchParams.get('property') === appearanceProperty)
          return json({ code: 'semantic_not_ready' }, 503);
        if (url.searchParams.get('property') !== appearanceProperty) {
          return json({
            links: [],
            next: null,
            freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
          });
        }
        return json({
          links: appearanceLinks(),
          next: null,
          count: { value: appearanceLinks().length, exact: true },
          freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
        });
      }
      if (url.pathname.endsWith('/relations')) {
        if (url.searchParams.get('property') !== relationshipProperty) {
          return json({
            relations: [],
            next: null,
            freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
          });
        }
        return json({
          relations: [
            {
              statement: relatedStatement,
              summary: summary(relatedCharacterId, 'The companion', characterType),
              related: {
                [relatedCharacterId]: summary(relatedCharacterId, 'The companion', characterType),
              },
            },
          ],
          next: null,
          count: { value: 1, exact: true },
          freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
        });
      }
      if (url.pathname.endsWith('/candidates') && request.method === 'GET')
        return json({
          candidates: candidate ? [candidate] : [],
          adoption: { mode: 'replace', head: 3 },
          next: null,
        });
      if (request.method !== 'POST' || !body) return json({ code: 'not_found' }, 404);
      if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
      if (url.pathname.endsWith('/candidates')) {
        const statement = body.statement as RelationStatementInput;
        const readSnak = (part: RelationStatementInput['qualifiers'][number]) => ({
          ...part,
          property: { ...part.property, data_type: release.properties[part.property.id]?.datatype ?? 'string' },
        });
        candidate = {
          id: candidateId,
          source: null,
          retracted: null,
          retraction: null,
          release: digest,
          revision: 2,
          head: null,
          decision: null,
          rank: null,
          statement: {
            ...readSnak(statement),
            id: candidateId,
            qualifiers: statement.qualifiers.map(readSnak),
            references: statement.references.map(({ parts }) => ({
              hash: 'native-reference',
              parts: parts.map(readSnak),
            })),
            rank: 'normal',
            rezics: { release: digest, revision: 2 },
          },
        };
        return json({ candidate: candidateId, revision: 2 }, 201);
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const transport: CharacterRelationshipsTransport = {
    read: (stream, cursor, session) =>
      readCharacterRelationships(
        client,
        'Bearer contributor',
        release,
        characterRelationshipsId,
        locale,
        stream,
        cursor,
        session,
        (typeId) => readTypeDescriptor(client, typeId, locale),
      ),
    relation: (holder) => ({
      read: (slot, cursor, session) =>
        readRelationEditor(
          client,
          'Bearer contributor',
          relationDescriptorReader(release),
          holder,
          locale,
          slot,
          cursor,
          session,
        ),
      propose: (input) => proposeRelation(client, 'Bearer contributor', relationDescriptorReader(release), input),
      confirm: (input) => confirmRelation(client, 'Bearer contributor', input),
    }),
  };
  const search: EntityPickerSearch = async () => [
    { id: relatedCharacterId, title: 'The companion', types: [characterType], typeLabel: 'Character', cover: null },
  ];
  return {
    id: characterRelationshipsId,
    release,
    character,
    first,
    second,
    relatedStatement,
    relationshipProperty,
    ageProperty,
    client,
    calls,
    transport,
    search,
    read: () =>
      readCharacterRelationships(
        client,
        'Bearer contributor',
        release,
        characterRelationshipsId,
        locale,
        undefined,
        undefined,
        undefined,
        (typeId) => readTypeDescriptor(client, typeId, locale),
      ),
  };
}

export const routes: FakeRoute[] = [];
