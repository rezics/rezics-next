import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { musicContextKind, readMusicContext } from '../src/features/catalogue/music-context-profile';
import { MUSIC_CONTEXT_PAGE_CAP } from '../src/features/pages/graph-browser';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { MusicContextProfile } from '../src/features/pages/music-context-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

const place = '00000000-0000-4000-8000-00000000d001';
const eventA = '00000000-0000-4000-8000-00000000d002';
const eventB = '00000000-0000-4000-8000-00000000d003';
const recording = '00000000-0000-4000-8000-00000000d004';

function admit(release: Release) {
  const type = (id: string, label: string, properties: string[]) => {
    release.types[id] = {
      iri: `http://schema.org/${label}`,
      labels: { en: label },
      mappings: [],
      bases: ['schema:Thing'],
      properties,
      facets: [],
      coverRatio: '5:7',
      listPresentation: { imageAspect: 'portrait', keyFacts: [] },
    };
  };
  type('schema:Place', 'place', [
    'schema:startDate',
    'schema:location',
    'wdt:P8000',
    'wdt:P1619',
    'wdt:P9000',
    'wdt:P9001',
    'wdt:P9002',
    'wdt:P9003',
  ]);
  type('schema:Event', 'event', ['schema:startDate', 'schema:location']);
  type('schema:MusicInstrument', 'instrument', ['schema:name']);
  type('schema:AdministrativeArea', 'area', []);
  release.types['schema:AdministrativeArea']!.bases = ['schema:Event', 'schema:Place'];
  const time = {
    iri: 'http://schema.org/startDate',
    labels: { en: 'start' },
    descriptions: { en: 'start' },
    datatype: 'time' as const,
    mappings: [],
    qualifiers: [],
    multivalued: false,
    value: { type: 'object' as const },
  };
  release.properties['schema:startDate'] = time;
  release.properties['schema:location'] = {
    iri: 'http://schema.org/location',
    labels: { en: 'location' },
    descriptions: { en: 'location' },
    datatype: 'wikibase-item',
    targets: ['schema:Place'],
    mappings: [],
    qualifiers: ['schema:startDate'],
    multivalued: true,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'credit', order: 'time', inverse: 'none' },
  };
  release.properties['wdt:P8000'] = {
    iri: 'http://www.wikidata.org/prop/direct/P8000',
    labels: { en: 'z other relation' },
    descriptions: { en: 'another admitted relation' },
    datatype: 'wikibase-item',
    targets: ['schema:Event'],
    mappings: [],
    qualifiers: ['schema:startDate'],
    multivalued: true,
    value: { type: 'string', pattern: '^[0-9a-f-]+$' },
    relation: { group: 'context', order: 'name', inverse: 'none' },
  };
  release.properties['wdt:P1619'] = {
    ...time,
    iri: 'http://www.wikidata.org/prop/direct/P1619',
    labels: { en: 'date of official opening' },
  };
  for (const [id, label] of [
    ['wdt:P9000', 'unsupported precision'],
    ['wdt:P9001', 'unsupported calendar'],
    ['wdt:P9002', 'unsupported uncertainty'],
  ])
    release.properties[id] = {
      ...time,
      iri: `http://www.wikidata.org/prop/direct/${id.slice(4)}`,
      labels: { en: label },
    };
  release.properties['wdt:P9003'] = {
    iri: 'http://www.wikidata.org/prop/direct/P9003',
    labels: { en: 'geographic coordinates' },
    descriptions: { en: 'geographic coordinates' },
    datatype: 'string',
    mappings: [],
    qualifiers: [],
    multivalued: true,
    value: { type: 'string' },
  };
  return release;
}

function placeRead(): SubjectRead {
  return {
    subject: {
      id: place,
      type: 'schema:Place',
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: 'Hall' },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:startDate': [
          {
            id: '00000000-0000-4000-8000-00000000e031',
            rank: 'normal',
            property: { id: 'schema:startDate', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+1999-00-00T00:00:00Z',
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
                timezone: -300,
                before: 2,
                after: 1,
              },
            },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:location': [
          {
            id: '00000000-0000-4000-8000-00000000e032',
            rank: 'normal',
            property: { id: 'schema:location', data_type: 'string' },
            value: { type: 'somevalue' },
            qualifiers: [],
            references: [],
          },
        ],
        'wdt:P1619': [
          {
            id: '00000000-0000-4000-8000-00000000e033',
            rank: 'normal',
            property: { id: 'wdt:P1619', data_type: 'time' },
            value: { type: 'novalue' },
            qualifiers: [],
            references: [],
          },
        ],
        'wdt:P9000': [
          {
            id: '00000000-0000-4000-8000-00000000e034',
            rank: 'normal',
            property: { id: 'wdt:P9000', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+2001-05-00T00:00:00Z',
                precision: 12,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            qualifiers: [],
            references: [],
          },
        ],
        'wdt:P9001': [
          {
            id: '00000000-0000-4000-8000-00000000e035',
            rank: 'normal',
            property: { id: 'wdt:P9001', data_type: 'time' },
            value: {
              type: 'value',
              content: { time: '+2001-05-01T00:00:00Z', precision: 11, calendarmodel: 'https://example.org/calendar' },
            },
            qualifiers: [],
            references: [],
          },
        ],
        'wdt:P9002': [
          {
            id: '00000000-0000-4000-8000-00000000e036',
            rank: 'normal',
            property: { id: 'wdt:P9002', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+2001-05-01T00:00:00Z',
                precision: 11,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
                before: -1,
              },
            },
            qualifiers: [],
            references: [],
          },
        ],
        'wdt:P9003': [
          {
            id: '00000000-0000-4000-8000-00000000e037',
            rank: 'normal',
            property: { id: 'wdt:P9003', data_type: 'string' },
            value: { type: 'somevalue' },
            qualifiers: [],
            references: [],
          },
          {
            id: '00000000-0000-4000-8000-00000000e038',
            rank: 'normal',
            property: { id: 'wdt:P9003', data_type: 'string' },
            value: { type: 'value', content: '35.1, 139.2' },
            qualifiers: [],
            references: [],
          },
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  };
}

