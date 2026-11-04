import { createKernelClient, type KernelClient, type SubjectRead, type WorkReleaseCards } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../../../subject/candidates';
import { readGameReader, editionProperty, type GameStatement, type GameReaderAddress } from './model';

type Endpoint = ReturnType<KernelClient['subjects']>;
type Links = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']> & {
  workReleaseCards?: WorkReleaseCards;
};
export const gameId = '00000000-0000-4000-8000-00000000c301';
export const editionId = '00000000-0000-4000-8000-00000000c302';
const platformId = '00000000-0000-4000-8000-00000000c303';
const engineId = '00000000-0000-4000-8000-00000000c304';
const personId = '00000000-0000-4000-8000-00000000c305';
export const gameAddress: GameReaderAddress = { id: gameId, context: candidateContext, type: 'schema:VideoGame' };
export type GameExample = 'work' | 'visual-novel' | 'tba' | 'empty' | 'unconfigured' | 'continuation-unavailable';

/** Examples consume the bundled vocabulary unchanged; they do not publish provider or domain configuration. */
export function gameExample(scenario: GameExample = 'work', locale = 'en') {
  const release = { ...structuredClone(bundledRelease), digest: `sha256:${'1'.repeat(64)}` };
  const address = { ...gameAddress, type: scenario === 'visual-novel' ? 'wd:Q689445' : gameAddress.type };
  if (scenario === 'unconfigured') delete release.types[address.type];
  const statement = (
    n: number,
    property: string,
    data_type: GameStatement['property']['data_type'],
    value: GameStatement['value'],
  ): GameStatement => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    property: { id: property, data_type },
    value,
    rank: 'normal',
    qualifiers: [],
    references: [],
    rezics: { release: release.digest, revision: 1 },
  });
  const platform = statement(1, 'schema:gamePlatform', 'wikibase-item', { type: 'value', content: platformId });
  platform.qualifiers.push({
    property: { id: 'schema:inLanguage', data_type: 'string' },
    value: { type: 'value', content: 'ja' },
  });
  const credit = statement(4, 'wdt:P178', 'wikibase-item', { type: 'value', content: personId });
  credit.qualifiers.push({
    property: { id: 'wdt:P1932', data_type: 'string' },
    value: { type: 'value', content: 'Harbour Studio' },
  });
  credit.references.push({
    hash: 'game-credit',
    parts: [
      {
        property: { id: 'schema:url', data_type: 'url' },
        value: { type: 'value', content: 'https://example.test/game/credits' },
      },
    ],
  });
  const publicRead: SubjectRead = {
    subject: {
      id: gameId,
      type: address.type,
      revision: 1,
      release: release.digest,
      context: candidateContext,
      labels: { en: 'Harbour game' },
      descriptions: {},
      aliases: {},
      statements:
        scenario === 'empty'
          ? {}
          : {
              'schema:gamePlatform': [platform],
              'wdt:P408': [statement(2, 'wdt:P408', 'wikibase-item', { type: 'value', content: engineId })],
              'schema:datePublished': [
                statement(
                  3,
                  'schema:datePublished',
                  'time',
                  scenario === 'tba'
                    ? { type: 'somevalue' }
                    : { type: 'value', content: { time: '+2024-05-00T00:00:00Z', precision: 10 } },
                ),
              ],
              'wdt:P178': [credit],
            },
      sourceRecords: [
        { name: 'Game catalogue · source:status-02?', url: 'https://example.test/game', licence: { id: 'CC0-1.0' } },
      ],
      relationCounts: {},
      resolution: {},
    },
    account: null,
    summary: null,
    related: {
      [platformId]: { type: 'skos:Concept', labels: { en: 'Windows' } },
      [engineId]: { type: 'skos:Concept', labels: { en: 'Source engine' } },
      [personId]: { type: 'schema:Organization', labels: { en: 'Harbour Studio Ltd' } },
    },
  };
  const association = statement(5, editionProperty, 'wikibase-item', { type: 'value', content: gameId });
  association.qualifiers.push({
    property: { id: 'source:version', data_type: 'string' },
    value: { type: 'value', content: 'Trial 0.8 · ja / Windows' },
  });
  const freshness = { consistency: 'eventual' as const, target_seconds: 10 as const, caught_up: true };
  const first: Links = {
    links:
      scenario === 'empty'
        ? []
        : [
            {
              subject: editionId,
              type: 'wd:Q20631656',
              label: 'Harbour trial · Japanese Windows',
              property: editionProperty,
              statement: association.id,
              assertion: association,
              summary: {
                id: editionId,
                type: 'wd:Q20631656',
                label: { language: 'en', value: 'Harbour trial · Japanese Windows' },
                types: ['wd:Q20631656'],
                creativeWork: true,
                cover: null,
              },
              related: {},
            },
          ],
    freshness,
    next: scenario === 'empty' ? null : 'opaque:game/next',
  };
  const last: Links = { links: [], freshness, next: null };
  const calls: string[] = [];
  let status = 200;
  let available = scenario !== 'continuation-unavailable';
  let response: Links | undefined;
  const json = (data: unknown, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
  const exampleFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.href);
      if (status !== 200) return json({}, status);
      if (!url.pathname.endsWith('/links')) return json(publicRead);
      if (response) return json(response);
      if (url.searchParams.has('cursor')) return available ? json(last) : json({}, 503);
      return json(first);
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://game.example', { fetch: exampleFetch });
  return {
    address,
    release,
    publicRead,
    first,
    last,
    calls,
    client,
    read: (request = address) => readGameReader(client, release, request, locale),
    recover: () => {
      available = true;
    },
    respond: (page: Links) => {
      response = page;
    },
    fail: (code: number) => {
      status = code;
    },
  };
}
