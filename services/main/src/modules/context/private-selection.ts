import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { hash } from '../work/activate.ts';
import { CONTEXT_AUTHORITY, GLOBAL_SEMANTIC_CONTEXT, checkContextSelectionScope,
  contextSelectionScopeKey, type ContextSelectionScope } from './schema.ts';
import { PRIVATE_SELECTION_LOOKUP_SQL, PRIVATE_SELECTION_SCOPE_PROFILE, privateSelectionLookupKeys,
  type PrivateSelectionCandidateRow } from './private-selection-schema.ts';

// Access-owned private personal selections (migration 100). The pattern is the
// acting-context and reader-variant preference writes: principal row lock,
// idempotency receipt, compare-and-swap on the head revision. Nothing here is
// written to the graph or grants authority.

export class PrivateSelectionDenied extends Error {}
export class PrivateSelectionInvalid extends Error {}
export class PrivateSelectionStale extends Error {}
export class PrivateSelectionConflict extends Error {}
export class PrivateSelectionUnavailable extends Error {}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const revisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SetPrivateSelection {
  scope: ContextSelectionScope;
  selection: { context: string; semanticRevision: string } | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}
export interface PrivateSelectionResult {
  profile: 'context-private-selection-v1';
  scope: ContextSelectionScope;
  state: 'selected' | 'cleared';
  context: string | null;
  semanticRevision: string | null;
  revision: string;
  generation: string;
  replayed: boolean;
}

export function privateSelectionDigest(input: SetPrivateSelection): string {
  checkContextSelectionScope(input.scope);
  if ((input.expectedRevision !== null && !revisionId.test(input.expectedRevision))
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)
    || (input.selection && ((input.selection.context !== GLOBAL_SEMANTIC_CONTEXT
      && !nativeId.test(input.selection.context)) || !nativeId.test(input.selection.semanticRevision)))) {
    throw new PrivateSelectionInvalid('invalid private Context selection');
  }
  return hash(JSON.stringify(['context-private-selection-v1', input.scope, input.selection, input.expectedRevision]));
}

function scopeColumns(scope: ContextSelectionScope) {
  return [scope.kind, 'object' in scope ? scope.object : null,
    scope.kind === 'object-relation' ? scope.relation : null, scope.kind === 'domain' ? scope.domain : null];
}

