import { expect, test } from 'bun:test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../src/subject/candidates';
import { musicContextKind, readMusicContext } from '../src/features/catalogue/music-context-profile';
import { MUSIC_CONTEXT_PAGE_CAP } from '../src/features/pages/graph-browser';

const event = '00000000-0000-4000-8000-00000000d201';
const performer = '00000000-0000-4000-8000-00000000d202';
const guitar = '00000000-0000-4000-8000-00000000d203';
const bass = '00000000-0000-4000-8000-00000000d204';
const locale = 'en';
const value = (content: unknown) => ({ type: 'value', content });

function subject(): SubjectRead {
  return {
    subject: {
      id: event,
      type: 'schema:MusicEvent',
      revision: 3,
      release: bundledDigest,
      context: candidateContext,
      labels: { en: 'Harbor music festival' },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:startDate': [
          {
            id: '00000000-0000-4000-8000-00000000e201',
            rank: 'normal',
            property: { id: 'schema:startDate', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+2025-06-00T00:00:00Z',
                precision: 10,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url', data_type: 'url' },
                    value: value('https://festival.example.test/program'),
                  },
                ],
                hash: 'start-date-source',
              },
            ],
          },
        ],
        'schema:endDate': [
          {
            id: '00000000-0000-4000-8000-00000000e202',
            rank: 'normal',
            property: { id: 'schema:endDate', data_type: 'time' },
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

function credit(instrument: string, statementId: string, disclosed = true) {
  return {
    statement: {
      id: statementId,
      rank: 'normal',
      property: { id: 'schema:performer', data_type: 'wikibase-item' },
      value: value(performer),
      qualifiers: [
        { property: { id: 'wdt:P1303', data_type: 'wikibase-item' }, value: value(instrument) },
        { property: { id: 'wdt:P1932', data_type: 'string' }, value: value('Harbor Quartet') },
      ],
      references: [],
      rezics: { release: bundledDigest, revision: 3 },
    },
    summary: {
      id: performer,
      type: 'schema:Person',
      types: ['schema:Person'],
      label: { value: 'Harbor Quartet', language: 'en' },
    },
    related: disclosed
      ? {
          [instrument]: {
            id: instrument,
            type: 'wd:Q34379',
            types: ['wd:Q34379'],
            label: { value: instrument === guitar ? 'Guitar' : 'Bass guitar', language: 'en' },
          },
        }
      : {},
  };
}

function client(
  options: {
    status?: number;
    throw?: boolean;
    rows?: unknown[];
  } = {},
) {
  const relationReads: unknown[] = [];
  const native = {
    subjects: ({ id }: { id: string }) => ({
      get: async ({
        query,
        fetch,
      }: {
        query: { context: string; language: string };
        fetch: { cache: string; redirect: string };
      }) => {
        expect(id).toBe(event);
        expect(query).toEqual({ context: candidateContext, language: locale });
        expect(fetch).toEqual({ cache: 'no-store', redirect: 'manual' });
        return { status: 200, data: subject() };
      },
      relations: {
        get: async ({
          query,
          fetch,
        }: {
          query: Record<string, unknown>;
          fetch: { cache: string; redirect: string };
        }) => {
          relationReads.push({ query, fetch });
          if (options.throw) throw new TypeError('network unavailable');
          if (options.status !== undefined) return { status: options.status };
          return {
            status: 200,
            data: {
              relations: options.rows ?? [
                credit(guitar, '00000000-0000-4000-8000-00000000e211'),
                credit(bass, '00000000-0000-4000-8000-00000000e212'),
              ],
              next: null,
              freshness: { caught_up: true },
            },
          };
        },
      },
    }),
  };
  return { client: native as unknown as KernelClient, relationReads };
}

test('released music context reads source-bearing partial event time and the exact instrument credit', async () => {
  expect(musicContextKind(bundledRelease, 'schema:Place')).toBe('place');
  expect(musicContextKind(bundledRelease, 'schema:MusicVenue')).toBe('place');
  expect(musicContextKind(bundledRelease, 'schema:Event')).toBe('event');
  expect(musicContextKind(bundledRelease, 'schema:MusicEvent')).toBe('event');
  expect(musicContextKind(bundledRelease, 'schema:AdministrativeArea')).toBe('area');
  expect(musicContextKind(bundledRelease, 'wd:Q34379')).toBe('instrument');
  expect(musicContextKind(bundledRelease, 'schema:MusicInstrument')).toBe('unsupported');

  const fixture = client();
  const read = await readMusicContext(fixture.client, 'Bearer reader', bundledRelease, event, locale, {
    context: candidateContext,
    stream: 'schema:performer',
  });
  if (!read.ok) throw new Error('expected the admitted music event');
  expect(read.public.subject).toMatchObject({
    id: event,
    type: 'schema:MusicEvent',
    release: bundledDigest,
    context: candidateContext,
  });
  expect(read.facts.find((fact) => fact.property === 'schema:startDate')?.time).toMatchObject({
    state: 'supported',
    date: '+2025-06',
    precision: 10,
    calendar: 'gregorian',
  });
  expect(read.facts.find((fact) => fact.property === 'schema:endDate')?.time?.state).toBe('novalue');
  expect(read.public.subject.statements['schema:startDate']?.[0]?.references[0]?.parts[0]?.value.content).toBe(
    'https://festival.example.test/program',
  );
  expect(fixture.relationReads).toEqual([
    {
      query: {
        property: 'schema:performer',
        language: locale,
        limit: MUSIC_CONTEXT_PAGE_CAP,
        context: candidateContext,
      },
      fetch: { cache: 'no-store', redirect: 'manual' },
    },
  ]);
  expect(read.links.map((link) => link.occurrence)).toEqual([
    '00000000-0000-4000-8000-00000000e211',
    '00000000-0000-4000-8000-00000000e212',
  ]);
  expect(read.links.map((link) => link.role?.target)).toEqual([
    { id: guitar, label: 'Guitar', targetKind: 'instrument' },
    { id: bass, label: 'Bass guitar', targetKind: 'instrument' },
  ]);
  expect(read.next).toBeNull();
  expect(read.relationsUnavailable).toBeUndefined();
});

test('an unavailable relation component preserves facts and distinguishes missing, empty and unavailable', async () => {
  for (const failure of [{ status: 503 }, { throw: true }]) {
    const read = await readMusicContext(client(failure).client, undefined, bundledRelease, event, locale, {
      context: candidateContext,
      stream: 'schema:performer',
      cursor: 'native-current-cursor',
    });
    if (!read.ok) throw new Error('public event facts remain readable');
    expect(read.relationsUnavailable).toBe(true);
    expect(read.facts.map((fact) => fact.property)).toEqual(['schema:startDate', 'schema:endDate']);
    expect(read.links).toEqual([]);
    expect(read.next).toBeNull();
  }
  const missing = await readMusicContext(client().client, undefined, bundledRelease, event, locale, {
    context: candidateContext,
    stream: 'schema:containedInPlace',
  });
  expect(missing.ok && missing.streamUnavailable).toBe(true);
  const empty = await readMusicContext(client({ rows: [] }).client, undefined, bundledRelease, event, locale, {
    context: candidateContext,
    stream: 'schema:performer',
  });
  expect(empty.ok && empty.relationsUnavailable).toBeUndefined();
  expect(empty.ok && empty.links).toEqual([]);
});

test('concealed instrument qualifiers never fall back to their raw identifiers', async () => {
  const read = await readMusicContext(
    client({ rows: [credit(guitar, '00000000-0000-4000-8000-00000000e213', false)] }).client,
    undefined,
    bundledRelease,
    event,
    locale,
    { context: candidateContext, stream: 'schema:performer' },
  );
  if (!read.ok) throw new Error('expected the public event');
  expect(read.links[0]?.role).toBeUndefined();
  expect(JSON.stringify(read.links)).not.toContain(guitar);
});
