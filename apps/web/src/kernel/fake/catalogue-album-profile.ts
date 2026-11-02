import { createKernelClient, type SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import {
  createAlbum,
  readAlbumProfile,
  type AlbumItem,
  type AlbumTransport,
} from '../../features/catalogue/album-profile';
import type { AlbumEditors } from '../../features/catalogue/album-profile-view';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { readStatementEditor, type StatementInput } from '../../features/catalogue/statement-editor';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import { confirmRelation, proposeRelation, readRelationEditor } from '../../subject/relation-candidates';
import { relationDescriptorReader } from './relation-descriptor';
import definitions from '../recorded/definitions-release.json';

export const albumId = '00000000-0000-4000-8000-00000000a101';
export const artistId = '00000000-0000-4000-8000-00000000a102';
export const roleId = '00000000-0000-4000-8000-00000000a103';
export const seriesId = '00000000-0000-4000-8000-00000000a104';
export const partId = '00000000-0000-4000-8000-00000000a105';
export type AlbumScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'stale-metadata'
  | 'unavailable'
  | 'uncertain'
  | 'concealed'
  | 'reader-unavailable';

const citation: StatementInput['references'] = [
  { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://artist.example/harbour' } }] },
];
export function albumExample(): AlbumItem {
  const statement = (
    property: string,
    content: unknown,
    qualifiers: StatementInput['qualifiers'] = [],
  ): StatementInput => ({
    property: { id: property },
    value: { type: 'value', content },
    qualifiers,
    references: structuredClone(citation),
    rank: 'normal',
  });
  return {
    type: 'schema:MusicAlbum',
    labels: { en: 'Harbour sessions' },
    descriptions: {},
    aliases: { en: ['Harbour demos'] },
    statements: {
      'schema:datePublished': [
        statement('schema:datePublished', {
          time: '+2024-00-00T00:00:00Z',
          precision: 9,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        }),
      ],
      'schema:contributor': [
        statement('schema:contributor', artistId, [
          { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'The Harbour Ensemble' } },
          { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
          { property: { id: 'wdt:P3831' }, value: { type: 'value', content: roleId } },
          { property: { id: 'wdt:P518' }, value: { type: 'value', content: partId } },
        ]),
      ],
      'wdt:P179': [
        statement('wdt:P179', seriesId, [
          { property: { id: 'schema:position' }, value: { type: 'value', content: '2' } },
        ]),
      ],
      'wdt:P361': [statement('wdt:P361', partId)],
    },
  };
}

/** Explicit story examples exercising the existing generated client; never installed as a native producer. */
export function albumFixture(scenario: AlbumScenario = 'ready', locale = 'en') {
  const release = structuredClone(definitions.release) as Release;
  if (scenario === 'empty') delete release.types['schema:MusicAlbum'];
  let active = scenario;
  let digest: string = definitions.digest;
  let lost = false;
  let revision = 1;
  const receipts = new Map<string, unknown>();
  const candidates = new Map<string, Candidate>();
  const calls: {
    method: string;
    path: string;
    query: string;
    body: unknown;
    key: string | null;
    authorization: string | null;
    session: string | null;
  }[] = [];
  const publicRead: SubjectRead = {
    subject: {
      id: albumId,
      type: 'schema:MusicAlbum',
      revision,
      release: definitions.digest,
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
    related: {
      [artistId]: { type: 'schema:Organization', labels: { en: 'The Harbour Ensemble' } },
      [roleId]: { type: 'skos:Concept', labels: { en: 'Performer' } },
      [seriesId]: { type: 'wd:Q7725310', labels: { en: 'Harbour concerts' } },
      [partId]: { type: 'wd:Q2620972', labels: { en: 'Harbour story arc' } },
    },
  };
  function selected(input: StatementInput): SubjectRead['subject']['statements'][string][number] {
    const snak = (part: Pick<StatementInput, 'property' | 'value'>) => ({
      property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
      value: structuredClone(part.value),
    });
    return {
      ...snak(input),
      id: crypto.randomUUID(),
      rank: 'normal',
      qualifiers: (input.qualifiers ?? []).map(snak),
      references: input.references.map(({ parts }) => ({ parts: parts.map(snak), hash: 'example-reference' })),
      rezics: { release: definitions.digest, revision },
    };
  }
  function seed(item: AlbumItem) {
    Object.assign(publicRead.subject, {
      labels: structuredClone(item.labels),
      descriptions: structuredClone(item.descriptions ?? {}),
      aliases: structuredClone(item.aliases ?? {}),
      statements: Object.fromEntries(Object.entries(item.statements).map(([id, values]) => [id, values.map(selected)])),
    });
  }
  seed(albumExample());
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'album-session' },
    });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({
        method: request.method,
        path,
        query: url.search,
        body,
        key,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (path === '/v1/definitions/active') {
        if (active === 'loading') return new Promise<Response>(() => {});
        return active === 'unavailable' ? json({ code: 'semantic_not_ready' }, 503) : json({ digest });
      }
      if (path === `/v1/definitions/releases/${encodeURIComponent(digest)}`)
        return json({ ...definitions, digest, release });
      if (path === `/v1/subjects/${albumId}` && request.method === 'GET') {
        if (active === 'concealed') return json({ code: 'not_found' }, 404);
        return active === 'reader-unavailable' ? json({ code: 'semantic_not_ready' }, 503) : json(publicRead);
      }
      if (request.method === 'POST') {
        if (active === 'denied') return json({ code: 'forbidden' }, 403);
        if (active === 'conflict') return json({ code: 'idempotency_conflict' }, 409);
        if (active === 'invalid' || active === 'stale-metadata') {
          if (active === 'stale-metadata') {
            release.types['schema:MusicAlbum']!.properties = release.types['schema:MusicAlbum']!.properties.filter(
              (id) => id !== 'schema:datePublished',
            );
            digest = 'sha256:' + 'a'.repeat(64);
          }
          return json(
            { code: 'invalid_request', errors: [{ pointer: '/statements/schema:datePublished', code: 'unsupported' }] },
            400,
          );
        }
        if (receipts.has(key!)) return json(receipts.get(key!), 201);
        if (path === '/v1/subjects') {
          seed(body as AlbumItem);
          receipts.set(key!, { subject: structuredClone(publicRead.subject) });
        } else if (path === `/v1/subjects/${albumId}/candidates`) {
          const statement = selected((body as { statement: StatementInput }).statement);
          candidates.set(statement.id, {
            id: statement.id,
            statement,
            revision: ++revision,
            release: definitions.digest,
            source: null,
            retracted: null,
            retraction: null,
            decision: null,
            head: null,
            rank: null,
          });
          receipts.set(key!, { candidate: statement.id, revision });
        } else return json({ code: 'not_found' }, 404);
        if (active === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(receipts.get(key!), 201);
      }
      if (path.endsWith('/candidates'))
        return json({
          candidates: [...candidates.values()].filter(
            (candidate) =>
              candidate.statement.property.id === url.searchParams.get('property') &&
              (!url.searchParams.has('target') ||
                (candidate.statement.value.type === 'value' &&
                  candidate.statement.value.content === url.searchParams.get('target'))),
          ),
          next: null,
          adoption: null,
        });
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const transport: AlbumTransport = {
    load: () => readAlbumProfile(client),
    create: (command) =>
      createAlbum(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  const editors: AlbumEditors = {
    facts: {
      read: () => readStatementEditor(client, { id: albumId }),
      propose: (command) => proposeFact(client, 'Bearer fixture', command),
    },
    review: (property) => ({
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_property, cursor, session) => {
        const result = await readCandidates(client, 'Bearer fixture', albumId, property, cursor, undefined, session);
        return result.ok
          ? {
              ...result,
              fields: [
                {
                  id: property,
                  label: pickText(release.properties[property]!.labels, locale).text,
                  multivalued: release.properties[property]!.multivalued,
                },
              ],
              names: Object.fromEntries(
                Object.entries(release.properties).map(([id, property]) => [id, property.labels]),
              ),
            }
          : result;
      },
      confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
    }),
    relations: {
      read: (slot, cursor, session) =>
        readRelationEditor(
          client,
          'Bearer fixture',
          relationDescriptorReader(release),
          albumId,
          locale,
          slot,
          cursor,
          session,
        ),
      propose: (command) => proposeRelation(client, 'Bearer fixture', relationDescriptorReader(release), command),
      confirm: (command) => confirmRelation(client, 'Bearer fixture', command),
    },
  };
  return {
    client,
    transport,
    editors,
    release,
    publicRead,
    calls,
    receipts,
    candidates,
    setScenario: (next: AlbumScenario) => {
      active = next;
    },
    loadCorrection: () => readAlbumProfile(client, albumId),
  };
}
