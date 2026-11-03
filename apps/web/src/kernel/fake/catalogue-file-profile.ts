import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { candidateContext } from '../../subject/candidates';
import { readCatalogueFileProfile } from '../../features/catalogue/catalogue-file-profile/read';
import { RELEASE_ASSOCIATION_LIMIT } from '../../features/catalogue/release-fidelity/model';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { withConcreteReleaseDescriptors } from './release-fidelity';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';

export const catalogueFile = '00000000-0000-4000-8000-00000000a201';
export const catalogueFileTwo = '00000000-0000-4000-8000-00000000a202';
export const catalogueEpisode = '00000000-0000-4000-8000-00000000a203';
export const catalogueGroup = '00000000-0000-4000-8000-00000000a204';
export const catalogueRelease = '00000000-0000-4000-8000-00000000a101';

export type CatalogueFileScenario =
  | 'ready'
  | 'unreleased'
  | 'concealed-episode'
  | 'unknown-codec'
  | 'stale'
  | 'denied'
  | 'unavailable';

function statement(
  id: string,
  property: string,
  datatype: string,
  value: SubjectRead['subject']['statements'][string][number]['value'],
  digest: string,
): SubjectRead['subject']['statements'][string][number] {
  return {
    id,
    rank: 'normal',
    property: { id: property, data_type: datatype as never },
    value,
    qualifiers: [],
    references: [],
    rezics: { release: digest, revision: 1 },
  };
}

