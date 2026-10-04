import { standingRatingSlotIri } from '../rating/observation.ts';
import { targetRatingDigest } from '../rating/target-digest.ts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
  contextRevision?: string; policyRevision?: string; release?: string; target?: string;
  value?: number | null; availability?: 'available' | 'withdrawn';
}
interface SealingRatingAdmission { id: string; action: string; principal_id: string;
  acting_subject: string; request_digest: string }
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** First seal only, inside the admission transaction. Exact-head CAS orders
 * delayed seals: a child waits for its parent's seal. Retried seals never rewind. */
export async function recordRatingAggregateHead(client: PoolClient,
  admitted: SealingRatingAdmission, proof: RatingProof): Promise<void> {
  if (proof.outcome !== 'succeeded'
    || !['rating.context.create', 'rating.context.policy.set', 'rating.observation.set'].includes(admitted.action)) return;
  const revision = admitted.action === 'rating.context.policy.set' ? proof.policyRevision : proof.revision;
  if (![proof.context, proof.realm, revision].every(value => typeof value === 'string' && nativeId.test(value))) {
    throw new RatingInventoryConflict('Rating receipt lacks its inventory identity');
  }
  if (admitted.action === 'rating.context.create') {
    await client.query(`INSERT INTO access.rating_aggregate_context
      (context, realm, revision, policy_revision, admission_id) VALUES ($1,$2,$3,$3,$4)`,
    [proof.context, proof.realm, proof.revision, admitted.id]);
    return;
  }
  if (admitted.action === 'rating.context.policy.set') {
    if (!nativeId.test(proof.contextRevision ?? '') || !nativeId.test(proof.predecessor ?? '')) {
      throw new RatingInventoryConflict('Rating policy predecessor is invalid');
    }
    const changed = await client.query(`UPDATE access.rating_aggregate_context
      SET policy_revision = $1 WHERE context = $2 AND realm = $3 AND revision = $4
        AND policy_revision = $5`,
    [proof.policyRevision, proof.context, proof.realm, proof.contextRevision, proof.predecessor]);
    if (changed.rowCount !== 1) throw new RatingInventoryConflict('Rating policy predecessor seal is unavailable');
    return;
  }
  if (proof.target !== undefined) {
    if (![proof.target, proof.observation, proof.contextRevision].every(value => nativeId.test(value ?? ''))
      || !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(proof.slot ?? '')
      || proof.predecessor !== null && !nativeId.test(proof.predecessor ?? '')
      || proof.work !== undefined || proof.mainVersion !== undefined || proof.release !== undefined) {
      throw new RatingInventoryConflict('Target rating receipt differs from its inventory');
    }
    const context = await client.query('SELECT 1 FROM access.rating_aggregate_context WHERE context = $1 AND realm = $2 AND revision = $3',
      [proof.context, proof.realm, proof.contextRevision]);
    if (context.rowCount !== 1) throw new RatingInventoryConflict('Target Context seal unavailable');
    const value = sealedTargetValue(proof, admitted);
    const values = [proof.context, proof.target, proof.slot, proof.observation, proof.revision,
      admitted.principal_id, admitted.id];
    if (proof.predecessor === null) {
      await client.query(`INSERT INTO access.target_rating_head
        (context,target,slot,observation,revision,principal_id,admission_id,original_admission_id,value,value_known)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,true)`, [...values, value]);
      await moveTargetComponents(client, proof.context!, proof.target, admitted.id,
        { slots: 1, unvalued: 0, previous: null, next: value });
    } else {
      // The row lock orders this seal after any repair that is recording the same head's value.
      const prior = await client.query<{ value: number | null; value_known: boolean }>(`SELECT value, value_known
        FROM access.target_rating_head WHERE context = $1 AND target = $2 AND slot = $3 AND observation = $4
          AND principal_id = $5 AND revision = $6 FOR UPDATE`,
      [proof.context, proof.target, proof.slot, proof.observation, admitted.principal_id, proof.predecessor]);
      if (prior.rowCount !== 1) throw new RatingInventoryConflict('Target predecessor seal unavailable');
      await client.query(`UPDATE access.target_rating_head SET revision = $5, admission_id = $7, value = $8, value_known = true
        WHERE context = $1 AND target = $2 AND slot = $3 AND observation = $4 AND principal_id = $6 AND revision = $9`,
      [...values, value, proof.predecessor]);
      const known = prior.rows[0]!.value_known;
      await moveTargetComponents(client, proof.context!, proof.target, admitted.id,
        { slots: 0, unvalued: known ? 0 : -1, previous: known ? prior.rows[0]!.value : null, next: value });
    }
    return;
  }
  // One new observation cannot certify the earlier population of a legacy Context.
  const context = await client.query<{ realm: string }>(
    'SELECT realm FROM access.rating_aggregate_context WHERE context = $1', [proof.context]);
  if (!context.rowCount) return;
  if (context.rows[0]?.realm !== proof.realm
    || ![proof.work, proof.mainVersion, proof.observation].every(value => typeof value === 'string' && nativeId.test(value))
    || (proof.release !== undefined && !nativeId.test(proof.release))
    || !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(proof.slot ?? '')
    || (proof.predecessor !== null && (typeof proof.predecessor !== 'string' || !nativeId.test(proof.predecessor)))) {
    throw new RatingInventoryConflict('Rating receipt differs from its inventory');
  }
  const values = [proof.context, proof.mainVersion, proof.slot, proof.work,
    proof.observation, proof.revision, admitted.principal_id, admitted.id, proof.release ?? null];
  if (proof.predecessor === null) {
    await client.query(`INSERT INTO access.rating_aggregate_head
      (context, main_version, slot, work, observation, revision, principal_id, admission_id,
       original_admission_id, target_release)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`, values);
  } else {
    const changed = await client.query(`UPDATE access.rating_aggregate_head
      SET revision = $6, admission_id = $8 WHERE context = $1 AND main_version = $2
        AND slot = $3 AND work = $4 AND observation = $5 AND principal_id = $7
        AND target_release IS NOT DISTINCT FROM $9 AND revision = $10`,
    [...values, proof.predecessor]);
    if (changed.rowCount !== 1) throw new RatingInventoryConflict('Rating predecessor seal is unavailable');
  }
}

