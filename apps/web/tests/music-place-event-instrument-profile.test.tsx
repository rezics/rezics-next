import { expect, mock, test } from 'bun:test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import recordedRelease from '../src/kernel/recorded/definitions-release.json';
import { musicContextKind, readMusicContext } from '../src/features/catalogue/music-context-profile';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

const event = '00000000-0000-4000-8000-00000000d002';
const venue = '00000000-0000-4000-8000-00000000d001';
const instrument = '00000000-0000-4000-8000-00000000d005';
const recorded = recordedRelease as { digest: string; release: Release; status: number };

function closedRelease(): Release {
  const release = structuredClone(bundledRelease) as Release;
  for (const id of [
    'schema:Place',
    'schema:MusicVenue',
    'schema:AdministrativeArea',
    'schema:Event',
    'schema:MusicEvent',
    'wd:Q34379',
  ])
    delete release.types[id];
  return release;
}

function eventRead(): SubjectRead {
  return {
    subject: {
      id: event,
      type: 'schema:MusicEvent',
      revision: 1,
      release: recorded.digest,
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: 'Spring concert' },
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
        'schema:endDate': [
          {
            id: '00000000-0000-4000-8000-00000000e034',
            rank: 'normal',
            property: { id: 'schema:endDate', data_type: 'time' },
            value: { type: 'somevalue' },
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

function client(mode: 'ok' | 'unreadable' | 'denied' | 'unavailable' | 'withheld') {
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async () => {
        if (mode === 'denied') return { status: 401 };
        if (mode === 'unavailable') return { status: 503 };
        const data = eventRead();
        if (mode === 'withheld') delete data.subject.statements['schema:startDate'];
        return { status: 200, data };
      },
      relations: {
        get: async () => ({
          status: 200,
          data: {
            relations:
              mode === 'withheld'
                ? []
                : [
                    {
                      statement: {
                        id: venue,
                        property: { id: 'schema:location', data_type: 'wikibase-item' },
                        value: { type: 'value', content: venue },
                        rank: 'normal',
                        qualifiers: [],
                        references: [],
                      },
                      summary: { id: venue, type: 'schema:MusicVenue', label: { value: 'Hall', language: 'en' } },
                      related: {},
                    },
                    {
                      statement: {
                        id: instrument,
                        property: { id: 'wdt:P1303', data_type: 'wikibase-item' },
                        value: { type: 'value', content: instrument },
                        rank: 'normal',
                        qualifiers: [
                          {
                            property: { id: 'wdt:P1932', data_type: 'string' },
                            value: { type: 'value', content: 'piano' },
                          },
                          {
                            property: { id: 'schema:startDate', data_type: 'time' },
                            value: { type: 'value', content: { time: '+2001-05-00T00:00:00Z', precision: 10 } },
                          },
                        ],
                        references: [],
                      },
                      summary:
                        mode === 'unreadable'
                          ? null
                          : { id: instrument, type: 'wd:Q34379', label: { value: 'Piano', language: 'en' } },
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

test('music context reads admitted event grains from the recorded release and keeps denied unavailable withheld and historical unsupported', async () => {
  expect(recorded.status).toBe(200);
  expect(recorded.release).toEqual(bundledRelease);
  expect(musicContextKind(bundledRelease, 'schema:MusicAlbum')).toBe('unsupported');
  expect(musicContextKind(bundledRelease, 'schema:MusicInstrument')).toBe('unsupported');
  expect(musicContextKind(recorded.release, 'schema:Place')).toBe('place');
  expect(musicContextKind(recorded.release, 'schema:MusicVenue')).toBe('place');
  expect(musicContextKind(recorded.release, 'schema:AdministrativeArea')).toBe('area');
  expect(musicContextKind(recorded.release, 'schema:Event')).toBe('event');
  expect(musicContextKind(recorded.release, 'schema:MusicEvent')).toBe('event');
  expect(musicContextKind(recorded.release, 'wd:Q34379')).toBe('instrument');
  const read = await readMusicContext(client('ok'), 'Bearer reader', recorded.release, event, 'en', {});
  if (!read.ok) throw new Error('expected event');
  expect(read.kind).toBe('event');
  expect(read.facts.some((fact) => fact.precision === '9' && fact.text === '1999')).toBe(true);
  expect(read.facts.some((fact) => fact.unknown)).toBe(true);
  expect(read.links.map((link) => link.label)).toEqual(['Hall', 'Piano']);
  expect(read.links[1]?.date).toBe('2001-05');
  expect(read.links[1]?.role).toBe('piano');
  const unread = await readMusicContext(client('unreadable'), 'Bearer reader', recorded.release, event, 'en', {});
  expect(unread.ok && unread.links.some((link) => link.unreadable)).toBe(true);
  const withheld = await readMusicContext(client('withheld'), 'Bearer reader', recorded.release, event, 'en', {});
  expect(withheld.ok && withheld.kind).toBe('event');
  expect(withheld.ok && withheld.facts.some((fact) => fact.property === 'schema:startDate')).toBe(false);
  expect(withheld.ok && withheld.links).toEqual([]);
  expect(await readMusicContext(client('denied'), 'Bearer reader', recorded.release, event, 'en', {})).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(await readMusicContext(client('unavailable'), 'Bearer reader', recorded.release, event, 'en', {})).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  const closed = await readMusicContext(client('ok'), 'Bearer reader', closedRelease(), event, 'en', {});
  expect(closed.ok && closed.kind).toBe('unsupported');
  expect(catalogueEntries.musicContext({ id: event, label: 'Spring concert', locale: 'en' }).href).toContain(
    '/music-context',
  );
});
