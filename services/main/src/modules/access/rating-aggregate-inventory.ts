import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GraphTerminalProof } from './admission.ts';

export const MAX_RATING_AGGREGATE_SLOTS = 100;
export class RatingInventoryConflict extends Error {}

/** A queued pool checkout and every query share the caller's deadline. Destroy
 * an interrupted connection so no unfinished transaction returns to the pool. */
async function withInventoryClient<T>(pool: Pool, signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const client = await new Promise<PoolClient>((resolve, reject) => {
    let waiting = true;
    const abort = () => { waiting = false; reject(new RatingInventoryConflict('Rating owner deadline exceeded')); };
    signal.addEventListener('abort', abort, { once: true });
    pool.connect().then(value => {
      signal.removeEventListener('abort', abort);
      if (!waiting) { value.release(); return; }
      waiting = false; resolve(value);
    }, error => { signal.removeEventListener('abort', abort); waiting = false; reject(error); });
  });
  let released = false;
  const abort = () => { if (!released) { released = true; client.release(true); } };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) { abort(); signal.throwIfAborted(); }
    return await operation(client);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!released) client.release();
  }
}

interface RatingProof extends GraphTerminalProof {
  context?: string; realm?: string; revision?: string; work?: string;
  mainVersion?: string; slot?: string; observation?: string; predecessor?: string | null;
}
interface SealingRatingAdmission { id: string; action: string; principal_id: string }
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** First seal only, inside the admission transaction. Exact-head CAS orders
 * delayed seals: a child waits for its parent's seal. Retried seals never rewind. */
