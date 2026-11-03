import { createKernelClient, type KernelClient, type SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../../../subject/candidates';
import { readAlbumTracks, type AlbumTrackAddress } from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type Links = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Forward = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export const exampleAlbum = '00000000-0000-4000-8000-00000000a201';
export const exampleRecording = '00000000-0000-4000-8000-00000000a202';
export const exampleOtherRecording = '00000000-0000-4000-8000-00000000a203';
export const examplePart = '00000000-0000-4000-8000-00000000a204';
export const exampleAddress: AlbumTrackAddress = { id: exampleAlbum, context: candidateContext };
export type AlbumTrackExample = 'admitted' | 'unconfigured' | 'empty' | 'withheld' | 'continuation-unavailable';

/** Source examples supply a configured Release explicitly. They do not publish a native music vocabulary. */
export function albumTrackExample(scenario: AlbumTrackExample = 'admitted', locale = 'en') {
  const release = structuredClone(bundledRelease);
  release.types['schema:MusicRecording'] = {
    iri: 'https://schema.org/MusicRecording',
    labels: { en: 'recording' },
    mappings: [],
    bases: ['schema:CreativeWork'],
    properties: ['wdt:P361'],
    facets: [],
  };
  const property = release.properties['wdt:P361']!;
  property.qualifiers = ['schema:position', 'wdt:P518'];
  property.relation = { ...property.relation, group: 'membership', order: 'position', slotKey: 'wdt:P518' };
  const publicRead: SubjectRead = {
    subject: {
      id: exampleAlbum,
      type: 'schema:MusicAlbum',
      revision: 1,
      release: `sha256:${'0'.repeat(64)}`,
      context: candidateContext,
      labels: { en: 'Harbour sessions' },
      descriptions: {},
      aliases: {},
      statements: {},
      sourceRecords: [],
      relationCounts: {},
      resolution: {},
    },
    account: null,
    summary: null,
    related: {},
  };
  const assertion = (n: number, position: string): NonNullable<Links['links'][number]['assertion']> => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    rank: 'normal',
    property: { id: 'wdt:P361', data_type: 'wikibase-item' },
    value: { type: 'value', content: exampleAlbum },
    qualifiers: [
      { property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } },
      {
        property: { id: 'wdt:P518', data_type: 'wikibase-item' },
        value: { type: 'value', content: n === 3 ? exampleOtherRecording : examplePart },
      },
      { property: { id: 'source:unknownPosition', data_type: 'string' }, value: { type: 'value', content: 'A-02?' } },
    ],
    rezics: { release: publicRead.subject.release, revision: 1 },
    references: [
      {
        hash: 'album-example-reference',
        parts: [
          {
            property: { id: 'schema:datePublished', data_type: 'time' },
            value: { type: 'value', content: { time: '+2024-00-00T00:00:00Z', precision: 9 } },
          },
        ],
      },
    ],
  });
  const native = (holder: string, n: number, position: string): Links['links'][number] => ({
    subject: holder,
    property: 'wdt:P361',
    statement: assertion(n, position).id,
    assertion: assertion(n, position),
    type: 'schema:MusicRecording',
    label: 'Harbour',
    summary: {
      id: holder,
      type: 'schema:MusicRecording',
      label: { value: 'Harbour', language: 'en' },
      types: ['schema:MusicRecording', 'schema:CreativeWork'],
      creativeWork: true,
      cover: null,
    },
    related: {
      [examplePart]: {
        id: examplePart,
        type: 'schema:CreativeWork',
        types: ['schema:CreativeWork'],
        creativeWork: true,
        cover: null,
        label: { value: 'Disc qualifier as supplied', language: 'en' },
      },
    },
  });
  const first: Links = {
    links:
      scenario === 'empty'
        ? []
        : [native(exampleRecording, 1, '2'), native(exampleOtherRecording, 2, '1'), native(exampleRecording, 3, '1')],
    count: { value: 4, exact: false },
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: false },
    next: 'opaque:album/next',
  };
  const last: Links = {
    links: [native(exampleOtherRecording, 4, '3')],
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
    next: null,
  };
  const calls: URL[] = [];
  let continuationAvailable = scenario !== 'continuation-unavailable';
  let response: Links | Forward | undefined;
  let status: number | undefined;
  if (scenario === 'unconfigured') delete release.types['schema:MusicAlbum'];
  const exampleFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push(url);
      const json = (data: unknown, code = 200) =>
        new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
      if (url.pathname === `/v1/subjects/${exampleAlbum}`) return json(publicRead);
      if (url.pathname.endsWith('/links') || url.pathname.endsWith('/relations')) {
        if (scenario === 'withheld') return json({}, 403);
        if (status !== undefined) return json({}, status);
        if (response) return json(response);
        if (url.searchParams.has('cursor')) return continuationAvailable ? json(last) : json({}, 503);
        return json(first);
      }
      return json({}, 404);
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://album.example', { fetch: exampleFetch });
  return {
    release,
    first,
    last,
    client,
    calls,
    publicRead,
    read: (address = exampleAddress) => readAlbumTracks(client, release, address, locale),
    recover: () => {
      continuationAvailable = true;
    },
    respond: (page: Links | Forward) => {
      response = page;
    },
    fail: (code: number) => {
      status = code;
    },
  };
}
