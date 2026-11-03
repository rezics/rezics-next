import { expect, mock, test } from 'bun:test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { musicContextKind, readMusicContext } from '../src/features/catalogue/music-context-profile';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

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
  type('schema:Place', 'place', ['schema:startDate', 'schema:location', 'wdt:P1619']);
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
            value: { type: 'value', content: { time: '+1999-00-00T00:00:00Z', precision: 9 } },
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
                  qualifiers: [{ property: { id: 'schema:startDate', data_type: 'time' }, value: { type: 'value', content: { time: '+2001-05-00T00:00:00Z', precision: 10 } } }],
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
                  qualifiers: [{ property: { id: 'schema:startDate', data_type: 'time' }, value: { type: 'value', content: { time: '+2002-00-00T00:00:00Z', precision: 9 } } }],
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
                summary: mode === 'unreadable' ? null : { id: recording, type: 'schema:MusicAlbum', label: { value: 'Live', language: 'en' } },
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
  expect(read.facts.some((fact) => fact.precision === '9' && fact.text === '1999')).toBe(true);
  expect(read.facts.some((fact) => fact.unknown)).toBe(true);
  expect(read.links.map((link) => link.label)).toEqual(['Spring concert', 'Autumn concert', 'Live']);
  expect(read.links[0]?.date).toBe('2001-05');
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
