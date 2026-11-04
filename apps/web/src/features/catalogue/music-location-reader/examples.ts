import { createKernelClient, type KernelClient, type SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  readMusicLocation,
  musicLocationSnapshot,
  type MusicLocationAddress,
} from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type Forward = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type Inverse = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Statement = SubjectRead['subject']['statements'][string][number];

export const musicPlaceId = '00000000-0000-4000-8000-00000000d101';
export const musicEventId = '00000000-0000-4000-8000-00000000d102';
export const musicAreaId = '00000000-0000-4000-8000-00000000d103';
export const musicInstrumentId = '00000000-0000-4000-8000-00000000d104';
export const musicPersonId = '00000000-0000-4000-8000-00000000d105';
const context = '00000000-0000-4000-8000-000000000001';
const releaseDigest = `sha256:${'a'.repeat(64)}`;

export type MusicLocationExample =
  | 'admitted-place'
  | 'admitted-event'
  | 'admitted-area'
  | 'admitted-instrument'
  | 'sparse'
  | 'hidden-target'
  | 'unsupported'
  | 'retired';

const freshness: Forward['freshness'] = { consistency: 'eventual', target_seconds: 10, caught_up: true };

function summary(id: string, type: string, label: string) {
  return {
    id,
    type,
    label: { value: label, language: 'en' },
    types: [type],
    creativeWork: false,
    cover: null,
  };
}

function statement(
  id: string,
  property: string,
  dataType: Statement['property']['data_type'],
  content: Statement['value'],
  qualifiers: Statement['qualifiers'] = [],
  references: Statement['references'] = [],
): Statement {
  return {
    id,
    property: { id: property, data_type: dataType },
    value: content,
    rank: 'normal',
    qualifiers,
    references,
    rezics: { release: releaseDigest, revision: 1 },
  };
}

function time(content: string, precision: number): Statement['value'] {
  return { type: 'value', content: { time: content, precision } };
}

function releaseForExamples() {
  const release = structuredClone(bundledRelease);
  const type = (id: string, label: string, properties: string[], bases = ['schema:Thing']) => {
    release.types[id] = {
      iri: `https://example.test/${id}`,
      labels: { en: label },
      mappings: [],
      bases,
      properties,
      facets: [],
      coverRatio: '5:7',
      listPresentation: { imageAspect: 'portrait', keyFacts: [] },
    };
  };
  type('schema:Place', 'Place', ['schema:containedInPlace']);
  type('schema:AdministrativeArea', 'Administrative area', [], ['schema:Place']);
  type('schema:Event', 'Event', ['schema:location', 'schema:performer', 'schema:instrument']);
  type('schema:MusicInstrument', 'Musical instrument', []);
  type('schema:Person', 'Person', []);
  release.properties['schema:startDate'] = {
    iri: 'https://schema.org/startDate',
    labels: { en: 'Start date' },
    descriptions: { en: 'Start date' },
    datatype: 'time',
    mappings: [],
    qualifiers: [],
    multivalued: false,
    value: { type: 'object' },
  };
  release.properties['schema:location'] = {
    iri: 'https://schema.org/location',
    labels: { en: 'Venue' },
    descriptions: { en: 'Venue' },
    datatype: 'wikibase-item',
    targets: ['schema:Place'],
    mappings: [],
    qualifiers: ['schema:startDate'],
    multivalued: true,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'world', inverse: 'venue', inverseLabels: { en: 'Venue for' } },
  };
  release.properties['schema:containedInPlace'] = {
    iri: 'https://schema.org/containedInPlace',
    labels: { en: 'In area' },
    descriptions: { en: 'In area' },
    datatype: 'wikibase-item',
    targets: ['schema:AdministrativeArea'],
    mappings: [],
    qualifiers: [],
    multivalued: false,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'world', inverse: 'venue', inverseLabels: { en: 'Contains place' } },
  };
  release.properties['schema:performer'] = {
    iri: 'https://schema.org/performer',
    labels: { en: 'Performer' },
    descriptions: { en: 'Performer' },
    datatype: 'wikibase-item',
    targets: ['schema:Person'],
    mappings: [],
    qualifiers: [],
    multivalued: true,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'credit', inverse: 'event', inverseLabels: { en: 'Performs at' } },
  };
  release.properties['schema:instrument'] = {
    iri: 'https://schema.org/instrument',
    labels: { en: 'Instrument' },
    descriptions: { en: 'Instrument' },
    datatype: 'wikibase-item',
    targets: ['schema:MusicInstrument'],
    mappings: [],
    qualifiers: [],
    multivalued: true,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'credit', inverse: 'event', inverseLabels: { en: 'Used at' } },
  };
  return release;
}

