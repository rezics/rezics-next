import type { KnowledgeDiscoveryCandidate, KnowledgeDiscoverySource, KnowledgeDiscoverySummary } from '../content/index.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding } from './cursor.ts';
import { SearchOperationError } from './operation-outcomes.ts';

export const KNOWLEDGE_DISCOVERY_PAGE_LIMIT = 20;
export const KNOWLEDGE_DISCOVERY_STEP_LIMIT = 128;
export const KNOWLEDGE_DISCOVERY_LIFETIME_MS = 15 * 60_000;

export type KnowledgeAssociation = KnowledgeDiscoveryCandidate & Readonly<{ sequence: string }>;
export type KnowledgeFrontier = Readonly<{ publishedAt: string; documentId: string; publicationId: string }>;
export type KnowledgePreparation = Readonly<{
  id: string;
  revision: number;
  subjectId: string;
  limit: number;
  through: string;
  after: KnowledgeFrontier | null;
  /** Retained identities are nominations, not retained Access decisions or public summaries. */
  candidates: readonly KnowledgeAssociation[];
  exhausted: boolean;
  expiresAt: number;
}>;
export type KnowledgeDiscoveryStore = Readonly<{
  /** Null means this index has not completed installation. Zero is a complete empty observation. */
  cut(subjectId: string): Promise<string | null>;
  page(subjectId: string, after: KnowledgeFrontier | null, limit: number): Promise<readonly KnowledgeAssociation[]>;
  load(id: string): Promise<KnowledgePreparation | null>;
  save(record: KnowledgePreparation, previousRevision: number | null): Promise<boolean>;
  id(): string;
}>;
export type KnowledgeDiscoveryRequest = Readonly<{ limit?: number; cursor?: string }>;
export type KnowledgeDiscoveryPage = Readonly<{
  state: 'ready';
  documents: readonly KnowledgeDiscoverySummary[];
  next: string | null;
}> | Readonly<{ state: 'preparing'; next: string }> | Readonly<{ state: 'unavailable' }>;

function invalidCursor(): never {
  throw new SearchOperationError('invalid_request', { errors: [{ pointer: '/cursor', code: 'invalid_format' }] });
}
function restart(): never {
  throw new SearchOperationError('search_restart_required');
}

/** Fixed indexed membership; current Content disclosure is deliberately refreshed on every step.
 * One caller-driven step retains progress. No worker, timer, home scan or full body read is needed. */
export function createKnowledgeDiscovery(options: {
  store: KnowledgeDiscoveryStore;
  source?: KnowledgeDiscoverySource;
  tokens: KeyRing;
  now: () => number;
}) {
  const { store, source, tokens, now } = options;
  const frontier = (candidate: KnowledgeDiscoveryCandidate): KnowledgeFrontier => ({
    publishedAt: candidate.publishedAt, documentId: candidate.documentId, publicationId: candidate.publicationId,
  });
  return async (subjectId: string, principal: 'anonymous' | `account:${string}`, request: KnowledgeDiscoveryRequest,
    context: Readonly<{ deadline: number }>): Promise<KnowledgeDiscoveryPage> => {
    if (!source) return { state: 'unavailable' };
    const subject = await source.subject(subjectId, context);
    if (subject === 'unavailable') return { state: 'unavailable' };
    // The HTTP caller performs ordinary Subject admission; a later loss of public disclosure restarts.
    if (subject !== 'available') restart();
    const limit = request.limit ?? KNOWLEDGE_DISCOVERY_PAGE_LIMIT;
    const binding: SearchCursorBinding = {
      operation: 'GET /v1/subjects/:subjectId/knowledgeDocuments', request: { subjectId, limit }, principal,
    };
    let record: KnowledgePreparation;
    let previousRevision: number | null = null;
    if (request.cursor) {
      const decoded = await decodeSearchCursor(tokens, binding, request.cursor, now());
      if (!decoded.ok || decoded.generation !== 1 || decoded.after.length !== 2 ||
        typeof decoded.after[0] !== 'string' || typeof decoded.after[1] !== 'number') invalidCursor();
      const retained = await store.load(decoded.after[0]);
      if (!retained || retained.expiresAt <= now() || retained.revision !== decoded.after[1]) restart();
      // The confidential token authenticates all request/viewer operands; storage holds only its native locator.
      record = retained;
      previousRevision = retained.revision;
    } else {
      const through = await store.cut(subjectId);
      if (through === null) return { state: 'unavailable' };
      record = { id: store.id(), revision: 0, subjectId, limit, through, after: null,
        candidates: [], exhausted: false, expiresAt: now() + KNOWLEDGE_DISCOVERY_LIFETIME_MS };
    }

    // Recheck earlier nominations instead of reusing a successful permission result.
    const selected: KnowledgeAssociation[] = [];
    for (const candidate of record.candidates) {
      const current = await source.current(candidate, context);
      if (current.status === 'unavailable') return { state: 'unavailable' };
      if (current.value) selected.push(candidate);
    }
    let after = record.after;
    let exhausted = record.exhausted;
    let examined = record.candidates.length;
    if (selected.length < limit && !exhausted) {
      const budget = KNOWLEDGE_DISCOVERY_STEP_LIMIT - examined;
      // Fetch one lookahead without filtering on the cut. Filtering in SQL could scan unbounded
      // post-cut inserts at old publication times. Every physical row instead spends this step's budget.
      const rows = await store.page(subjectId, after, budget + 1);
      const candidates = rows.slice(0, budget);
      for (const candidate of candidates) {
        after = frontier(candidate);
        examined++;
        if (BigInt(candidate.sequence) <= BigInt(record.through)) {
          const current = await source.current(candidate, context);
          if (current.status === 'unavailable') return { state: 'unavailable' };
          if (current.value) selected.push(candidate);
        }
        if (selected.length === limit) break;
      }
      exhausted = examined - record.candidates.length === rows.length;
    }

    // Final exact-selection disclosure pass after preparation, with no cached summary or index title.
    const documents: KnowledgeDiscoverySummary[] = [];
    const retained: KnowledgeAssociation[] = [];
    for (const candidate of selected) {
      const current = await source.current(candidate, context);
      if (current.status === 'unavailable') return { state: 'unavailable' };
      if (current.value) { documents.push(current.value); retained.push(candidate); }
    }
    const finalSubject = await source.subject(subjectId, context);
    if (finalSubject === 'unavailable') return { state: 'unavailable' };
    if (finalSubject !== 'available') restart();
    const ready = documents.length === limit || exhausted;
    if (ready && exhausted) return { state: 'ready', documents, next: null };

    const nextRecord: KnowledgePreparation = {
      ...record, revision: record.revision + 1, after, exhausted,
      candidates: ready ? [] : retained,
    };
    if (!(await store.save(nextRecord, previousRevision))) restart();
    const next = await encodeSearchCursor(tokens, binding, { generation: 1,
      after: [nextRecord.id, nextRecord.revision] }, now());
    return ready ? { state: 'ready', documents, next } : { state: 'preparing', next };
  };
}