/** The sealed value must be the one the admitted request carried: the digest
 * names context, target, predecessor, value and actor, so a receipt cannot move
 * a sum the principal never asked for. */
function sealedTargetValue(proof: RatingProof, admitted: SealingRatingAdmission): number | null {
  const value = proof.availability === 'available' ? proof.value
    : proof.availability === 'withdrawn' && proof.value === null ? null : undefined;
  if (value === undefined || value !== null && (!Number.isInteger(value) || value < 1 || value > 10)) {
    throw new RatingInventoryConflict('Target rating value is invalid');
  }
  let digest: string;
  try {
    digest = targetRatingDigest({ context: proof.context!, target: proof.target!, expectedRevisionHead: proof.predecessor!,
      value, actingSubject: admitted.acting_subject });
  } catch { throw new RatingInventoryConflict('Target rating value differs from its admission'); }
  if (digest !== admitted.request_digest) throw new RatingInventoryConflict('Target rating value differs from its admission');
  return value;
}

/** One head's change in a target's components. `previous` is the value the head
 * already contributed (null for none or withdrawn); a head whose value was never
 * recorded contributes nothing yet, so `unvalued` falls when it first is. */
interface ComponentMove { slots: number; unvalued: number; previous: number | null; next: number | null }
const bins = (value: number | null) => Array.from({ length: 10 }, (_, index) => value === index + 1 ? 1 : 0);
const histogramMove = (previous: string, next: string) => `ARRAY(SELECT u.h + (CASE WHEN u.i = ${next}::int THEN 1 ELSE 0 END)
  - (CASE WHEN u.i = ${previous}::int THEN 1 ELSE 0 END) FROM unnest(histogram) WITH ORDINALITY AS u(h, i) ORDER BY u.i)`;

/** Moves the target's row and its Context's row in the transaction of the seal
 * (or repair) that moved a head. Rows of one Context change only under that
 * Context's scope gate, so reading before writing cannot race. */
