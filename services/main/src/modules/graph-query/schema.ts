import { MAX_SEARCH_FUSEKI_BYTES, MAX_SEARCH_FUSEKI_CALLS, MAX_SEARCH_RESPONSE_BYTES,
  PHRASE_HIT_PROBE } from '../work/search-readiness.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { MAX_FRAMES } from '../projection/schema.ts';
import { REVELATION_COST } from '../reading-position/store.ts';

/** Relation graph reads never walk more than one admitted occurrence page. */
export const GRAPH_QUERY_LIMITS = {
  edges: 64,
  candidates: 65,
  roleBindings: 8,
  phraseLength: 80,
} as const;

export const GRAPH_QUERY_READ_LIMITS = {
  fusekiCalls: MAX_SEARCH_FUSEKI_CALLS,
  fusekiBytes: MAX_SEARCH_FUSEKI_BYTES,
  requestMs: 10_000,
} as const;

export const GRAPH_QUERY_COST = {
  relationPage: {
    graphQueries: 3, // resource seed: lineage, exact DefinitionRef and one grouped ARQ read
    maxCandidates: GRAPH_QUERY_LIMITS.candidates,
    maxResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
    accessProofsPerCandidate: 2, // the occurrence and the other participant
    routeAnchorAccessProofs: 3, // semantic, Work fallback and module anchor checks
    explicitParticipantAccessProofs: GRAPH_QUERY_LIMITS.roleBindings,
    maxAccessProofs: GRAPH_QUERY_LIMITS.candidates * 2 + 3 + GRAPH_QUERY_LIMITS.roleBindings,
    textSeed: { maxCandidates: PHRASE_HIT_PROBE, maxFusekiCalls: GRAPH_QUERY_READ_LIMITS.fusekiCalls,
      maxFusekiBytes: GRAPH_QUERY_READ_LIMITS.fusekiBytes, maxRequestMs: GRAPH_QUERY_READ_LIMITS.requestMs },
    noPerEdgeGraphHydration: true,
  },
  statementPage: {
    graphQueries: 2, // lineage plus one bounded grouped ARQ read
    maxCandidates: GRAPH_QUERY_LIMITS.candidates,
    maxResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
    // ReadingBoundary's bounded traversal uses the ordinary position-read ceilings.
    maxFusekiCalls: WORK_READ_COST.graphCalls,
    maxFusekiBytes: WORK_READ_COST.graphBytes,
    projectionPartQueries: 1,
    readingFenceQueries: 2,
    recordsPerCandidate: 3 + MAX_FRAMES, // Statement, endpoints and applicability coordinates
    revelationBatches: Math.ceil((GRAPH_QUERY_LIMITS.candidates * (3 + MAX_FRAMES + 2 * (MAX_FRAMES + 1)) + 1) / REVELATION_COST.batch),
    maxRequestMs: GRAPH_QUERY_READ_LIMITS.requestMs,
    resourceAccessChecks: GRAPH_QUERY_LIMITS.candidates + 3,
    privateContextAccessChecks: GRAPH_QUERY_LIMITS.candidates,
    noPerStatementGraphHydration: true,
  },
} as const;

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const roleKey = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface GraphRoleBinding {
  role: string;
  participant: string;
}

export interface RelationGraphContinuation {
  queryDigest: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  after: { occurrence: string; revision: string; from: string; to: string };
  expiresAt: number;
}

export interface RelationGraphQuery {
  profile: 'relation-graph-v1';
  actingSubject: string;
  anchor: { kind: 'resource'; id: string } | { kind: 'phrase'; phrase: string; language: string | null };
  definition: string;
  fromRole: string;
  toRole: string;
  direction: 'outgoing' | 'incoming';
  roleBindings: GraphRoleBinding[];
  continuation?: RelationGraphContinuation;
}

export interface StatementGraphContinuation {
  queryDigest: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  after: string;
  expiresAt: number;
}

