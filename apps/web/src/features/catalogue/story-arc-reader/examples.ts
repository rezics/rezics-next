import { createKernelClient, type KernelClient, type SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../../../subject/candidates';
import { readArc, type ArcAddress } from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type Forward = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type Links = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Statement = Forward['relations'][number]['statement'];
export const arcId = '00000000-0000-4000-8000-00000000a301';
export const workId = '00000000-0000-4000-8000-00000000a302';
export const otherWorkId = '00000000-0000-4000-8000-00000000a303';
export const characterId = '00000000-0000-4000-8000-00000000a304';
export const arcAddress: ArcAddress = { id: arcId, context: candidateContext };
export type ArcExample = 'admitted' | 'unsupported' | 'continuation-unavailable';

/** Authored native-operation examples; these do not assert native publication or browser acceptance. */
export function arcExample(scenario: ArcExample = 'admitted', locale = 'en') {
  const release = structuredClone(bundledRelease);
  // These authored examples explicitly admit spoiler-qualified narrative/membership assertions.
  release.properties['rezics:storyArc']!.qualifiers.push('rezics:spoilerLevel');
  release.properties['rezics:sideStoryOf']!.qualifiers.push('rezics:spoilerLevel');
  if (scenario === 'unsupported') delete release.types['wd:Q2620972'];
  const summary = (
    id: string,
    label: string,
    type = 'wd:Q689445',
  ): NonNullable<Forward['relations'][number]['summary']> => ({
    id,
    type,
    label: { value: label, language: 'en' },
    types: [type, 'schema:CreativeWork'],
    creativeWork: true,
    cover: null,
  });
  const statement = (n: number, property: string, target: string, position: string, spoiler = false): Statement => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: (
      [
        { property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } },
        { property: { id: 'rezics:firstPart', data_type: 'string' }, value: { type: 'value', content: '03a' } },
        { property: { id: 'rezics:lastPart', data_type: 'string' }, value: { type: 'somevalue' } },
        ...(spoiler
          ? [
              {
                property: { id: 'rezics:spoilerLevel', data_type: 'quantity' as const },
                value: { type: 'value' as const, content: { amount: '2', unit: '1' } },
              },
            ]
          : []),
      ] satisfies Statement['qualifiers']
    ).filter((snak) => release.properties[property]!.qualifiers.includes(snak.property.id)),
    references: [
      {
        hash: 'arc-source',
        parts: [
          {
            property: { id: 'schema:datePublished', data_type: 'time' },
            value: { type: 'value', content: { time: '+2024-00-00T00:00:00Z', precision: 9 } },
          },
          {
            property: { id: 'rezics:note', data_type: 'monolingualtext' },
            value: { type: 'value', content: { text: '原典の範囲', language: 'ja' } },
          },
        ],
      },
    ],
    rezics: { release: `sha256:${'0'.repeat(64)}`, revision: 1 },
  });
  const link = (id: string, n: number, position: string, spoiler = false): Links['links'][number] => {
    const assertion = statement(n, 'rezics:storyArc', arcId, position, spoiler);
    return {
      subject: id,
      property: 'rezics:storyArc',
      statement: assertion.id,
      assertion,
      type: 'wd:Q689445',
      label: id === workId ? 'Later title' : 'Earlier title',
      summary: summary(id, id === workId ? 'Later title' : 'Earlier title'),
      related: {},
    };
  };
  const freshness = { consistency: 'eventual' as const, target_seconds: 10 as const, caught_up: true };
  const first: Links = {
    links: [link(workId, 1, '2'), link(otherWorkId, 2, '1', true)],
    freshness,
    count: { value: 3, exact: false },
    next: 'opaque:arc-next',
  };
  const last: Links = { links: [link(workId, 3, '3')], freshness, next: null };
  const appearance = statement(4, 'schema:character', characterId, '1', true);
  appearance.qualifiers.push({
    property: { id: 'wdt:P518', data_type: 'wikibase-item' },
    value: { type: 'value', content: arcId },
  });
  const appearances: Forward = {
    relations: [
      {
        statement: appearance,
        target: characterId,
        external: null,
        summary: summary(characterId, 'Secret character', 'wd:Q95074'),
        related: {
          [arcId]: summary(arcId, 'Harbour arc', 'wd:Q2620972')!,
        },
      },
    ],
    freshness,
    next: null,
  };
  const sequence: Forward = {
    relations: [
      {
        statement: statement(5, 'rezics:sideStoryOf', otherWorkId, '4', true),
        target: otherWorkId,
        external: null,
        summary: summary(otherWorkId, 'Hidden narrative place', 'wd:Q2620972'),
        related: {},
      },
    ],
    freshness,
    next: null,
  };
  const publicRead = (id: string): SubjectRead => ({
    subject: {
      id,
      type: id === arcId ? 'wd:Q2620972' : 'wd:Q689445',
      context: candidateContext,
      labels: { en: id === arcId ? 'Harbour arc' : 'Later title' },
      descriptions: {},
      aliases: {},
      statements: {},
      relationCounts: {},
      resolution: {},
      sourceRecords: [],
      revision: 1,
      release: `sha256:${'0'.repeat(64)}`,
    },
    account: null,
    summary: null,
    related: {},
  });
  let continuationAvailable = scenario !== 'continuation-unavailable';
  let override: Links | Forward | undefined;
  let failure: number | undefined;
  const calls: URL[] = [];
  const exampleFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/links') || url.pathname.endsWith('/relations')) {
        if (failure !== undefined) return json({}, failure);
        if (override) return json(override);
        if (url.searchParams.get('property') === 'schema:character') return json(appearances);
        if (url.searchParams.get('property') === 'rezics:sideStoryOf') return json(sequence);
        if (url.pathname.endsWith('/relations')) {
          const assertion = statement(6, 'rezics:storyArc', arcId, '2');
          return json({
            relations: [
              {
                statement: assertion,
                target: arcId,
                external: null,
                summary: summary(arcId, 'Harbour arc', 'wd:Q2620972'),
                related: {},
              },
            ],
            freshness,
            next: null,
          });
        }
        return url.searchParams.has('cursor') ? (continuationAvailable ? json(last) : json({}, 503)) : json(first);
      }
      return json(publicRead(url.pathname.split('/').at(-1)!));
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://arc.example', { fetch: exampleFetch });
  return {
    release,
    client,
    calls,
    first,
    last,
    appearances,
    sequence,
    read: (address = arcAddress) => readArc(client, release, address, locale),
    recover: () => {
      continuationAvailable = true;
    },
    respond: (page: Links | Forward) => {
      override = page;
    },
    fail: (status: number) => {
      failure = status;
    },
  };
}