async function moveTargetComponents(client: PoolClient, context: string, target: string, admission: string | null,
  move: ComponentMove): Promise<void> {
  const count = (move.next === null ? 0 : 1) - (move.previous === null ? 0 : 1);
  const sum = (move.next ?? 0) - (move.previous ?? 0);
  const existing = await client.query('SELECT 1 FROM access.target_rating_component WHERE context = $1 AND target = $2 FOR UPDATE',
    [context, target]);
  if (!existing.rowCount) {
    if (move.slots !== 1 || move.previous !== null || admission === null) {
      throw new RatingInventoryConflict('Target component seal unavailable');
    }
    await client.query(`INSERT INTO access.target_rating_component
      (context,target,slots,unvalued,rating_count,rating_sum,histogram,last_admission_id)
      VALUES ($1,$2,1,0,$3,$4,$5::int[],$6)`, [context, target, count, sum, bins(move.next), admission]);
  } else {
    await client.query(`UPDATE access.target_rating_component SET slots = slots + $3, unvalued = unvalued + $4,
      rating_count = rating_count + $5, rating_sum = rating_sum + $6, histogram = ${histogramMove('$7', '$8')},
      last_admission_id = COALESCE($9::uuid, last_admission_id) WHERE context = $1 AND target = $2`,
    [context, target, move.slots, move.unvalued, count, sum, move.previous, move.next, admission]);
  }
  const contextRow = await client.query('SELECT 1 FROM access.target_rating_context_component WHERE context = $1 FOR UPDATE',
    [context]);
  if (!contextRow.rowCount) {
    await client.query(`INSERT INTO access.target_rating_context_component
      (context,targets,slots,unvalued,rating_count,rating_sum,histogram) VALUES ($1,1,1,0,$2,$3,$4::int[])`,
    [context, count, sum, bins(move.next)]);
  } else {
    await client.query(`UPDATE access.target_rating_context_component SET targets = targets + $2,
      slots = slots + $3, unvalued = unvalued + $4, rating_count = rating_count + $5, rating_sum = rating_sum + $6,
      histogram = ${histogramMove('$7', '$8')} WHERE context = $1`,
    [context, existing.rowCount ? 0 : 1, move.slots, move.unvalued, count, sum, move.previous, move.next]);
  }
}

export interface RatingInventoryHead {
  slot: string; work: string; mainVersion?: string;
  originWork?: string; originMainVersion?: string; effectiveSlot?: string; observation: string; revision: string;
  /** Opaque, scoped to Context/target, and never returned by the public API. */
  raterKey: string;
  evaluatedAt: string; submittedAt: string; actingSubject: string;
  requestDigest: string; receipt: string; dataEpoch: string; sequence: string;
}
export interface RatingAggregateInventory {
  realm: string; contextRevision: string; policyRevision: string | null; recoveryGeneration: string;
  contextReceipt: string; contextDataEpoch: string; contextSequence: string;
  heads: RatingInventoryHead[];
}

/** The sealed private head prevents a rolled-back graph from relabeling a default. */
export async function readRatingContextPolicyWitness(pool: Pool, context: string,
  signal = AbortSignal.timeout(10_000)): Promise<{ contextRevision: string; policyRevision: string }> {
  if (!nativeId.test(context)) throw new RatingInventoryConflict('invalid Rating Context');
  return withInventoryClient(pool, signal, async client => {
    const result = await client.query(`SELECT c.revision, c.policy_revision, f.open,
        a.state, a.graph_outcome FROM access.rating_aggregate_context c
      JOIN access.admission a ON a.id = c.admission_id
      CROSS JOIN access.recovery_fence f WHERE c.context = $1 AND f.id = true`, [context]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row.open !== true || row.state !== 'sealed'
      || row.graph_outcome !== 'succeeded' || !nativeId.test(row.policy_revision ?? '')) {
      throw new RatingInventoryConflict('Rating policy witness is unavailable');
    }
    return { contextRevision: row.revision, policyRevision: row.policy_revision };
  });
}

