import type { Pool, PoolClient } from 'pg';
import { revisionsWithOpenCommentSource } from '../../../../content/src/comments.ts';
import { withPreservationFence, type PreservationAccess } from '../public-report/preservation.ts';
import { graphErasureReceipt } from './graph.ts';
import { consumeErasurePreflight, erasurePreflightRemaining, MAX_ERASURE_TARGETS,
  type ErasurePreflightBudget } from './journal.ts';
import type { ReceiptCustody } from '../outbox/receipt-custody.ts';

export class ContentErasureInvalid extends Error {}
/** A revision already pinned for graph publication needs graph suppression first. */
export class ContentErasureGraphRequired extends Error {}
export class ContentErasureStale extends Error {}

/** Same item ceiling as Content's exact batch read; one transaction locks at most this many rows. */
export const MAX_CONTENT_ERASURE_TARGETS = 64;
/** A journal entry written before the request cap may name up to its own bound; replay and
 * probes accept that many and run 64-bound helpers in slices of one transaction. */
const MAX_REPLAY_TARGETS = MAX_ERASURE_TARGETS;

function slices<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += MAX_CONTENT_ERASURE_TARGETS) {
    out.push(items.slice(at, at + MAX_CONTENT_ERASURE_TARGETS));
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TargetRow {
  id: string;
  resource_id: string;
  availability: string;
  pending_pin: boolean;
  active_pin: boolean;
  erasure_id: string | null;
  erasure_epoch: string | null;
  payload_present?: boolean;
}

function checkIds(revisionIds: readonly string[], limit = MAX_CONTENT_ERASURE_TARGETS): void {
  if (!revisionIds.length || revisionIds.length > limit
    || new Set(revisionIds).size !== revisionIds.length || revisionIds.some(id => !UUID.test(id))) {
    throw new ContentErasureInvalid('Content erasure targets are invalid');
  }
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

function targetSql(ids: string, lock: boolean): string {
  return `SELECT r.id::text AS id, v.resource_id, r.availability,
      (r.serialized_bytes IS NOT NULL OR r.body IS NOT NULL) AS payload_present,
      EXISTS (SELECT 1 FROM content.publication_preparation p
        WHERE p.revision_id = r.id AND p.pin_active AND p.status = 'pending') AS pending_pin,
      EXISTS (SELECT 1 FROM content.publication_preparation p
        WHERE p.revision_id = r.id AND p.pin_active AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM content.publication_erasure_supersession s
            WHERE s.operation_id = p.operation_id)) AS active_pin,
      t.erasure_id::text AS erasure_id, t.erasure_epoch::text AS erasure_epoch
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
    LEFT JOIN content.revision_erasure t ON t.revision_id = r.id
    WHERE r.id = ANY(${ids}) ORDER BY r.id${lock ? ' FOR UPDATE OF r' : ''}`;
}

async function targetRows(client: Queryable, revisionIds: readonly string[],
  lock: boolean): Promise<TargetRow[]> {
  return (await client.query<TargetRow>(targetSql('$1::uuid[]', lock), [revisionIds])).rows;
}

/** Identity and the pre-journal pin check are this one read. */
export function readContentErasureTargets(content: Queryable,
  revisionIds: readonly string[]): Promise<TargetRow[]> {
  return targetRows(content, revisionIds, false);
}

/** Apply the pre-journal pin rules to rows already loaded with identity. */
export function assertFreshContentTargets(rows: readonly TargetRow[], revisionIds: readonly string[],
  resourceId: string, allowActivePin: boolean): void {
  assertTargets(rows, revisionIds, resourceId, null, null, allowActivePin);
}

function assertTargets(rows: readonly TargetRow[], revisionIds: readonly string[],
  resourceId: string, erasureId: string | null, erasureEpoch: string | null,
  allowActivePin: boolean): void {
  if (rows.length !== revisionIds.length || rows.some(row => row.resource_id !== resourceId)) {
    throw new ContentErasureInvalid('Content erasure targets are unavailable');
  }
  if (rows.some(row => row.erasure_id
    ? row.erasure_id !== erasureId || (erasureEpoch !== null && row.erasure_epoch !== erasureEpoch)
    : row.availability !== 'available')) {
    throw new ContentErasureStale('Content revision is no longer available to erase');
  }
  if (rows.some(row => row.erasure_id && row.payload_present)) {
    throw new ContentErasureStale('live SQL erasure completion is unavailable');
  }
  if (rows.some(row => row.pending_pin || row.active_pin && !allowActivePin
    && !(erasureId && row.erasure_id === erasureId))) {
    throw new ContentErasureGraphRequired('published Content needs graph suppression');
  }
}

/** One bounded read before journaling; pending pins still require terminal proof. */
export async function checkContentErasureTargets(content: Pool, resourceId: string,
  revisionIds: readonly string[], allowActivePin = false): Promise<void> {
  checkIds(revisionIds);
  assertTargets(await targetRows(content, revisionIds, false), revisionIds, resourceId, null, null,
    allowActivePin);
}

export interface ContentErasureGraphProof {
  closureDigest?: string;
  receipt: string;
  dataEpoch: string;
  sequence: string;
}

export interface ContentErasureCommand {
  budget?: ErasurePreflightBudget;
  preservationAccess: PreservationAccess;
  erasureId: string;
  erasureEpoch: string;
  resourceId: string;
  revisionIds: readonly string[];
  graphProof?: ContentErasureGraphProof;
}

/**
 * Apply one journaled erasure to the Content owner: a non-sensitive tombstone and
 * the erased transition commit together. Replays of the same erasure are no-ops.
 * No Content receipt or outbox event is written: the relay journal is the
 * command's owner and the tombstone is its local idempotency record.
 */
export async function applyContentErasure(content: Pool, command: ContentErasureCommand): Promise<{
  applied: number }> {
  // New requests are capped at 64 before journaling; only a replay reaches the journal bound.
  checkIds(command.revisionIds, MAX_REPLAY_TARGETS);
  if (!UUID.test(command.erasureId) || !/^[1-9][0-9]{0,18}$/.test(command.erasureEpoch)) {
    throw new ContentErasureInvalid('Content erasure journal identity is invalid');
  }
  if (command.graphProof && (command.graphProof.receipt !== graphErasureReceipt(command.erasureId, command.graphProof.closureDigest)
    || !command.graphProof.dataEpoch || !/^[1-9][0-9]*$/.test(command.graphProof.sequence))) {
    throw new ContentErasureInvalid('Content graph suppression proof is invalid');
  }
  const guarded = await withPreservationFence(command.preservationAccess, command.resourceId, command.erasureId,
    () => eraseContent(content, command));
  if (guarded.held) throw new ContentErasureStale('Content erasure is deferred');
  return guarded.value;
}

function sqlUuid(id: string): string {
  if (!UUID.test(id)) throw new ContentErasureInvalid('Content erasure targets are invalid');
  return `'${id}'::uuid`;
}

function sqlUuidArray(ids: readonly string[]): string {
  return `ARRAY[${ids.map(sqlUuid).join(',')}]`;
}

function sqlBigint(value: string): string {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new ContentErasureInvalid('Content erasure journal identity is invalid');
  return `${value}::bigint`;
}

function sqlText(value: string): string {
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(value)) throw new ContentErasureInvalid('Content erasure proof is invalid');
  return `'${value}'`;
}

async function eraseContent(content: Pool, command: ContentErasureCommand): Promise<{ applied: number }> {
  const client = await content.connect();
  try {
    // One call for the transaction preamble. Later operations share their call
    // with the remaining budget: a separate timeout statement is another content
    // call, and the request bound counts every call. The budget is still the
    // first command, so the operation that follows cannot outlive what is left.
    await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
    const started = Date.now();
    const bounded = async <T>(statement: string): Promise<{ rows: T[] }> => {
      command.budget?.signal.throwIfAborted();
      const left = Math.min(5_000 - (Date.now() - started),
        command.budget ? command.budget.deadline - Date.now() : 5_000);
      if (!Number.isInteger(left) || left < 1 || left > 5_000) {
        throw new ContentErasureStale('Content erasure deadline passed');
      }
      // The timeout command finishes before the operation, so the operation cannot
      // outlive the budget. One adapter call: the request bound counts calls.
      const result = await client.query(
        `SELECT set_config('statement_timeout', '${left}ms', true);\n${statement}`);
      const last = Array.isArray(result) ? result[result.length - 1] : result;
      return last as { rows: T[] };
    };
    const ids = sqlUuidArray(command.revisionIds);
    // Revisions lock before preparations. Settlement locks the revision before
    // creating a pin, so no new pending pin can appear after these locks.
    await bounded(`SELECT id FROM content.revision WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`);
    const preparations = (await bounded<{ operation_id: string; revision_id: string;
      status: string; pin_active: boolean }>(`SELECT operation_id, revision_id, status, pin_active
      FROM content.publication_preparation WHERE revision_id = ANY(${ids})
      ORDER BY operation_id FOR UPDATE`)).rows;
    const rows = (await bounded<TargetRow>(targetSql(ids, false))).rows;
    assertTargets(rows, command.revisionIds, command.resourceId, command.erasureId,
      command.erasureEpoch, Boolean(command.graphProof));
    if (preparations.some(p => p.status === 'pending' && p.pin_active)
      || preparations.some(p => p.status === 'active' && p.pin_active) && !command.graphProof) {
      throw new ContentErasureGraphRequired('published Content needs graph suppression');
    }
    const pending = rows.filter(row => !row.erasure_id).map(row => row.id);
    if (pending.length) {
      const pendingIds = sqlUuidArray(pending);
      const erasureId = sqlUuid(command.erasureId);
      const epoch = sqlBigint(command.erasureEpoch);
      await bounded(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        SELECT unnest(${pendingIds}), ${erasureId}, ${epoch}`);
      await bounded(`UPDATE content.revision SET availability = 'erased',
          serialized_bytes = NULL, body = NULL
        WHERE id = ANY(${pendingIds}) AND availability = 'available'`);
      if (command.graphProof) await bounded(`INSERT INTO content.publication_erasure_supersession
        (operation_id, revision_id, erasure_id, erasure_epoch,
         graph_receipt, graph_data_epoch, graph_sequence)
        SELECT p.operation_id, p.revision_id, ${erasureId}, ${epoch},
          ${sqlText(command.graphProof.receipt)}, ${sqlText(command.graphProof.dataEpoch)},
          ${sqlBigint(command.graphProof.sequence)}
        FROM content.publication_preparation p
        WHERE p.revision_id = ANY(${pendingIds}) AND p.status = 'active' AND p.pin_active`);
    }
    // Already-tombstoned revisions are not pending, but selectors that survived
    // an older erasure still clear under that same journal id and epoch.
    const erasureId = sqlUuid(command.erasureId);
    const epoch = sqlBigint(command.erasureEpoch);
    for (const slice of slices(command.revisionIds)) {
      await bounded(`SELECT content.erase_comment_sources(${sqlUuidArray(slice)}, ${erasureId}, ${epoch})`);
    }
    // The evidence function takes the journal bound itself: one call, same id and epoch.
    await bounded(`SELECT verification.erase_evidence_sources(${ids}, ${erasureId}, ${epoch})`);
    await bounded('COMMIT');
    return { applied: pending.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export type ContentErasureProbe = 'erased' | 'absent' | 'available' | 'foreign';

/** Per-revision state of a journaled erasure in one Content copy, in one bounded read. */
export async function probeContentErasure(content: Pool | PoolClient, erasureId: string,
  revisionIds: readonly string[], erasureEpoch?: string): Promise<Map<string, ContentErasureProbe>> {
  if (revisionIds.length > 256) throw new ContentErasureInvalid('Content erasure probe is too large');
  const rows = (await content.query<{ id: string; availability: string | null;
    erasure_id: string | null; erasure_epoch: string | null; payload_absent: boolean }>(`SELECT wanted.id::text AS id, r.availability,
    (r.serialized_bytes IS NULL AND r.body IS NULL
      AND NOT EXISTS (SELECT 1 FROM content.comment c WHERE c.revision_id = wanted.id
        AND (c.exact IS NOT NULL OR c.prefix IS NOT NULL OR c.suffix IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM verification.evidence_item i WHERE i.content_revision_id = wanted.id
        AND NOT i.source_terminal AND verification.evidence_selector_has_source(i.selector))
      AND NOT EXISTS (SELECT 1 FROM verification.evidence_item i WHERE i.content_revision_id = wanted.id
        AND i.source_terminal AND verification.evidence_selector_has_source(i.selector))) AS payload_absent,
    t.erasure_id, t.erasure_epoch::text AS erasure_epoch
    FROM unnest($1::uuid[]) AS wanted(id)
    LEFT JOIN content.revision r ON r.id = wanted.id
    LEFT JOIN content.revision_erasure t ON t.revision_id = wanted.id`, [revisionIds])).rows;
  // With an epoch, a tombstone of the same id but another epoch is not this erasure's.
  return new Map(rows.map(row => [row.id, row.availability === null ? 'absent'
    : row.erasure_id === erasureId && row.availability === 'erased'
      && row.payload_absent && (erasureEpoch === undefined || row.erasure_epoch === erasureEpoch) ? 'erased'
      : row.availability === 'available' && !row.erasure_id ? 'available' : 'foreign']));
}

export interface CommandCustodyErasureTarget {
  receipt: string; revision: string; payloadSha256: string;
  erasureId: string | null; erasureEpoch: string | null; payloadAbsent: boolean;
  payloadBytes?: number;
}

/** The unique revision key bounds this lookup to one retained command per revision,
 * including retired proofs. No current-head or whole-custody scan is sufficient. */
export async function commandCustodyErasureTargets(access: Pool | PoolClient,
  revisionIris: readonly string[], budget?: ErasurePreflightBudget): Promise<CommandCustodyErasureTarget[]> {
  if (!revisionIris.length) return [];
  if (revisionIris.length > MAX_CONTENT_ERASURE_TARGETS) {
    throw new ContentErasureInvalid('command custody inventory is too large');
  }
  const limit = budget ? Math.min(MAX_CONTENT_ERASURE_TARGETS,
    erasurePreflightRemaining(budget, 'inventoryEntries')) : MAX_CONTENT_ERASURE_TARGETS;
  const rows = (await access.query<CommandCustodyErasureTarget>(`SELECT receipt, revision,
    payload_sha256 AS "payloadSha256", payload_erasure_id::text AS "erasureId",
    payload_erasure_epoch::text AS "erasureEpoch", payload IS NULL AS "payloadAbsent",
    coalesce(octet_length(payload), 0) AS "payloadBytes"
    FROM access.command_custody WHERE revision = ANY($1::text[]) ORDER BY revision LIMIT ${limit + 1}`,
  [revisionIris])).rows;
  if (budget) {
    consumeErasurePreflight(budget, 'inventoryEntries', rows.length);
  }
  return rows;
}

/** Custody's own receipt lock, original proof and guarded terminal transition remain
 * authoritative. This adapter only binds those identities to the retained inventory. */
export async function applyCommandCustodyErasure(custody: ReceiptCustody | undefined,
  targets: readonly CommandCustodyErasureTarget[],
  command: { erasureId: string; erasureEpoch: string; objectRefs: ReadonlySet<string> },
  budget?: ErasurePreflightBudget): Promise<void> {
  for (const target of targets) {
    if (!custody || !command.objectRefs.has(`sha256:${target.payloadSha256}`)
      || (target.payloadAbsent && (target.erasureId !== command.erasureId
        || target.erasureEpoch !== command.erasureEpoch))) {
      throw new ContentErasureStale('command custody differs from the erasure inventory');
    }
    await custody.erasePayloadForErasure(target.receipt, { revision: target.revision,
      payloadSha256: target.payloadSha256, erasureId: command.erasureId,
      erasureEpoch: command.erasureEpoch }, undefined, budget);
  }
}

/** Revisions whose comments still store source selectors. One indexed existence
 * probe per revision, at most the erasure target bound. Probe completion is not
 * this check: an erased revision can still hold exact, prefix or suffix. */
export async function openCommentSourceRevisions(content: Pool | PoolClient,
  revisionIds: readonly string[]): Promise<string[]> {
  if (revisionIds.length > MAX_REPLAY_TARGETS) {
    throw new ContentErasureInvalid('Content erasure probe is too large');
  }
  const open: string[] = [];
  for (const slice of slices(revisionIds)) open.push(...await revisionsWithOpenCommentSource(content, slice));
  return open;
}

/** The owning resource of journaled revisions; a completion retry rebuilds its Access scope. */
export async function contentErasureResource(content: Pool, revisionIds: readonly string[]): Promise<string> {
  const rows = (await content.query<{ resource_id: string }>(`SELECT DISTINCT v.resource_id
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
    WHERE r.id = ANY($1::uuid[])`, [revisionIds])).rows;
  if (rows.length !== 1) throw new ContentErasureInvalid('Content erasure resource is unavailable');
  return rows[0]!.resource_id;
}