function client(
  mode: 'ok' | 'unreadable' | 'denied',
  relationReads: Array<{ property: string; limit: number; cursor?: string }> = [],
  networkReads: Array<{ resource: 'subject' | 'relations'; cache?: string; redirect?: string }> = [],
) {
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async (options?: { fetch?: { cache?: string; redirect?: string } }) => {
        networkReads.push({ resource: 'subject', ...options?.fetch });
        if (mode === 'denied') return { status: 401 };
        return { status: 200, data: placeRead() };
      },
      relations: {
        get: async ({
          query,
          fetch,
        }: {
          query: { property: string; limit: number; cursor?: string };
          fetch?: { cache?: string; redirect?: string };
        }) => {
          relationReads.push({ property: query.property, limit: query.limit, cursor: query.cursor });
          networkReads.push({ resource: 'relations', ...fetch });
          const locationRows = [
            {
              statement: {
                id: '00000000-0000-4000-8000-00000000e041',
                property: { id: 'schema:location', data_type: 'wikibase-item' },
                value: { type: 'value', content: eventA },
                rank: 'normal',
                qualifiers: [
                  {
                    property: { id: 'schema:startDate', data_type: 'time' },
                    value: {
                      type: 'value',
                      content: {
                        time: '+2001-05-00T00:00:00Z',
                        precision: 10,
                        calendarmodel: 'http://www.wikidata.org/entity/Q1985786',
                      },
                    },
                  },
                ],
                references: [],
              },
              summary: { id: eventA, type: 'schema:Event', label: { value: 'Spring concert', language: 'en' } },
              related: {},
            },
            {
              statement: {
                id: '00000000-0000-4000-8000-00000000e044',
                property: { id: 'schema:location', data_type: 'wikibase-item' },
                value: { type: 'value', content: eventA },
                rank: 'normal',
                qualifiers: [
                  {
                    property: { id: 'schema:startDate', data_type: 'time' },
                    value: {
                      type: 'value',
                      content: {
                        time: '+2001-05-00T00:00:00Z',
                        precision: 10,
                        calendarmodel: 'http://www.wikidata.org/entity/Q1985786',
                      },
                    },
                  },
                ],
                references: [],
              },
              summary: { id: eventA, type: 'schema:Event', label: { value: 'Spring concert', language: 'en' } },
              related: {},
            },
            {
              statement: {
                id: '00000000-0000-4000-8000-00000000e042',
                property: { id: 'schema:location', data_type: 'wikibase-item' },
                value: { type: 'value', content: eventB },
                rank: 'normal',
                qualifiers: [
                  {
                    property: { id: 'schema:startDate', data_type: 'time' },
                    value: {
                      type: 'value',
                      content: {
                        time: '+2002-01-01T00:00:00Z',
                        precision: 11,
                        calendarmodel: 'https://example.org/calendar',
                      },
                    },
                  },
                ],
                references: [],
              },
              summary: { id: eventB, type: 'schema:Event', label: { value: 'Autumn concert', language: 'en' } },
              related: {},
            },
            {
              statement: {
                id: '00000000-0000-4000-8000-00000000e043',
                property: { id: 'schema:location', data_type: 'wikibase-item' },
                value: { type: 'value', content: recording },
                rank: 'normal',
                qualifiers: [{ property: { id: 'schema:startDate', data_type: 'time' }, value: { type: 'novalue' } }],
                references: [],
              },
              summary:
                mode === 'unreadable'
                  ? null
                  : { id: recording, type: 'schema:MusicAlbum', label: { value: 'Live', language: 'en' } },
              related: {},
            },
          ];
          return {
            status: 200,
            data: {
              relations: query.property === 'schema:location' ? locationRows : [],
              next: query.cursor ? null : 'next-cursor',
              freshness: { caught_up: true },
            },
          };
        },
      },
    }),
  } as unknown as KernelClient;
}