// Each branch selects at most k+1 indexed candidates BEFORE precedence and
// origin joins, then sorts at most 2(k+1) rows. If native votes mask candidates,
// they also count toward the population: truncation cannot hide an overflow.
// Every origin, precedence and admission lookup is an exact indexed probe.
// https://www.postgresql.org/docs/18/indexes-ordering.html
function inventorySql(release: boolean | 'target'): string { return `SELECT c.realm, c.revision AS context_revision,
    c.policy_revision,
    f.open, f.generation, ca.state AS context_state, ca.graph_outcome AS context_outcome,
    ca.graph_receipt AS context_receipt, ca.graph_data_epoch AS context_epoch,
    ca.graph_sequence AS context_sequence,
    ${release === false ? 'h.effective_work,h.effective_main_version,' : ''}
    h.slot, ${release === 'target' ? 'h.target AS work, NULL AS main_version, NULL AS target_release, h.target' : 'h.work, h.main_version, h.target_release'}, h.observation, h.revision, h.principal_id,
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
  LEFT JOIN LATERAL (${release === false ? `SELECT * FROM (
    (SELECT h.*,NULL::text AS effective_work,NULL::text AS effective_main_version FROM access.rating_aggregate_head h
      WHERE context=c.context AND main_version=$2 AND target_release IS NULL ORDER BY slot LIMIT 101)
    UNION ALL SELECT h.*,s.work AS effective_work,s.main_version AS effective_main_version
      FROM (SELECT * FROM access.rating_merge_selection
        WHERE context=c.context AND main_version=$2 ORDER BY principal_id LIMIT 101) s
      LEFT JOIN LATERAL (SELECT 1 AS present FROM access.rating_aggregate_head native
        WHERE native.context=s.context AND native.main_version=s.main_version
          AND native.principal_id=s.principal_id AND native.target_release IS NULL LIMIT 1) native ON true
      LEFT JOIN LATERAL (SELECT * FROM access.rating_aggregate_head origin
        WHERE origin.context=s.context AND origin.main_version=s.origin_main_version
          AND origin.slot=s.origin_slot AND origin.principal_id=s.principal_id
          AND origin.target_release IS NULL LIMIT 1) h ON native.present IS NULL
      WHERE native.present IS NULL
    ) selected ORDER BY slot LIMIT 101` : `SELECT * FROM access.${release === 'target' ? 'target_rating_head' : 'rating_aggregate_head'}
    WHERE context=c.context AND ${release === 'target' ? 'target=$2' : 'target_release=$2'} ORDER BY slot LIMIT 101`}) h ON true
  LEFT JOIN LATERAL (SELECT * FROM access.admission WHERE id = h.admission_id LIMIT 1) a ON true
  LEFT JOIN LATERAL (SELECT * FROM access.admission WHERE id = h.original_admission_id LIMIT 1) original ON true
  WHERE c.context = $1 AND f.id = true`; }
export const RATING_INVENTORY_SQL = inventorySql(false);
export const RELEASE_RATING_INVENTORY_SQL = inventorySql(true);
export const TARGET_RATING_INVENTORY_SQL = inventorySql('target');

/** One bounded owner snapshot; raw counting identities stay within Access. */
export async function readRatingAggregateInventory(pool: Pool, context: string,
  mainVersion: string, signal = AbortSignal.timeout(10_000)): Promise<RatingAggregateInventory> {
  return readInventory(pool, context, mainVersion, false, signal);
}

export async function readReleaseRatingAggregateInventory(pool: Pool, context: string,
  release: string, signal = AbortSignal.timeout(10_000)): Promise<RatingAggregateInventory> {
  return readInventory(pool, context, release, true, signal);
}

/** The additive figures of one target and the seal that last moved them. Heads
 * sealed before components existed are `unvalued`: they are in `slots` but not in
 * the sums, so the figures are exact only while `unvalued` is zero. */
export interface TargetRatingComponents {
  slots: number; unvalued: number; count: number; sum: number; histogram: number[];
  last: { receipt: string; requestDigest: string; dataEpoch: string; sequence: string };
}
export interface ContextRatingComponents {
  targets: number; slots: number; unvalued: number; count: number; sum: number; histogram: number[];
}
/** Context seal, recovery fence and components of the requested targets from one
 * snapshot. `heads` is the exact private inventory, read only for one target
 * small enough to verify head by head. */
