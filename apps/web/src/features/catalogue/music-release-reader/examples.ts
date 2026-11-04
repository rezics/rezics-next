import { createKernelClient, type KernelClient, type SubjectRead } from '@rezics/client';
import { candidateContext } from '../../../subject/candidates';
import recordedRelease from '../../../kernel/recorded/definitions-release.json';
import type { GuideRelease } from '../definition-guide';
import { readMusicRelease, type MusicReleaseAddress } from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type Forward = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type Links = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Statement = SubjectRead['subject']['statements'][string][number];
export const releaseId = '00000000-0000-4000-8000-00000000b301';
export const albumId = '00000000-0000-4000-8000-00000000b302';
export const recordingId = '00000000-0000-4000-8000-00000000b304';
export const musicAddress: MusicReleaseAddress = { id: releaseId, context: candidateContext };
export type MusicReleaseExample =
  | 'admitted'
  | 'unconfigured'
  | 'tba'
  | 'empty'
  | 'continuation-unavailable'
  | 'concealed'
  | 'source-unavailable'
  | 'stream-unavailable';

/** Explicit example vocabulary, separate from producer publication and generated declarations. */
export function musicReleaseExample(scenario: MusicReleaseExample = 'admitted', locale = 'en') {
  const release: GuideRelease = { ...structuredClone(recordedRelease.release), digest: recordedRelease.digest };
  const summary = (id: string, type: string, label: string) => ({
    id,
    type,
    label: { value: label, language: 'en' },
    labels: { en: label },
    types: [type],
    creativeWork: true,
    cover: null,
  });
  const statement = (n: number, property: string, value: Statement['value']): Statement => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    property: {
      id: property,
      data_type: property === 'schema:datePublished' ? 'time' : 'wikibase-item',
    },
    value,
    rank: 'normal',
    qualifiers: [],
    references: [],
    rezics: { release: release.digest, revision: 1 },
  });
  const publicRead: SubjectRead = {
    subject: {
      id: releaseId,
      type: 'schema:MusicRelease',
      revision: 1,
      release: release.digest,
      context: candidateContext,
      labels: { en: 'Harbour sessions · Japan CD edition' },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:releaseOf': [statement(1, 'schema:releaseOf', { type: 'value', content: albumId })],
        'schema:datePublished': [
          statement(
            2,
            'schema:datePublished',
            scenario === 'tba'
              ? { type: 'somevalue' }
              : { type: 'value', content: { time: '+2024-05-00T00:00:00Z', precision: 10 } },
          ),
        ],
        'wdt:P437': [statement(3, 'wdt:P437', { type: 'value', content: '00000000-0000-4000-8000-00000000b306' })],
        'schema:contentLocation': [
          statement(4, 'schema:contentLocation', { type: 'value', content: '00000000-0000-4000-8000-00000000b305' }),
        ],
      },
      sourceRecords:
        scenario === 'source-unavailable'
          ? []
          : [{ name: 'Edition catalogue', url: 'https://example.test/catalogue', licence: { id: 'CC0-1.0' } }],
      relationCounts: {},
      resolution: {},
    },
    account: null,
    summary: null,
    related: {
      '00000000-0000-4000-8000-00000000b306': summary('00000000-0000-4000-8000-00000000b306', 'skos:Concept', 'CD'),
      '00000000-0000-4000-8000-00000000b309': summary(
        '00000000-0000-4000-8000-00000000b309',
        'skos:Concept',
        'lead vocals',
      ),
      [albumId]: summary(albumId, 'schema:MusicAlbum', 'Harbour sessions'),
      '00000000-0000-4000-8000-00000000b305': summary(
        '00000000-0000-4000-8000-00000000b305',
        'schema:Place',
        'Japan',
      ),
    },
  };
  const assertion = (n: number, property: string, target: string, position: string): Statement => ({
    ...statement(n, property, { type: 'value', content: target }),
    qualifiers: [
      {
        property: { id: 'schema:position', data_type: 'string' },
        value: { type: 'value' as const, content: position },
      },
      {
        property: { id: 'wdt:P1932', data_type: 'string' },
        value: { type: 'value' as const, content: 'Mina Kato' },
      },
      {
        property: { id: 'wdt:P3831', data_type: 'wikibase-item' },
        value: { type: 'value' as const, content: '00000000-0000-4000-8000-00000000b309' },
      },
      {
        property: { id: 'source:unknown', data_type: 'string' },
        value: { type: 'value' as const, content: 'provider-side-02?' },
      },
    ],
    references: [
      {
        hash: 'edition-reference',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value' as const, content: 'https://example.test/edition' },
          },
        ],
      },
    ],
  });
  const freshness = { consistency: 'eventual' as const, target_seconds: 10 as const, caught_up: true };
  const first: Forward = {
    relations:
      scenario === 'empty'
        ? []
        : [
            {
              statement: assertion(6, 'schema:track', recordingId, '1'),
              target: recordingId,
              external: null,
              summary:
                scenario === 'concealed' ? null : summary(recordingId, 'schema:MusicRecording', 'Harbour'),
              related: {
                '00000000-0000-4000-8000-00000000b309': {
                  type: 'skos:Concept',
                  label: { value: 'lead vocals', language: 'en' },
                },
              },
            },
            {
              statement: assertion(7, 'schema:track', recordingId, '3'),
              target: recordingId,
              external: null,
              summary: summary(recordingId, 'schema:MusicRecording', 'Harbour'),
              related: {},
            },
          ],
    freshness,
    next: scenario === 'empty' ? null : 'opaque:release/next',
  };
  const inverse: Links = {
    links: [
      {
        subject: recordingId,
        property: 'wdt:P361',
        statement: statement(8, 'wdt:P361', { type: 'value', content: releaseId }).id,
        assertion: assertion(8, 'wdt:P361', releaseId, 'A2'),
        summary: summary(recordingId, 'schema:MusicRecording', 'Harbour'),
        type: 'schema:MusicRecording',
        label: 'Harbour',
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  const last: Forward = { relations: [], freshness, next: null };
  if (scenario === 'unconfigured') delete release.types['schema:MusicRelease'];
  let response: Forward | Links | undefined;
  let status: number | undefined;
  let available = scenario !== 'continuation-unavailable';
  let unavailableStream = scenario === 'stream-unavailable' ? 'wdt:P361' : undefined;
  const calls: URL[] = [];
  const exampleFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url);
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
      if (url.pathname === `/v1/subjects/${releaseId}`) return json(publicRead);
      if (status) return json({}, status);
      if (
        url.pathname.endsWith('/links') &&
        unavailableStream &&
        url.searchParams.get('property') === unavailableStream
      )
        return json({}, 503);
      if (response) return json(response);
      if (url.pathname.endsWith('/links')) return json(inverse);
      if (url.searchParams.has('cursor')) return available ? json(last) : json({}, 503);
      return json(first);
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://release.example', { fetch: exampleFetch });
  return {
    release,
    publicRead,
    first,
    inverse,
    calls,
    client,
    read: (address = musicAddress) => readMusicRelease(client, release, address, locale),
    recover: () => {
      available = true;
      unavailableStream = undefined;
    },
    respond: (page: Forward | Links) => {
      response = page;
    },
    fail: (code: number) => {
      status = code;
    },
    failStream: (property: string) => {
      unavailableStream = property;
    },
  };
}