export function catalogueFileProfileFixture(scenario: CatalogueFileScenario = 'ready', locale = 'en', population = 2) {
  const digest = definitions.digest;
  const release = withConcreteReleaseDescriptors(definitions.release as Release, scenario !== 'unreleased');
  let active = scenario;
  const calls: { method: string; path: string; query: string; authorization: string | null; session: string | null }[] =
    [];
  const receipts = new Map<string, unknown>();
  const publicRead: SubjectRead = {
    subject: {
      id: catalogueFile,
      type: scenario === 'unreleased' ? 'schema:Book' : 'schema:MediaObject',
      revision: 1,
      release: digest,
      context: candidateContext,
      labels: { en: 'Episode 1 file A' },
      descriptions: {},
      aliases: {},
      statements:
        scenario === 'unreleased'
          ? {}
          : {
              'schema:sha256': [
                statement(
                  '00000000-0000-4000-8000-00000000a211',
                  'schema:sha256',
                  'string',
                  { type: 'value', content: 'abc123def456' },
                  digest,
                ),
              ],
              'schema:encodingFormat': [
                statement(
                  '00000000-0000-4000-8000-00000000a212',
                  'schema:encodingFormat',
                  'string',
                  { type: 'value', content: scenario === 'unknown-codec' ? 'av1' : 'h264' },
                  digest,
                ),
              ],
              'schema:contentSize': [
                statement(
                  '00000000-0000-4000-8000-00000000a213',
                  'schema:contentSize',
                  'quantity',
                  { type: 'value', content: { amount: '123456789', unit: 'wd:Q11573' } },
                  digest,
                ),
              ],
              'schema:inLanguage': [
                statement(
                  '00000000-0000-4000-8000-00000000a214',
                  'schema:inLanguage',
                  'string',
                  { type: 'value', content: 'ja' },
                  digest,
                ),
              ],
              'schema:encodesCreativeWork': [
                statement(
                  '00000000-0000-4000-8000-00000000a215',
                  'schema:encodesCreativeWork',
                  'wikibase-item',
                  { type: 'value', content: catalogueEpisode },
                  digest,
                ),
              ],
              'rezics:releaseGroup': [
                statement(
                  '00000000-0000-4000-8000-00000000a216',
                  'rezics:releaseGroup',
                  'wikibase-item',
                  { type: 'value', content: catalogueGroup },
                  digest,
                ),
              ],
              'schema:author': [
                statement(
                  '00000000-0000-4000-8000-00000000a217',
                  'schema:author',
                  'wikibase-item',
                  { type: 'value', content: '00000000-0000-4000-8000-00000000a218' },
                  digest,
                ),
              ],
            },
      resolution: {},
      relationCounts: {},
      sourceRecords: [{ name: 'File list', url: 'https://catalogue.example/file' }],
    },
    related: {
      [catalogueEpisode]: {
        type: 'schema:Episode',
        labels: scenario === 'concealed-episode' ? {} : { en: 'Episode 1' },
      },
      [catalogueGroup]: { type: 'rezics:ReleaseGroup', labels: { en: 'Example Fansub' } },
      'wd:Q11573': { type: 'schema:Thing', labels: { en: 'byte' } },
    },
    account: null,
    summary: null,
  };
  const fileId = (index: number) =>
    index === 0
      ? catalogueFile
      : index === 1
        ? catalogueFileTwo
        : `00000000-0000-4000-8000-${(0xa201 + index).toString(16).padStart(12, '0')}`;
  function relationPage(property: string, cursor?: string | null) {
    const start = cursor ? Number(cursor) : 0;
    const count = Math.min(RELEASE_ASSOCIATION_LIMIT, Math.max(0, population - start));
    const relations = Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const id = fileId(index);
      const episode = property === 'schema:encodesCreativeWork';
      const target = episode ? catalogueEpisode : id;
      const concealed = episode ? scenario === 'concealed-episode' : index % 11 === 10;
      const label = concealed
        ? undefined
        : { value: episode ? 'Episode 1' : index === 1 ? 'Episode 1 file B' : `File ${index}`, language: 'en' };
      const type = episode ? 'schema:Episode' : 'schema:MediaObject';
      return {
        statement: statement(
          `00000000-0000-4000-8000-${(0xa300 + index).toString(16).padStart(12, '0')}`,
          property,
          'wikibase-item',
          { type: 'value', content: target },
          digest,
        ),
        summary: {
          id: target,
          type,
          types: [type],
          label,
          creativeWork: true,
          cover: null,
        },
        related: {
          [target]: {
            type,
            types: [type],
            label,
          },
        },
      };
    });
    return {
      relations,
      next: start + count < population ? String(start + count) : null,
      count: { value: population, exact: true },
    };
  }
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'rezics-session-token': 'file-session' } });
  const client = createKernelClient('https://catalogue-file.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (active === 'denied') return json({}, 403);
      if (active === 'unavailable') return json({}, 503);
      if (url.pathname.startsWith('/v1/definitions/releases/')) {
        if (active === 'stale') return json({ digest: 'sha256:changed', release });
        return json({ digest, release });
      }
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${catalogueFile}`) {
        if (active === 'stale')
          return json({ ...publicRead, subject: { ...publicRead.subject, id: catalogueFileTwo } });
        return json(publicRead);
      }
      if (url.pathname === `/v1/subjects/${catalogueFile}/relations` && request.method === 'GET')
        return json(relationPage(url.searchParams.get('property') ?? '', url.searchParams.get('cursor')));
      if (url.pathname === `/v1/subjects/${catalogueEpisode}/links` && request.method === 'GET') {
        const start = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
        const rows = [catalogueFile, catalogueFileTwo].slice(start, start + RELEASE_ASSOCIATION_LIMIT);
        return json({
          links: rows.map((id, index) => ({
            subject: id,
            property: 'schema:encodesCreativeWork',
            statement: `00000000-0000-4000-8000-${(0xa400 + index).toString(16).padStart(12, '0')}`,
            assertion: statement(
              `00000000-0000-4000-8000-${(0xa400 + index).toString(16).padStart(12, '0')}`,
              'schema:encodesCreativeWork',
              'wikibase-item',
              { type: 'value', content: catalogueEpisode },
              digest,
            ),
            related: {
              [id]: {
                type: 'schema:MediaObject',
                types: ['schema:MediaObject'],
                label: { value: id === catalogueFileTwo ? 'Episode 1 file B' : 'Episode 1 file A', language: 'en' },
              },
            },
            summary: {
              id,
              type: 'schema:MediaObject',
              types: ['schema:MediaObject'],
              label: { value: id === catalogueFileTwo ? 'Episode 1 file B' : 'Episode 1 file A', language: 'en' },
              creativeWork: true,
              cover: null,
            },
            type: 'schema:MediaObject',
            label: id === catalogueFileTwo ? 'Episode 1 file B' : 'Episode 1 file A',
          })),
          next: null,
          count: { value: 2, exact: true },
        });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/subjects/')) {
        const id = url.pathname.split('/')[3]!;
        return json({
          subject: {
            ...structuredClone(publicRead.subject),
            id,
            type:
              id === catalogueEpisode
                ? 'schema:Episode'
                : id === catalogueGroup
                  ? 'rezics:ReleaseGroup'
                  : 'schema:MediaObject',
            labels: {
              en:
                id === catalogueEpisode
                  ? 'Episode 1'
                  : id === catalogueFileTwo
                    ? 'Episode 1 file B'
                    : id === catalogueRelease
                      ? 'Japanese paperback'
                      : 'Related file',
            },
            statements: {},
          },
          related: {},
          account: null,
          summary: null,
        });
      }
      if (url.pathname === `/v1/subjects/${catalogueFile}/candidates` && request.method === 'POST') {
        const key = request.headers.get('idempotency-key');
        if (key && receipts.has(key)) return json(receipts.get(key), 201);
        if (active === 'stale') return json({ code: 'stale_editorial_head' }, 409);
        const result = { candidate: '00000000-0000-4000-8000-00000000a299', revision: 2 };
        if (key) receipts.set(key, result);
        return json(result, 201);
      }
      return json({}, 404);
    }) as typeof fetch,
  });
  return {
    client,
    release,
    digest,
    publicRead,
    calls,
    receipts,
    population,
    setScenario: (value: CatalogueFileScenario) => {
      active = value;
    },
    read: (stream?: string, cursor?: string, detail?: string, session?: string) =>
      readCatalogueFileProfile(client, 'Bearer contributor', {
        id: catalogueFile,
        locale,
        stream,
        cursor,
        detail,
        session,
      }),
    propose: (command: Parameters<typeof proposeFact>[2]) => proposeFact(client, 'Bearer contributor', command),
  };
}

export const routes: FakeRoute[] = [];