export interface TargetRatingSnapshot extends Omit<RatingAggregateInventory, 'heads'> {
  contextComponents: ContextRatingComponents | null;
  members: ReadonlyMap<string, TargetRatingComponents>;
  heads: RatingInventoryHead[] | null;
}

const COMPONENT_CONTEXT_SQL = `SELECT c.realm, c.revision AS context_revision, c.policy_revision, f.open, f.generation,
    ca.state AS context_state, ca.graph_outcome AS context_outcome, ca.graph_receipt AS context_receipt,
    ca.graph_data_epoch AS context_epoch, ca.graph_sequence AS context_sequence,
    k.targets, k.slots, k.unvalued, k.rating_count, k.rating_sum, k.histogram
  FROM access.rating_aggregate_context c
  JOIN access.admission ca ON ca.id = c.admission_id
  CROSS JOIN access.recovery_fence f
  LEFT JOIN access.target_rating_context_component k ON k.context = c.context
  WHERE c.context = $1 AND f.id = true`;
const COMPONENT_MEMBERS_SQL = `SELECT k.target, k.slots, k.unvalued, k.rating_count, k.rating_sum, k.histogram,
    la.state, la.graph_outcome, la.graph_receipt, la.graph_data_epoch, la.graph_sequence, la.request_digest,
    (la.action = 'rating.observation.set' AND la.scope_id = 'rating:observe:' || k.context) AS identity_valid
  FROM access.target_rating_component k JOIN access.admission la ON la.id = k.last_admission_id
  WHERE k.context = $1 AND k.target = ANY($2::text[])`;

const figures = (row: QueryResultRow) => ({ slots: Number(row.slots), unvalued: Number(row.unvalued),
  count: Number(row.rating_count), sum: Number(row.rating_sum), histogram: (row.histogram as unknown[]).map(Number) });

/** Two indexed reads and, for one small target, one k+1 head read, all in one
 * repeatable-read snapshot; no read walks a large target's raters. */
export async function readTargetRatingSnapshot(pool: Pool, context: string, targets: readonly string[],
  signal = AbortSignal.timeout(10_000), options: { heads?: boolean } = {}): Promise<TargetRatingSnapshot> {
  if (![context, ...targets].every(value => nativeId.test(value)) || targets.length < 1 || targets.length > 200
    || options.heads && targets.length !== 1) throw new RatingInventoryConflict('invalid Rating target');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const first = (await client.query(COMPONENT_CONTEXT_SQL, [context])).rows[0];
    if (!first || first.open !== true || first.context_state !== 'sealed' || first.context_outcome !== 'succeeded') {
      throw new RatingInventoryConflict('Rating inventory is unavailable');
    }
    const members = new Map<string, TargetRatingComponents>();
    for (const row of (await client.query(COMPONENT_MEMBERS_SQL, [context, targets])).rows) {
      if (row.state !== 'sealed' || row.graph_outcome !== 'succeeded' || row.identity_valid !== true) {
        throw new RatingInventoryConflict('Target component seal is unavailable');
      }
      members.set(row.target, { ...figures(row), last: { receipt: row.graph_receipt, requestDigest: row.request_digest,
        dataEpoch: row.graph_data_epoch, sequence: row.graph_sequence } });
    }
    const only = options.heads ? members.get(targets[0]!) : undefined;
    const heads = options.heads && (!only || only.slots <= MAX_RATING_AGGREGATE_SLOTS)
      ? inventoryHeads((await client.query(TARGET_RATING_INVENTORY_SQL, [context, targets[0]])).rows, 'target', context, targets[0]!)
      : null;
    await client.query('COMMIT');
    return { realm: first.realm, contextRevision: first.context_revision, policyRevision: first.policy_revision ?? null,
      contextReceipt: first.context_receipt, contextDataEpoch: first.context_epoch,
      contextSequence: first.context_sequence, recoveryGeneration: first.generation,
      contextComponents: first.targets === null ? null : { targets: Number(first.targets), ...figures(first) },
      members, heads };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}

/** Records values a verified read learned for heads sealed before components
 * existed. A head moves only if it still carries the verified revision, and its
 * contribution moves both component rows in the same transaction. */