export interface StatementGraphQuery {
  profile: 'statement-graph-v1';
  actingSubject: string;
  anchor: string;
  direction: 'outgoing' | 'incoming';
  predicate?: string;
  position?: string;
  continuation?: StatementGraphContinuation;
}

export class InvalidGraphQuery extends Error {}

export function checkedRelationGraphQuery(input: RelationGraphQuery): RelationGraphQuery {
  if (input.profile !== 'relation-graph-v1'
    || !nativeId.test(input.actingSubject) || !nativeId.test(input.definition)
    || !input.anchor || (input.anchor.kind !== 'resource' && input.anchor.kind !== 'phrase')
    || (input.anchor.kind === 'resource' && !nativeId.test(input.anchor.id))
    || (input.anchor.kind === 'phrase' && (input.anchor.phrase.trim().length < 2
      || input.anchor.phrase.length > GRAPH_QUERY_LIMITS.phraseLength
      || /[\u0000-\u001f\u007f]/u.test(input.anchor.phrase)
      || (input.anchor.language !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(input.anchor.language))))
    || !roleKey.test(input.fromRole) || !roleKey.test(input.toRole)
    || !['outgoing', 'incoming'].includes(input.direction)
    || !Array.isArray(input.roleBindings) || input.roleBindings.length > GRAPH_QUERY_LIMITS.roleBindings
    || input.roleBindings.some(binding => !roleKey.test(binding.role) || !nativeId.test(binding.participant))
    || new Set(input.roleBindings.map(binding => JSON.stringify([binding.role, binding.participant]))).size
      !== input.roleBindings.length
    || (input.continuation !== undefined && (!input.continuation
      || !/^[0-9a-f]{64}$/u.test(input.continuation.queryDigest)
      || !input.continuation.sourcePosition || input.continuation.sourcePosition.datasetId !== 'product'
      || typeof input.continuation.sourcePosition.dataEpoch !== 'string'
      || !input.continuation.sourcePosition.dataEpoch
      || !/^(0|[1-9][0-9]*)$/u.test(input.continuation.sourcePosition.sequence)
      || !input.continuation.after || !nativeId.test(input.continuation.after.occurrence)
      || !nativeId.test(input.continuation.after.revision)
      || !nativeId.test(input.continuation.after.from)
      || !nativeId.test(input.continuation.after.to)
      || !Number.isSafeInteger(input.continuation.expiresAt) || input.continuation.expiresAt < 0))) {
    throw new InvalidGraphQuery('relation graph query is invalid');
  }
  return { ...input, anchor: input.anchor.kind === 'phrase'
    ? { ...input.anchor, phrase: input.anchor.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ') }
    : input.anchor };
}


export function checkedStatementGraphQuery(input: StatementGraphQuery): StatementGraphQuery {
  if (input.profile !== 'statement-graph-v1'
    || !nativeId.test(input.actingSubject) || !nativeId.test(input.anchor)
    || !['outgoing', 'incoming'].includes(input.direction)
    || (input.position !== undefined && !['mine', 'all', 'start'].includes(input.position) && !nativeId.test(input.position))
    || (input.predicate !== undefined && !/^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/u.test(input.predicate))
    || (input.continuation !== undefined && (!input.continuation
      || !/^[0-9a-f]{64}$/u.test(input.continuation.queryDigest)
      || !input.continuation.sourcePosition || input.continuation.sourcePosition.datasetId !== 'product'
      || typeof input.continuation.sourcePosition.dataEpoch !== 'string'
      || !input.continuation.sourcePosition.dataEpoch
      || !/^(0|[1-9][0-9]*)$/u.test(input.continuation.sourcePosition.sequence)
      || !nativeId.test(input.continuation.after)
      || !Number.isSafeInteger(input.continuation.expiresAt) || input.continuation.expiresAt < 0))) {
    throw new InvalidGraphQuery('statement graph query is invalid');
  }
  return input;
}
