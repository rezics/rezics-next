import { CONTEXT_LIMITS, contextSelectionScopeKey, type ContextSelectionScope } from './schema.ts';

// Typed declarations for the Access-owned private personal selection tables
// (services/main/migrations/access/100_context_selection.sql). The SQL
// migration remains the DDL owner. These rows never grant authority and are
// never published as graph membership.

export const PRIVATE_SELECTION_SCOPE_PROFILE = 'context-selection-scope-v1';

export interface ContextSelectionRow {
  id: string;
  principal_id: string;
  scope_profile: typeof PRIVATE_SELECTION_SCOPE_PROFILE;
  scope_kind: ContextSelectionScope['kind'];
  scope_object: string | null;
  scope_relation: string | null;
  scope_domain: string | null;
  scope_key: string;
  head_revision: string;
}

export interface ContextSelectionRevisionRow {
  id: string;
  selection_id: string;
  generation: string;
  predecessor_generation: string | null;
  state: 'selected' | 'cleared';
  context: string | null;
  semantic_revision: string | null;
  preference_revision: string | null;
  created_at: Date;
}

export interface ContextSelectionReceiptRow {
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  selection_id: string;
  revision_id: string;
  created_at: Date;
}

/** One head/revision pair returned by the bounded resolver lookup. */
export interface PrivateSelectionCandidateRow {
  id: string;
  scope_key: string;
  head_revision: string;
  generation: string;
  state: 'selected' | 'cleared';
  context: string | null;
  semantic_revision: string | null;
  preference_revision: string | null;
}

/**
 * Bounded lookup: one probe of `context_selection_scope_once` with at most
 * CONTEXT_LIMITS.scopeCandidates keys, then a primary-key join to each head.
 * It never scans a principal's other selections.
 */
export const PRIVATE_SELECTION_LOOKUP_SQL = `SELECT s.id, s.scope_key, s.head_revision,
    r.generation::text AS generation, r.state, r.context, r.semantic_revision, r.preference_revision
  FROM access.context_selection AS s
  JOIN access.context_selection_revision AS r ON r.id = s.head_revision AND r.selection_id = s.id
  WHERE s.principal_id = $1 AND s.scope_profile = '${PRIVATE_SELECTION_SCOPE_PROFILE}'
    AND s.scope_key = ANY($2::text[])`;

export function privateSelectionLookupKeys(scopes: readonly ContextSelectionScope[]): string[] {
  const keys = [...new Set(scopes.map(contextSelectionScopeKey))];
  if (!keys.length || keys.length > CONTEXT_LIMITS.scopeCandidates) {
    throw new RangeError('private Context selection lookup exceeds its candidate bound');
  }
  return keys;
}
