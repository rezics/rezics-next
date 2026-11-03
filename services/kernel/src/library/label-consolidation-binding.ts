import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { LibraryConflictError } from './entries.ts';
import { readLibraryProfileAnchor } from './profile-source.ts';
import type { LabelConsolidationReview, LabelConsolidationReviewItem } from './label-consolidation-review.ts';
import { lockLabelAssignmentSubject } from './label-assignment-store.ts';
import { readStoredLabelAssignment } from './label-assignment-lifecycle-store.ts';

export const consolidationDigest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
export type ConsolidationEvidence = Pick<LabelConsolidationReview, 'sourceLabel' | 'targetLabel'> & {
  items: LabelConsolidationReviewItem[];
};
export type ConsolidationItem = {
  evidence: LabelConsolidationReviewItem;
  subject: string;
  assignKey: string;
  unassignKey: string;
  started?: boolean;
  target?: { id: string; revision: number };
  removedRevision?: number;
};
export type ConsolidationBinding = {
  id: string;
  clientId: string;
  requestedBy: string | null;
  evidence: ConsolidationEvidence;
  digest: string;
  items: ConsolidationItem[];
  confirmed: boolean;
  cancelled: boolean;
};
export type ConsolidationGuard = {
  id: string;
  digest: string;
  ordinal: number;
  phase: 'assign' | 'unassign';
  binding: ConsolidationBinding;
  target?: { id: string; revision: number };
  receiptOnly?: boolean;
};
type Client = Pick<PoolClient, 'query'>;

/** Current native Subject authority is always re-admitted; the stamp binds identity/type/security evidence.
 * Public eligibility's exact point is bounded independently of unrelated Subject/label history.
 */
export async function consolidationSubject(
  deps: { pool: Pool; access: Access }, actor: AccountActor, subjectId: string, at: AuthoritativeTime,
): Promise<string> {
  const anchor = await readLibraryProfileAnchor({ ...deps, actor, at, deadline: deadlineFor(5000) }, subjectId);
  if (!anchor || anchor.subjectId !== subjectId) throw new LibraryConflictError();
  const state = (await deps.pool.query<{ visibility: string; security_revision: string }>(
    'SELECT visibility,security_revision::text FROM semantic.subject WHERE route=$1 AND subject_id=$2',
    [routeOf(subjectId), subjectId],
  )).rows[0];
  if (!state) throw new LibraryConflictError();
  return consolidationDigest([subjectId, String(anchor.identityEpoch), anchor.acceptingType, state]);
}

export async function assertConsolidationParents(tx: Client, actor: AccountActor, evidence: ConsolidationEvidence) {
  const { sourceLabel: source, targetLabel: target } = evidence;
  const rows = (await tx.query<{ label_id: string; revision: number }>(
    `WITH keys AS MATERIALIZED (SELECT label_id FROM unnest($3::uuid[]) AS k(label_id) ORDER BY label_id)
     SELECT parent.* FROM keys CROSS JOIN LATERAL (
       SELECT label_id,revision FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=keys.label_id AND deleted_at IS NULL
       FOR SHARE OFFSET 0
     ) AS parent`,
    [routeOf(actor.accountId), actor.accountId, [source.id, target.id].sort()],
  )).rows;
  if (rows.length !== 2 || rows.some(r => r.revision !== (r.label_id === source.id ? source.revision : target.revision)))
    throw new LibraryConflictError();
}
const visible = (row: Awaited<ReturnType<typeof readStoredLabelAssignment>>) => row === null ? null : ({
  id: row.id, revision: row.revision, effective: row.deletedAt === null && row.slotNo !== null,
});

/** Same subject guard and sorted parent locks as native assignment admission. Never names or a label scan. */
export async function assertConsolidationItem(
  tx: Client, actor: AccountActor, binding: ConsolidationBinding, ordinal: number,
  phase: 'assign' | 'unassign', target?: { id: string; revision: number },
) {
  const item = binding.items[ordinal];
  if (!item) throw new LibraryConflictError();
  const tuple = { route: routeOf(actor.accountId)!, accountId: actor.accountId, subjectId: item.evidence.selected.subjectId };
  await lockLabelAssignmentSubject(tx, tuple);
  await assertConsolidationParents(tx, actor, binding.evidence);
  const source = visible(await readStoredLabelAssignment(tx, { ...tuple, labelId: binding.evidence.sourceLabel.id }));
  const currentTarget = visible(await readStoredLabelAssignment(tx, { ...tuple, labelId: binding.evidence.targetLabel.id }));
  if (consolidationDigest(source) !== consolidationDigest(item.evidence.source)) throw new LibraryConflictError();
  const expectedTarget = phase === 'assign' ? item.evidence.target : target ? { ...target, effective: true } : null;
  if (consolidationDigest(currentTarget) !== consolidationDigest(expectedTarget) || (phase === 'unassign' && !target))
    throw new LibraryConflictError();
}

/** Invoked only in the fresh native effect body: original receipts resolve before these mutable fences. */
export async function assertConsolidationGuard(tx: Client, actor: AccountActor, guard: ConsolidationGuard, time: string) {
  const stored = (await tx.query<{ payload: ConsolidationBinding }>(
    `SELECT payload FROM library.label_consolidation WHERE route=$1 AND account_id=$2
     AND consolidation_id=$3 AND expires_at>$4::timestamptz FOR SHARE`,
    [routeOf(actor.accountId), actor.accountId, guard.id, time],
  )).rows[0]?.payload;
  if (!stored || !stored.confirmed || stored.cancelled || stored.digest !== guard.digest ||
      consolidationDigest(stored.items.map(i => [i.evidence, i.subject, i.assignKey, i.unassignKey])) !==
      consolidationDigest(guard.binding.items.map(i => [i.evidence, i.subject, i.assignKey, i.unassignKey])))
    throw new LibraryConflictError();
  // Ordered progress stops a caller from starting another item after an unknown or partial result.
  if (stored.items.slice(0, guard.ordinal).some(i => i.removedRevision === undefined)) throw new LibraryConflictError();
  await assertConsolidationItem(tx, actor, stored, guard.ordinal, guard.phase, guard.target);
}
