import type { PoolClient } from 'pg';
import { hasRealmConceptPermission, type VerifiedPrincipal } from '../access/admission.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { RealmReplyDenied, RealmReplyInvalid, RealmReplyUnavailable, type PlacementInput } from './content-store.ts';

export interface ReplyBoards { concepts: string[]; primaryConcept: string | null }
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const skos = 'http://www.w3.org/2004/02/skos/core#';

/** Omission retains classification; an explicit empty selection clears it. */
export function replyBoards(input: Pick<PlacementInput, 'concepts' | 'primaryConcept'>): ReplyBoards | undefined {
  if (input.concepts === undefined && input.primaryConcept === undefined) return undefined;
  const concepts = input.concepts, primaryConcept = input.primaryConcept ?? null;
  if (!Array.isArray(concepts) || concepts.length > 8 || concepts.some(id => !native.test(id))
    || new Set(concepts).size !== concepts.length
    || primaryConcept !== null && !concepts.includes(primaryConcept)) {
    throw new RealmReplyInvalid('Invalid reply board selection');
  }
  return { concepts: [...concepts].sort(), primaryConcept };
}

export function activeBoardPattern(realm: string, concept: string) {
  return `${iri(concept)} a <${skos}Concept> ; <${skos}inScheme> ?boardScheme .
    ?boardScheme a <${skos}ConceptScheme> ; rv:schemeState rv:Active .
    FILTER NOT EXISTS { ${iri(concept)} rv:conceptState rv:Retired }
    FILTER NOT EXISTS { ${iri(concept)} rv:protectionHead ?boardProtection }
    FILTER NOT EXISTS { ${iri(concept)} rv:conceptRealm ?boardRealm . FILTER(?boardRealm != ${iri(realm)}) }`;
}

/** Independent variables allow a reply to select Concepts from several schemes. */
export function replyBoardsGuard(realm: string, boards: ReplyBoards) {
  return boards.concepts.map((concept, index) => `GRAPH ${iri(GRAPHS.current)} {
    ${activeBoardPattern(realm, concept).replaceAll('?board', `?board${index}`)} }`).join('\n');
}

export async function readReplyBoards(env: WorkActivationEnvironment, placement: string): Promise<ReplyBoards> {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?concept ?primary WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(placement)} a rv:RealmReplyPlacement .
      OPTIONAL { ${iri(placement)} rv:concept ?concept }
      OPTIONAL { ${iri(placement)} rv:primaryConcept ?primary }
    } } LIMIT 9`, 8192)).results?.bindings;
  if (!rows || rows.length === 0 || rows.length > 8) throw new RealmReplyUnavailable('Reply board selection is unavailable');
  const concepts = rows.flatMap(row => row.concept ? [row.concept.value] : []);
  const primary = new Set(rows.flatMap(row => row.primary ? [row.primary.value] : []));
  if (primary.size > 1) throw new RealmReplyUnavailable('Reply primary board is ambiguous');
  try { return replyBoards({ concepts, primaryConcept: [...primary][0] ?? null })!; }
  catch { throw new RealmReplyUnavailable('Reply board selection is malformed'); }
}

export async function assertReplyBoardAuthority(client: PoolClient, principal: VerifiedPrincipal,
  realm: string, actor: string, author: string, member: boolean, previous: ReplyBoards, next: ReplyBoards) {
  if (actor === author && member) return;
  const affected = [...new Set([...previous.concepts, ...next.concepts])];
  if (await hasRealmConceptPermission(client, principal, realm, actor, affected, 'publication.adopt')) return;
  throw new RealmReplyDenied('Reply board management authority is required');
}

export async function readBoard(session: WorkReadSession, realm: string, concept: string) {
  const rows = await session.query(`SELECT ?concept ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${activeBoardPattern(realm, concept)}
    ${iri(concept)} rv:head ?head . BIND(${iri(concept)} AS ?concept)
  } } LIMIT 2`, 2);
  if (rows.length > 1) throw new WorkReadUnavailable('Board Concept is ambiguous');
  const row = rows[0];
  if (row && (row.concept?.value !== concept || row.head?.type !== 'uri' || !native.test(row.head.value)))
    throw new WorkReadUnavailable('Board Concept head is incomplete');
  const decisions = await session.disclosure([{ owner: 'graph', resource: concept,
    revision: row?.head?.value, component: 'record' }], 'search');
  if (decisions.length !== 1) throw new WorkReadUnavailable('Board disclosure is incomplete');
  if (!row || decisions[0] !== 'visible') throw new WorkReadMissing('Board is unavailable');
}