export async function recordRatingAggregateHead(client: PoolClient,
  admitted: SealingRatingAdmission, proof: RatingProof): Promise<void> {
  if (proof.outcome !== 'succeeded'
    || !['rating.context.create', 'rating.observation.set'].includes(admitted.action)) return;
  if (![proof.context, proof.realm, proof.revision].every(value => typeof value === 'string' && nativeId.test(value))) {
    throw new RatingInventoryConflict('Rating receipt lacks its inventory identity');
  }
  if (admitted.action === 'rating.context.create') {
    await client.query(`INSERT INTO access.rating_aggregate_context
      (context, realm, revision, admission_id) VALUES ($1,$2,$3,$4)`,
    [proof.context, proof.realm, proof.revision, admitted.id]);
    return;
  }
  // One new observation cannot certify the earlier population of a legacy Context.
  const context = await client.query<{ realm: string }>(
    'SELECT realm FROM access.rating_aggregate_context WHERE context = $1', [proof.context]);
  if (!context.rowCount) return;
  if (context.rows[0]?.realm !== proof.realm
    || ![proof.work, proof.mainVersion, proof.observation].every(value => typeof value === 'string' && nativeId.test(value))
    || !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(proof.slot ?? '')
    || (proof.predecessor !== null && (typeof proof.predecessor !== 'string' || !nativeId.test(proof.predecessor)))) {
    throw new RatingInventoryConflict('Rating receipt differs from its inventory');
  }
  const values = [proof.context, proof.mainVersion, proof.slot, proof.work,
    proof.observation, proof.revision, admitted.principal_id, admitted.id];
  if (proof.predecessor === null) {
    await client.query(`INSERT INTO access.rating_aggregate_head
      (context, main_version, slot, work, observation, revision, principal_id, admission_id, original_admission_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, values);
  } else {
    const changed = await client.query(`UPDATE access.rating_aggregate_head
      SET revision = $6, admission_id = $8 WHERE context = $1 AND main_version = $2
        AND slot = $3 AND work = $4 AND observation = $5 AND principal_id = $7 AND revision = $9`,
    [...values, proof.predecessor]);
    if (changed.rowCount !== 1) throw new RatingInventoryConflict('Rating predecessor seal is unavailable');
  }
}

export interface RatingInventoryHead {
  slot: string; work: string; observation: string; revision: string;
  /** Opaque, scoped to Context/target, and never returned by the public API. */
  raterKey: string;
  evaluatedAt: string; submittedAt: string; actingSubject: string;
  requestDigest: string; receipt: string; dataEpoch: string; sequence: string;
}
export interface RatingAggregateInventory {
  realm: string; contextRevision: string; recoveryGeneration: string;
  contextReceipt: string; contextDataEpoch: string; contextSequence: string;
  heads: RatingInventoryHead[];
}

// Leading-key equality plus index order stops at k+1 without scanning other
// targets or admission history. Every admission join uses its primary key.
export const RATING_INVENTORY_SQL = `SELECT c.realm, c.revision AS context_revision,
    f.open, f.generation, ca.state AS context_state, ca.graph_outcome AS context_outcome,
    ca.graph_receipt AS context_receipt, ca.graph_data_epoch AS context_epoch,
    ca.graph_sequence AS context_sequence,
    h.slot, h.work, h.observation, h.revision, h.principal_id,
    a.registered_at AS submitted_at, a.acting_subject, a.request_digest,
    a.state, a.graph_outcome, a.graph_receipt, a.graph_data_epoch, a.graph_sequence,
    original.registered_at AS evaluated_at,
    (a.principal_id = h.principal_id AND original.principal_id = h.principal_id
      AND a.action = 'rating.observation.set' AND original.action = a.action
      AND a.scope_id = 'rating:observe:' || c.context AND original.scope_id = a.scope_id
      AND original.state = 'sealed' AND original.graph_outcome = 'succeeded') AS identity_valid
  FROM access.rating_aggregate_context c
  JOIN access.admission ca ON ca.id = c.admission_id
  CROSS JOIN access.recovery_fence f
  LEFT JOIN LATERAL (SELECT * FROM access.rating_aggregate_head
    WHERE context = c.context AND main_version = $2 ORDER BY slot LIMIT 101) h ON true
  LEFT JOIN LATERAL (SELECT * FROM access.admission WHERE id = h.admission_id LIMIT 1) a ON true
  LEFT JOIN LATERAL (SELECT * FROM access.admission WHERE id = h.original_admission_id LIMIT 1) original ON true
  WHERE c.context = $1 AND f.id = true`;

/** One bounded owner snapshot; raw counting identities stay within Access. */
export async function readRatingAggregateInventory(pool: Pool, context: string,
  mainVersion: string, signal = AbortSignal.timeout(10_000)): Promise<RatingAggregateInventory> {
  if (![context, mainVersion].every(value => nativeId.test(value))) throw new RatingInventoryConflict('invalid Rating target');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(RATING_INVENTORY_SQL, [context, mainVersion]);
    const first = result.rows[0];
    if (!first || first.open !== true || first.context_state !== 'sealed' || first.context_outcome !== 'succeeded') {
      throw new RatingInventoryConflict('Rating inventory is unavailable');
    }
    const heads = result.rows.filter(row => row.slot).map((row): RatingInventoryHead => {
      if (row.state !== 'sealed' || row.graph_outcome !== 'succeeded' || row.identity_valid !== true
        || !(row.evaluated_at instanceof Date) || !(row.submitted_at instanceof Date)) {
        throw new RatingInventoryConflict('Rating inventory head is unavailable');
      }
      return { slot: row.slot, work: row.work, observation: row.observation, revision: row.revision,
        raterKey: createHash('sha256').update(JSON.stringify({ family: 'rating-private-rater-v1',
          principalId: row.principal_id, context, mainVersion })).digest('hex'),
        evaluatedAt: row.evaluated_at.toISOString(), submittedAt: row.submitted_at.toISOString(),
        actingSubject: row.acting_subject, requestDigest: row.request_digest,
        receipt: row.graph_receipt, dataEpoch: row.graph_data_epoch, sequence: row.graph_sequence };
    });
    await client.query('COMMIT');
    return { realm: first.realm, contextRevision: first.context_revision,
      contextReceipt: first.context_receipt, contextDataEpoch: first.context_epoch,
      contextSequence: first.context_sequence, recoveryGeneration: first.generation, heads };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}

export async function checkRatingAggregateFence(pool: Pool, generation: string,
  signal = AbortSignal.timeout(10_000)): Promise<boolean> {
  return withInventoryClient(pool, signal, async client => {
    const result = await client.query('SELECT open, generation FROM access.recovery_fence WHERE id = true');
    return result.rows[0]?.open === true && result.rows[0]?.generation === generation;
  });
}