export class PrivateContextSelections {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the original failure */ }
      if (error && typeof error === 'object' && 'code' in error) {
        if (String(error.code) === '23505') throw new PrivateSelectionStale('selection head changed');
        if (['40001', '55P03', '57014'].includes(String(error.code))) {
          throw new PrivateSelectionUnavailable('private selection store is busy');
        }
      }
      throw error;
    } finally { client.release(); }
  }

  private async principal(client: PoolClient, principal: VerifiedPrincipal, lock: boolean): Promise<string> {
    const row = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [principal.issuer, principal.subject]);
    if (!row.rows[0]) throw new PrivateSelectionDenied('principal is not admitted');
    return row.rows[0].id;
  }

  /** Bounded lookup for the resolver: one index probe over the precedence candidates. */
  async candidates(principal: VerifiedPrincipal, scopes: readonly ContextSelectionScope[]):
    Promise<PrivateSelectionCandidateRow[]> {
    const keys = privateSelectionLookupKeys(scopes);
    return this.transaction(async client => {
      const id = await this.principal(client, principal, false);
      return (await client.query<PrivateSelectionCandidateRow>(PRIVATE_SELECTION_LOOKUP_SQL, [id, keys])).rows;
    });
  }

  async read(principal: VerifiedPrincipal, scope: ContextSelectionScope): Promise<Omit<PrivateSelectionResult, 'replayed'> | null> {
    const rows = await this.candidates(principal, [scope]);
    const row = rows[0];
    return row ? { profile: 'context-private-selection-v1', scope, state: row.state, context: row.context,
      semanticRevision: row.semantic_revision, revision: row.head_revision, generation: row.generation } : null;
  }

  /**
   * Whether the acting Agent represented by this principal may read a Private Context.
   * Public Contexts need no grant; this is the existing grant/representation proof.
   */
  async canReadPrivate(principal: VerifiedPrincipal, actingSubject: string, context: string): Promise<boolean> {
    if (!nativeId.test(actingSubject) || !nativeId.test(context)) return false;
    const { scope, action } = CONTEXT_AUTHORITY.read(context);
    return this.transaction(async client => {
      const id = await this.principal(client, principal, false).catch(() => null);
      if (!id) return false;
      const proof = await client.query(`SELECT 1 FROM access.representation r
        JOIN access.permission_grant g ON g.recipient_subject = r.subject_id
        JOIN access.scope_gate s ON s.id = g.scope_id AND s.open
        WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3 AND r.active
          AND r.valid_until > clock_timestamp() AND g.scope_id = $4 AND g.action = $3 AND g.active
          AND g.valid_until > clock_timestamp() LIMIT 1`, [id, actingSubject, action, scope]);
      return proof.rowCount === 1;
    });
  }

  /** `verify` rechecks the pinned graph revision before the head moves. */
  async set(principal: VerifiedPrincipal, input: SetPrivateSelection,
    verify: () => Promise<void>): Promise<PrivateSelectionResult> {
    const digest = privateSelectionDigest(input);
    const key = contextSelectionScopeKey(input.scope);
    const replay = await this.transaction(async client => {
      const id = await this.principal(client, principal, false);
      return (await client.query<{ request_digest: string; revision_id: string; generation: string;
        state: 'selected' | 'cleared'; context: string | null; semantic_revision: string | null }>(
        `SELECT c.request_digest, c.revision_id, r.generation::text AS generation, r.state, r.context,
           r.semantic_revision FROM access.context_selection_receipt c
         JOIN access.context_selection_revision r ON r.id = c.revision_id
         WHERE c.principal_id = $1 AND c.idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
    });
    if (replay) {
      if (replay.request_digest !== digest) throw new PrivateSelectionConflict('key binds another selection');
      return { profile: 'context-private-selection-v1', scope: input.scope, state: replay.state,
        context: replay.context, semanticRevision: replay.semantic_revision, revision: replay.revision_id,
        generation: replay.generation, replayed: true };
    }
    if (input.selection) await verify();
    return this.transaction(async client => {
      const id = await this.principal(client, principal, true);
      const head = (await client.query<{ id: string; head_revision: string; generation: string }>(
        `SELECT s.id, s.head_revision, r.generation::text AS generation FROM access.context_selection s
         JOIN access.context_selection_revision r ON r.id = s.head_revision
         WHERE s.principal_id = $1 AND s.scope_profile = $2 AND s.scope_key = $3 FOR UPDATE OF s`,
      [id, PRIVATE_SELECTION_SCOPE_PROFILE, key])).rows[0];
      if ((head?.head_revision ?? null) !== input.expectedRevision) {
        throw new PrivateSelectionStale('expected private selection revision is stale');
      }
      const selection = head?.id ?? Bun.randomUUIDv7();
      const revision = Bun.randomUUIDv7();
      const generation = head ? BigInt(head.generation) + 1n : 1n;
      if (!head) {
        await client.query(`INSERT INTO access.context_selection (id, principal_id, scope_profile, scope_kind,
          scope_object, scope_relation, scope_domain, head_revision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [selection, id, PRIVATE_SELECTION_SCOPE_PROFILE, ...scopeColumns(input.scope), revision]);
      }
      await client.query(`INSERT INTO access.context_selection_revision (id, selection_id, generation,
        predecessor_generation, state, context, semantic_revision) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [revision, selection, generation.toString(), head ? head.generation : null,
        input.selection ? 'selected' : 'cleared', input.selection?.context ?? null,
        input.selection?.semanticRevision ?? null]);
      if (head) {
        await client.query('UPDATE access.context_selection SET head_revision = $1 WHERE id = $2 AND head_revision = $3',
          [revision, selection, head.head_revision]);
      }
      await client.query(`INSERT INTO access.context_selection_receipt (principal_id, idempotency_key,
        request_digest, selection_id, revision_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, input.idempotencyKey, digest, selection, revision]);
      return { profile: 'context-private-selection-v1' as const, scope: input.scope,
        state: input.selection ? 'selected' as const : 'cleared' as const,
        context: input.selection?.context ?? null, semanticRevision: input.selection?.semanticRevision ?? null,
        revision, generation: generation.toString(), replayed: false };
    });
  }
}