function publicSubject(kind: MusicLocationExample): SubjectRead {
  const id = kind === 'admitted-event' ? musicEventId : kind === 'admitted-area' ? musicAreaId : kind === 'admitted-instrument' ? musicInstrumentId : musicPlaceId;
  const type = kind === 'admitted-event' ? 'schema:Event' : kind === 'admitted-area' ? 'schema:AdministrativeArea' : kind === 'admitted-instrument' ? 'schema:MusicInstrument' : 'schema:Place';
  const label = kind === 'admitted-event' ? 'Harbour concert' : kind === 'admitted-area' ? 'North Shore' : kind === 'admitted-instrument' ? 'Grand piano' : 'Harbour Hall';
  const revision = 1;
  const statements: SubjectRead['subject']['statements'] = {};
  if (kind === 'admitted-event') {
    statements['schema:startDate'] = [statement('00000000-0000-4000-8000-00000000d201', 'schema:startDate', 'time', time('+2024-05-00T00:00:00Z', 10))];
  }
  return {
    subject: {
      id,
      type,
      revision,
      release: releaseDigest,
      context,
      labels: { en: label },
      descriptions: {},
      aliases: {},
      statements,
      sourceRecords: [],
      relationCounts: {},
      resolution: {},
    },
    account: null,
    summary: null,
    related: {},
  };
}

