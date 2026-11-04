import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { musicContextKind, readMusicContext } from '../src/features/catalogue/music-context-profile';
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
  type('schema:Place', 'place', ['schema:startDate', 'schema:location', 'wdt:P1619', 'wdt:P9000', 'wdt:P9001', 'wdt:P9002']);
  type('schema:Event', 'event', ['schema:startDate', 'schema:location']);
  type('schema:MusicInstrument', 'instrument', ['schema:name']);
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
  release.properties['wdt:P1619'] = {
    ...time,
    iri: 'http://www.wikidata.org/prop/direct/P1619',
    labels: { en: 'date of official opening' },
  };
  for (const [id, label] of [['wdt:P9000', 'unsupported precision'], ['wdt:P9001', 'unsupported calendar'], ['wdt:P9002', 'unsupported uncertainty']])
    release.properties[id] = { ...time, iri: `http://www.wikidata.org/prop/direct/${id.slice(4)}`, labels: { en: label } };
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
          id: '00000000-0000-4000-8000-00000000e034', rank: 'normal',
          property: { id: 'wdt:P9000', data_type: 'time' },
          value: { type: 'value', content: { time: '+2001-05-00T00:00:00Z', precision: 12, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' } },
          qualifiers: [], references: [],
        },
      ],
      'wdt:P9001': [
        {
          id: '00000000-0000-4000-8000-00000000e035', rank: 'normal',
          property: { id: 'wdt:P9001', data_type: 'time' },
          value: { type: 'value', content: { time: '+2001-05-01T00:00:00Z', precision: 11, calendarmodel: 'https://example.org/calendar' } },
          qualifiers: [], references: [],
        },
      ],
      'wdt:P9002': [
        {
          id: '00000000-0000-4000-8000-00000000e036', rank: 'normal',
          property: { id: 'wdt:P9002', data_type: 'time' },
          value: { type: 'value', content: { time: '+2001-05-01T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727', before: -1 } },
          qualifiers: [], references: [],
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

function client(mode: 'ok' | 'unreadable' | 'denied') {
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async () => {
        if (mode === 'denied') return { status: 401 };
        return { status: 200, data: placeRead() };
      },
      relations: {
        get: async () => ({
          status: 200,
          data: {
            relations: [
              {
                statement: {
                  id: eventA,
                  property: { id: 'schema:location', data_type: 'wikibase-item' },
                  value: { type: 'value', content: eventA },
                  rank: 'normal',
                  qualifiers: [
                    {
                      property: { id: 'schema:startDate', data_type: 'time' },
                      value: { type: 'value', content: { time: '+2001-05-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985786' } },
                    },
                  ],
                  references: [],
                },
                summary: { id: eventA, type: 'schema:Event', label: { value: 'Spring concert', language: 'en' } },
                related: {},
              },
              {
                statement: {
                  id: eventB,
                  property: { id: 'schema:location', data_type: 'wikibase-item' },
                  value: { type: 'value', content: eventB },
                  rank: 'normal',
                  qualifiers: [
                    {
                      property: { id: 'schema:startDate', data_type: 'time' },
                      value: { type: 'value', content: { time: '+2002-01-01T00:00:00Z', precision: 11, calendarmodel: 'https://example.org/calendar' } },
                    },
                  ],
                  references: [],
                },
                summary: { id: eventB, type: 'schema:Event', label: { value: 'Autumn concert', language: 'en' } },
                related: {},
              },
              {
                statement: {
                  id: recording,
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
            ],
            next: null,
            freshness: { caught_up: true },
          },
        }),
      },
    }),
  } as unknown as KernelClient;
}

test('music context keeps two events at a place, dated recordings, partial dates and unreadable artists', async () => {
  expect(musicContextKind(bundledRelease, 'schema:MusicAlbum')).toBe('unsupported');
  const definitions = admit(structuredClone(bundledRelease) as Release);
  expect(musicContextKind(definitions, 'schema:Place')).toBe('place');
  expect(musicContextKind(definitions, 'schema:MusicInstrument')).toBe('instrument');
  const read = await readMusicContext(client('ok'), 'Bearer reader', definitions, place, 'en', {});
  if (!read.ok) throw new Error('expected place');
  expect(read.kind).toBe('place');
  const timeFact = (property: string) => read.facts.find((fact) => fact.property === property)?.time;
  expect(timeFact('schema:startDate')).toMatchObject({ state: 'supported', date: '+1999', precision: 9 });
  expect(timeFact('wdt:P9000')).toMatchObject({ state: 'unsupported', reason: 'precision' });
  expect(timeFact('wdt:P9001')).toMatchObject({ state: 'unsupported', reason: 'calendar' });
  expect(timeFact('wdt:P9002')).toMatchObject({ state: 'unsupported', reason: 'uncertainty' });
  expect(timeFact('wdt:P1619')).toMatchObject({ state: 'novalue' });
  expect(read.facts.some((fact) => fact.unknown)).toBe(false);
  expect(read.links.map((link) => link.label)).toEqual(['Spring concert', 'Autumn concert', 'Live']);
  expect(read.links[0]?.date).toMatchObject({ state: 'supported', date: '+2001-05', calendar: 'julian' });
  expect(read.links[1]?.date).toMatchObject({ state: 'unsupported', reason: 'calendar' });
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
  const unread = await readMusicContext(client('unreadable'), 'Bearer reader', definitions, place, 'en', {});
  expect(unread.ok && unread.links.some((link) => link.unreadable)).toBe(true);
  expect(await readMusicContext(client('denied'), 'Bearer reader', definitions, place, 'en', {})).toEqual({
    ok: false,
    reason: 'denied',
  });
  const closed = await readMusicContext(client('ok'), 'Bearer reader', bundledRelease, place, 'en', {});
  expect(closed.ok && closed.kind).toBe('unsupported');
  expect(catalogueEntries.musicContext({ id: place, label: 'Hall', locale: 'en' }).href).toContain('/music-context');
});