export async function recordTargetRatingValues(pool: Pool, context: string, target: string, generation: string,
  heads: readonly { slot: string; revision: string; value: number | null }[],
  signal = AbortSignal.timeout(10_000)): Promise<number> {
  if (![context, target].every(value => nativeId.test(value))) throw new RatingInventoryConflict('invalid Rating target');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query('SELECT open, generation FROM access.recovery_fence WHERE id = true');
    if (fence.rows[0]?.open !== true || fence.rows[0]?.generation !== generation) {
      throw new RatingInventoryConflict('Recovery fence changed');
    }
    await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR UPDATE', [`rating:observe:${context}`]);
    let recorded = 0;
    for (const head of heads) {
      const changed = await client.query(`UPDATE access.target_rating_head SET value = $5, value_known = true
        WHERE context = $1 AND target = $2 AND slot = $3 AND revision = $4 AND NOT value_known`,
      [context, target, head.slot, head.revision, head.value]);
      if (changed.rowCount !== 1) continue;
      await moveTargetComponents(client, context, target, null, { slots: 0, unvalued: -1, previous: null, next: head.value });
      recorded++;
    }
    await client.query('COMMIT');
    return recorded;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}

function inventoryHeads(rows: QueryResultRow[], release: boolean | 'target', context: string,
  target: string): RatingInventoryHead[] {
  return rows.filter(row => row.slot).map((row): RatingInventoryHead => {
    if (row.state !== 'sealed' || row.graph_outcome !== 'succeeded' || row.identity_valid !== true
      || !(row.evaluated_at instanceof Date) || !(row.submitted_at instanceof Date)) {
      throw new RatingInventoryConflict('Rating inventory head is unavailable');
    }
    if (release === 'target' ? row.target !== target : release ? row.target_release !== target : row.target_release !== null) {
      throw new RatingInventoryConflict('Rating inventory target differs');
    }
    return { slot: row.slot, work: row.effective_work ?? row.work, mainVersion: row.effective_main_version ?? row.main_version,
      ...(row.effective_work ? { originWork: row.work, originMainVersion: row.main_version,
        effectiveSlot: standingRatingSlotIri(row.principal_id, context, target) } : {}),
      observation: row.observation, revision: row.revision,
      raterKey: createHash('sha256').update(JSON.stringify({ family: 'rating-private-rater-v1',
        principalId: row.principal_id, context, target })).digest('hex'),
      evaluatedAt: row.evaluated_at.toISOString(), submittedAt: row.submitted_at.toISOString(),
      actingSubject: row.acting_subject, requestDigest: row.request_digest,
      receipt: row.graph_receipt, dataEpoch: row.graph_data_epoch, sequence: row.graph_sequence };
  });
}

async function readInventory(pool: Pool, context: string, target: string,
  release: boolean | 'target', signal: AbortSignal): Promise<RatingAggregateInventory> {
  if (![context, target].every(value => nativeId.test(value))) throw new RatingInventoryConflict('invalid Rating target');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(release === 'target' ? TARGET_RATING_INVENTORY_SQL
      : release ? RELEASE_RATING_INVENTORY_SQL : RATING_INVENTORY_SQL, [context, target]);
    const first = result.rows[0];
    if (!first || first.open !== true || first.context_state !== 'sealed' || first.context_outcome !== 'succeeded') {
      throw new RatingInventoryConflict('Rating inventory is unavailable');
    }
    if (result.rows.some(row => row.effective_work && !row.slot)) {
      throw new RatingInventoryConflict('Merged rating origin is unavailable');
    }
    const heads = inventoryHeads(result.rows, release, context, target);
    await client.query('COMMIT');
    return { realm: first.realm, contextRevision: first.context_revision,
      policyRevision: first.policy_revision ?? null,
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

/** The exact-release aggregate's read-only Access owner boundary. */
export class ReleaseRatingInventoryStore {
  constructor(private readonly pool: Pool) {}

  read(context: string, release: string, signal?: AbortSignal) {
    return readReleaseRatingAggregateInventory(this.pool, context, release, signal);
  }

  checkFence(generation: string, signal?: AbortSignal) {
    return checkRatingAggregateFence(this.pool, generation, signal);
  }
}