export function musicLocationExample(scenario: MusicLocationExample = 'admitted-place', locale = 'en') {
  const release = releaseForExamples();
  if (scenario === 'unsupported') delete release.types['schema:Place'];
  const subject = publicSubject(scenario);
  const snapshot = musicLocationSnapshot(subject.subject);
  const eventVenue = statement(
    '00000000-0000-4000-8000-00000000d211',
    'schema:location',
    'wikibase-item',
    { type: 'value', content: musicPlaceId },
    [
      {
        property: { id: 'schema:startDate', data_type: 'time' },
        value: time('+2024-05-00T00:00:00Z', 10),
      },
    ],
    [
      {
        hash: 'venue-source',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.test/event/harbour' },
          },
        ],
      },
    ],
  );
  const makeLink = (sourceId: string, sourceType: string, sourceLabel: string, assertion?: Statement) => ({
    subject: sourceId,
    property: 'schema:location',
    statement: eventVenue.id,
    ...(assertion ? { assertion } : {}),
    summary: summary(sourceId, sourceType, sourceLabel),
    type: sourceType,
    label: sourceLabel,
    related: {},
  });
  const areaRelation = statement(
    '00000000-0000-4000-8000-00000000d212',
    'schema:containedInPlace',
    'wikibase-item',
    { type: 'value', content: musicAreaId },
  );
  const eventRelations: Forward = {
    relations: [
      {
        statement: statement(
          '00000000-0000-4000-8000-00000000d213',
          'schema:location',
          'wikibase-item',
          { type: 'value', content: musicPlaceId },
          [
            {
              property: { id: 'schema:startDate', data_type: 'time' },
              value: time('+2024-05-00T00:00:00Z', 10),
            },
          ],
        ),
        target: musicPlaceId,
        external: null,
        summary: summary(musicPlaceId, 'schema:Place', 'Harbour Hall'),
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  const eventInstrumentRelations: Forward = {
    relations: [
      {
        statement: statement(
          '00000000-0000-4000-8000-00000000d215',
          'schema:instrument',
          'wikibase-item',
          { type: 'value', content: musicInstrumentId },
        ),
        target: musicInstrumentId,
        external: null,
        summary: summary(musicInstrumentId, 'schema:MusicInstrument', 'Grand piano'),
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  const eventPerformerRelations: Forward = {
    relations: [
      {
        statement: statement(
          '00000000-0000-4000-8000-00000000d216',
          'schema:performer',
          'wikibase-item',
          { type: 'value', content: musicPersonId },
        ),
        target: musicPersonId,
        external: null,
        summary: summary(musicPersonId, 'schema:Person', 'Ada North'),
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  const emptyForward: Forward = { relations: [], freshness, next: null };
  const emptyInverse: Inverse = { links: [], freshness, next: null };
  const firstInverse: Inverse = {
    links:
      scenario === 'sparse' || scenario === 'hidden-target'
        ? []
        : [makeLink(musicEventId, 'schema:Event', 'Harbour concert', eventVenue)],
    freshness,
    next: scenario === 'admitted-place' ? 'opaque:music-location/events/next' : null,
  };
  const nextInverse: Inverse = {
    links: [
      {
        subject: '00000000-0000-4000-8000-00000000d106',
        property: 'schema:location',
        statement: '00000000-0000-4000-8000-00000000d214',
        assertion: statement(
          '00000000-0000-4000-8000-00000000d214',
          'schema:location',
          'wikibase-item',
          { type: 'value', content: musicPlaceId },
        ),
        summary: summary('00000000-0000-4000-8000-00000000d106', 'schema:Event', 'River concert'),
        type: 'schema:Event',
        label: 'River concert',
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  let useRetiredRevision = false;
  const currentSubject =
    scenario === 'retired'
      ? {
          ...subject,
          subject: { ...subject.subject, revision: 2 },
        }
      : subject;
  const exampleFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/relations')) {
        const property = url.searchParams.get('property') ?? '';
        const body =
          property === 'schema:location'
            ? scenario === 'admitted-event'
              ? eventRelations
              : emptyForward
            : property === 'schema:containedInPlace'
              ? scenario === 'admitted-area'
                ? emptyForward
                : {
                    relations:
                      scenario === 'sparse' || scenario === 'hidden-target'
                        ? []
                        : [
                            {
                              statement: areaRelation,
                              target: musicAreaId,
                              external: null,
                              summary: summary(musicAreaId, 'schema:AdministrativeArea', 'North Shore'),
                              related: {},
                            },
                          ],
                  freshness,
                  next: null,
                }
              : property === 'schema:instrument'
                ? eventInstrumentRelations
                : property === 'schema:performer'
                  ? eventPerformerRelations
                  : emptyForward;
        return json(body);
      }
      if (url.pathname.endsWith('/links')) {
        const property = url.searchParams.get('property') ?? '';
        const cursor = url.searchParams.get('cursor');
        const body =
          cursor === 'opaque:music-location/events/next'
            ? nextInverse
            : property === 'schema:location'
              ? firstInverse
              : property === 'schema:containedInPlace'
                ? {
                    links: [
                      {
                        subject: musicPlaceId,
                        property: 'schema:containedInPlace',
                        statement: areaRelation.id,
                        assertion: areaRelation,
                        summary: summary(musicPlaceId, 'schema:Place', 'Harbour Hall'),
                        type: 'schema:Place',
                        label: 'Harbour Hall',
                        related: {},
                      },
                    ],
                    freshness,
                    next: null,
                  }
                : property === 'schema:instrument'
                  ? {
                      links: [
                        {
                          subject: musicEventId,
                          property: 'schema:instrument',
                          statement: '00000000-0000-4000-8000-00000000d215',
                          assertion: statement(
                            '00000000-0000-4000-8000-00000000d215',
                            'schema:instrument',
                            'wikibase-item',
                            musicInstrumentId,
                          ),
                          summary: summary(musicEventId, 'schema:Event', 'Harbour concert'),
                          type: 'schema:Event',
                          label: 'Harbour concert',
                          related: {},
                        },
                      ],
                      freshness,
                      next: null,
                    }
                  : emptyInverse;
        return json(body);
      }
      if (url.pathname.includes('/subjects/'))
        return json(useRetiredRevision || scenario === 'retired' ? currentSubject : subject);
      return json({}, 404);
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://location.example', { fetch: exampleFetch });
  const address: MusicLocationAddress = snapshot;
  const read = (next: MusicLocationAddress = address) =>
    readMusicLocation(client, undefined, release, next, locale);
  return {
    address,
    client,
    locale,
    public: subject,
    release,
    source: { scenario },
    read,
    retire: () => {
      useRetiredRevision = true;
    },
    areaRelation,
    eventVenue,
    nextInverse,
  };
}
