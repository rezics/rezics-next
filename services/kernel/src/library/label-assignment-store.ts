import type { PoolClient } from 'pg';
import guard from './label-assignment-guard.sql';
import parents from './label-assignment-parents.sql';
import reclaim from './label-assignment-reclaim.sql';
import reservations from './label-assignment-reservations.sql';
import set from './label-assignment-set.sql';

type Assignment = {
  id: string;
  labelId: string;
  subjectId: string;
  revision: number;
  slotNo: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
  purgeAfter: null;
};

export type SetLabelAssignmentResult =
  | { kind: 'applied' | 'existing'; assignment: Assignment }
  | { kind: 'capacity' | 'not_found' | 'migration_required' };

type Observed = Awaited<ReturnType<typeof reservations.run>>[number];

function liveRecord(row: Observed): Assignment {
  if (
    row.id === null ||
    row.slotNo === null ||
    row.createdAt === null ||
    row.updatedAt === null ||
    row.deletedAt !== null ||
    row.purgeAfter !== null
  )
    throw new Error('Expected an identified live label reservation');
  return {
    ...row,
    id: row.id,
    slotNo: row.slotNo,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    deletedAt: null,
    purgeAfter: null,
  };
}

function lostObservation(): never {
  throw Object.assign(new Error('Label assignment observation changed; retry the native command'), { code: '40001' });
}

/** Private admission storage, called inside one admitted SERIALIZABLE native command transaction.
 * The caller owns transaction rollback/retry. A result supplies neither Access nor a receipt capability.
 */
export async function setLabelAssignment(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; subjectId: string; labelId: string },
  context: { transactionId: string; time: string },
): Promise<SetLabelAssignmentResult> {
  const db = { query: client.query.bind(client) };
  const tuple = {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
    label_id: input.labelId,
  };
  const guarded = await guard.run(db, tuple);
  const labelId = guarded.labelId;
  if (!labelId) throw new Error('Label assignment guard returned no canonical label identity');
  const rows = await reservations.run(db, tuple);
  const desired = rows.find((row) => row.labelId === labelId);
  const locked = await parents.run(db, {
    route: input.route,
    account_id: input.accountId,
    label_ids: [...new Set([...rows.map((row) => row.labelId), labelId])],
  });
  const current = new Map(locked.map((parent) => [parent.labelId, parent]));
  const parent = current.get(labelId);
  if (!parent || parent.deletedAt !== null) return { kind: 'not_found' };
  // Legacy tuples require a separate bounded cutover; reads never stamp identities or claims.
  if (desired && (desired.id === null || (desired.deletedAt === null && desired.slotNo === null)))
    return { kind: 'migration_required' };
  if (desired && desired.deletedAt === null && desired.slotNo !== null)
    return { kind: 'existing', assignment: liveRecord(desired) };

  const occupied = new Set(rows.flatMap((row) => (row.slotNo === null ? [] : [row.slotNo])));
  let slot = Array.from({ length: 32 }, (_, n) => n).find((n) => !occupied.has(n));
  const victim =
    slot === undefined
      ? rows.find((row) => row.slotNo !== null && current.get(row.labelId)?.deletedAt != null)
      : undefined;
  if (slot === undefined && !victim) return { kind: 'capacity' };
  // Check both increments before any maintenance: exhaustion must leave even a caught error effect-free.
  if (desired?.revision === 2_147_483_647 || victim?.revision === 2_147_483_647)
    throw new RangeError('Label assignment revision exhausted');
  if (victim) {
    const hidden = current.get(victim.labelId)!;
    if (victim.id === null || victim.slotNo === null || hidden.deletedAt === null || hidden.purgeAfter === null)
      throw new Error('Invalid hidden label reservation');
    const reclaimed = await reclaim.run(db, {
      ...tuple,
      label_id: victim.labelId,
      assignment_id: victim.id,
      revision: victim.revision,
      slot_no: victim.slotNo,
      deleted_at: hidden.deletedAt,
      purge_after: hidden.purgeAfter,
      time: context.time,
      transaction_id: context.transactionId,
    });
    if (reclaimed.length !== 1) lostObservation();
    slot = victim.slotNo;
  }
  const written = await set.run(db, {
    ...tuple,
    retained: desired !== undefined,
    assignment_id: desired?.id ?? null,
    revision: desired?.revision ?? null,
    deleted_at: desired?.deletedAt ?? null,
    purge_after: desired?.purgeAfter ?? null,
    slot_no: slot!,
    time: context.time,
    transaction_id: context.transactionId,
  });
  const row = written[0];
  if (!row) lostObservation();
  return { kind: 'applied', assignment: liveRecord(row) };
}
