import { createKernelClient, type SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { createGameProfile, readGameProfile, type GameItem } from '../../features/catalogue/game-profile';
import type { GameProfileTransport } from '../../features/catalogue/game-profile-view';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { readStatementEditor, type StatementInput } from '../../features/catalogue/statement-editor';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import { readRelationEditor, proposeRelation, confirmRelation } from '../../subject/relation-candidates';
import { relationDescriptorReader } from './relation-descriptor';
import type { CandidateTransport } from '../../subject/candidate-review';
import definitions from '../recorded/definitions-release.json';

export const gameId = '00000000-0000-4000-8000-00000000f101';
export const gameCreatorId = '00000000-0000-4000-8000-00000000f102';
export const gamePlatformId = '00000000-0000-4000-8000-00000000f103';
export const gameWorkId = '00000000-0000-4000-8000-00000000f104';
export type GameScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'conflict'
  | 'unavailable'
  | 'uncertain'
  | 'reader-unavailable'
  | 'concealed';
export function gameStatement(property: string, content: unknown): StatementInput {
  return {
    property: { id: property },
    value: { type: 'value', content },
    rank: 'normal',
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/game-notes' } },
        ],
      },
    ],
  };
}
export function gameExample(type = 'schema:VideoGame'): GameItem {
  const platform = gameStatement('schema:gamePlatform', gamePlatformId);
  platform.qualifiers = [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }];
  const statements: GameItem['statements'] = {
    'schema:author': [gameStatement('schema:author', gameCreatorId)],
    'schema:inLanguage': [gameStatement('schema:inLanguage', 'ja'), gameStatement('schema:inLanguage', 'en')],
  };
  if (type !== 'wd:Q689445') statements['schema:gamePlatform'] = [platform];
  if (type === 'wd:Q20631656') statements['schema:exampleOfWork'] = [gameStatement('schema:exampleOfWork', gameWorkId)];
  if (type === 'wd:Q209163') statements['wdt:P8646'] = [gameStatement('wdt:P8646', gameWorkId)];
  return { type, labels: { en: 'The Lantern Game', ja: '灯りのゲーム' }, descriptions: {}, aliases: {}, statements };
}
/** Declared native-shaped examples only. The ordinary route never uses this fixture. */
export function gameProfileFixture(
  scenario: GameScenario = 'ready',
  locale = 'en',
  correction = false,
  type = 'schema:VideoGame',
) {
  const release = structuredClone(definitions.release) as Release;
  if (scenario === 'empty')
    for (const id of ['schema:VideoGame', 'wd:Q689445', 'wd:Q209163', 'wd:Q20631656']) delete release.types[id];
  let active = scenario;
  let lost = false;
  const candidates = new Map<string, Candidate>();
  const receipts = new Map<string, unknown>();
  const calls: { method: string; path: string; body: unknown; key: string | null; authorization: string | null }[] = [];
  const publicRead: SubjectRead = {
    subject: {
      id: gameId,
      type,
      revision: 1,
      release: definitions.digest,
      context: candidateContext,
      labels: { en: 'The Lantern Game', ja: '灯りのゲーム' },
      descriptions: {},
      aliases: {},
      statements: {},
      relationCounts: {},
      resolution: {},
      sourceRecords: [],
    },
    account: null,
    summary: null,
    related: {
      [gameCreatorId]: { type: 'schema:Person', labels: { en: 'Example writer' } },
      [gamePlatformId]: { type: 'skos:Concept', labels: { en: 'Example platform' } },
      [gameWorkId]: { type: 'schema:VideoGame', labels: { en: 'The Lantern Work' } },
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
      references: input.references.map((reference) => ({ hash: 'example-citation', parts: reference.parts.map(snak) })),
      rezics: { release: definitions.digest, revision: 1 },
    };
  }
  if (correction)
    publicRead.subject.statements = Object.fromEntries(
      Object.entries(gameExample(type).statements).map(([id, statements]) => [id, statements.map(selected)]),
    );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'game-session' },
    });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({ method: request.method, path, body, key, authorization: request.headers.get('authorization') });
      if (path === '/v1/definitions/active') {
        if (active === 'loading') return new Promise<Response>(() => {});
        if (active === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
        return json({ digest: definitions.digest });
      }
      if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`)
        return json({ digest: definitions.digest, release });
      if (path === `/v1/subjects/${gameId}` && request.method === 'GET') {
        if (active === 'concealed') return json({ code: 'not_found' }, 404);
        if (active === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        return json(publicRead);
      }
      if (request.method === 'POST') {
        if (active === 'denied') return json({ code: 'forbidden' }, 403);
        if (active === 'stale') return json({ code: 'stale_editorial_head' }, 409);
        if (active === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
        if (active === 'invalid')
          return json({ code: 'invalid_request', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }, 400);
        if (receipts.has(key!)) return json(receipts.get(key!), 201);
        if (path === '/v1/subjects') {
          const item = body as GameItem;
          Object.assign(publicRead.subject, {
            type: item.type,
            labels: item.labels,
            descriptions: item.descriptions,
            aliases: item.aliases,
            statements: Object.fromEntries(
              Object.entries(item.statements).map(([id, statements]) => [id, statements.map(selected)]),
            ),
          });
          receipts.set(key!, { subject: structuredClone(publicRead.subject) });
        } else if (path.endsWith('/candidates')) {
          const statement = selected((body as { statement: StatementInput }).statement);
          candidates.set(statement.id, {
            id: statement.id,
            statement,
            revision: 2,
            release: definitions.digest,
            source: null,
            retracted: null,
            retraction: null,
            decision: null,
            head: null,
            rank: null,
          });
          receipts.set(key!, { candidate: statement.id, revision: 2 });
        } else return json({ code: 'semantic_not_ready' }, 503);
        if (active === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(receipts.get(key!), 201);
      }
      if (path.endsWith('/candidates'))
        return json({
          candidates: [...candidates.values()].filter(
            (candidate) => candidate.statement.property.id === url.searchParams.get('property'),
          ),
          adoption: null,
          next: null,
        });
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const review = (property: string): CandidateTransport => ({
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async (_property, cursor, session) => {
      const result = await readCandidates(client, 'Bearer fixture', gameId, property, cursor, undefined, session);
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
  });
  const facts = {
    read: () => readStatementEditor(client, { id: gameId }),
    propose: (command: Parameters<typeof proposeFact>[2]) => proposeFact(client, 'Bearer fixture', command),
  };
  const transport: GameProfileTransport = {
    load: () => readGameProfile(client, correction ? gameId : undefined),
    create: (command) =>
      createGameProfile(
        client,
        new Request('https://site.invalid', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
    facts,
    classifications: facts,
    review,
    classificationReview: review,
    relations: {
      read: (slot, cursor, session) =>
        readRelationEditor(
          client,
          'Bearer fixture',
          relationDescriptorReader(release),
          gameId,
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
    release,
    publicRead,
    transport,
    calls,
    candidates,
    receipts,
    setScenario: (next: GameScenario) => {
      active = next;
    },
  };
}