test('music context keeps two events at a place, dated recordings, partial dates and unreadable artists', async () => {
  expect(musicContextKind(bundledRelease, 'schema:MusicAlbum')).toBe('unsupported');
  const definitions = admit(structuredClone(bundledRelease) as Release);
  expect(musicContextKind(definitions, 'schema:Place')).toBe('place');
  expect(musicContextKind(definitions, 'schema:MusicInstrument')).toBe('instrument');
  expect(musicContextKind(definitions, 'schema:AdministrativeArea')).toBe('area');
  const relationReads: Array<{ property: string; limit: number; cursor?: string }> = [];
  const networkReads: Array<{ resource: 'subject' | 'relations'; cache?: string; redirect?: string }> = [];
  const read = await readMusicContext(
    client('unreadable', relationReads, networkReads),
    'Bearer reader',
    definitions,
    place,
    'en',
    { stream: 'schema:location', cursor: 'cursor-one' },
  );
  if (!read.ok) throw new Error('expected place');
  expect(read.kind).toBe('place');
  expect(read.public.subject).toMatchObject({
    id: place,
    type: 'schema:Place',
    release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  expect(read.streams).toEqual([
    { id: 'schema:location', label: 'location' },
    { id: 'wdt:P8000', label: 'z other relation' },
  ]);
  expect(relationReads).toEqual([{ property: 'schema:location', limit: MUSIC_CONTEXT_PAGE_CAP, cursor: 'cursor-one' }]);
  expect(networkReads).toEqual([
    { resource: 'subject', cache: 'no-store', redirect: 'manual' },
    { resource: 'relations', cache: 'no-store', redirect: 'manual' },
  ]);
  const timeFact = (property: string) => read.facts.find((fact) => fact.property === property)?.time;
  expect(timeFact('schema:startDate')).toMatchObject({ state: 'supported', date: '+1999', precision: 9 });
  expect(timeFact('wdt:P9000')).toMatchObject({ state: 'unsupported', reason: 'precision' });
  expect(timeFact('wdt:P9001')).toMatchObject({ state: 'unsupported', reason: 'calendar' });
  expect(timeFact('wdt:P9002')).toMatchObject({ state: 'unsupported', reason: 'uncertainty' });
  expect(timeFact('wdt:P1619')).toMatchObject({ state: 'novalue' });
  expect(read.facts.filter((fact) => fact.property === 'wdt:P9003').map((fact) => fact.unknown)).toEqual([
    'somevalue',
    'coordinates-unsupported',
  ]);
  expect(read.links.map((link) => link.label)).toEqual(['Spring concert', 'Spring concert', 'Autumn concert', '']);
  expect(read.links.map((link) => link.id)).toEqual([eventA, eventA, eventB, '']);
  expect(read.links.map((link) => link.position)).toEqual([1, 2, 3, 4]);
  expect(read.links[0]?.occurrence).not.toBe(read.links[1]?.occurrence);
  expect(read.links[0]?.date?.time).toMatchObject({ state: 'supported', date: '+2001-05', calendar: 'julian' });
  expect(read.links[2]?.date?.time).toMatchObject({ state: 'unsupported', reason: 'calendar' });
  expect(read.links[3]).toMatchObject({ id: '', unreadable: true });
  const otherReads: Array<{ property: string; limit: number; cursor?: string }> = [];
  const other = await readMusicContext(client('ok', otherReads), 'Bearer reader', definitions, place, 'en', {
    stream: 'wdt:P8000',
  });
  expect(other.ok && other.stream).toBe('wdt:P8000');
  expect(otherReads).toEqual([{ property: 'wdt:P8000', limit: MUSIC_CONTEXT_PAGE_CAP, cursor: undefined }]);
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MusicContextProfile, {
        id: place,
        locale: 'en',
        initial: read,
        transport: { read: async () => read },
      }),
    ),
  );
  queryClient.clear();
  expect(html).toContain('+1999');
  expect(html).toContain('Unsupported precision: 12');
  expect(html).toContain('Unsupported calendar: https://example.org/calendar');
  expect(html).toContain('Unsupported time uncertainty');
  expect(html).not.toContain('Unknown date');
  expect(await readMusicContext(client('denied'), 'Bearer reader', definitions, place, 'en', {})).toEqual({
    ok: false,
    reason: 'denied',
  });
  const closed = await readMusicContext(client('ok'), 'Bearer reader', bundledRelease, place, 'en', {});
  expect(closed.ok && closed.kind).toBe('unsupported');
  const missingCalls: Array<{ property: string; limit: number; cursor?: string }> = [];
  const missing = await readMusicContext(client('ok', missingCalls), 'Bearer reader', definitions, place, 'en', {
    stream: 'schema:removed',
  });
  expect(missing.ok && missing.streamUnavailable).toBe(true);
  expect(missingCalls).toEqual([]);
  expect(catalogueEntries.musicContext({ id: place, label: 'Hall', locale: 'en' }).href).toContain('/music-context');
});
