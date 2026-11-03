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
  | { kind: 'capacity' | 'not_found' | 'migration_required' | 'changed' | 'stale' };

type Observed = Awaited<ReturnType<typeof reservations.run>>[number];

function liveRecord(row: Omit<Observed, 'desired'>): Assignment {
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
    id: row.id,
    labelId: row.labelId,
    subjectId: row.subjectId,
    revision: row.revision,
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

/** The existing subject guard; the optional label only preserves admission's canonical UUID result. */
export async function lockLabelAssignmentSubject(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; subjectId: string; labelId?: string },
) {
  return guard.run(
    { query: client.query.bind(client) },
    {
      route: input.route,
      account_id: input.accountId,
      subject_id: input.subjectId,
      label_id: input.labelId ?? input.subjectId,
    },
  );
}

/** Private admission storage, called inside one admitted SERIALIZABLE native command transaction.
 * The caller owns transaction rollback/retry. A result supplies neither Access nor a receipt capability.
 */
export async function setLabelAssignment(
  client: Pick<PoolClient, 'query'>,
  input: {
    route: number;
    accountId: string;
    subjectId: string;
    labelId: string;
    expectedLabelRevision?: number;
    staleOnRevisionMismatch?: boolean;
    expectedSource?: { labelId: string; assignmentId: string; revision: number; labelRevision: number };
    expectedTarget?: { id: string; revision: number; effective: boolean } | null;
  },
  context: { transactionId: string; time: string },
): Promise<SetLabelAssignmentResult> {
  const db = { query: client.query.bind(client) };
  const tuple = {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
    label_id: input.labelId,
  };
  const guarded = await lockLabelAssignmentSubject(client, input);
  const labelId = guarded.labelId;
  if (!labelId) throw new Error('Label assignment guard returned no canonical label identity');
  const rows = await reservations.run(db, tuple);
  // Reservation witnesses use only the covering source index; response dates come from the exact tuple point.
  const sources = rows.filter((row) => !row.desired);
  const desired = rows.find((row) => row.desired);
  const locked = await parents.run(db, {
    route: input.route,
    account_id: input.accountId,
    label_ids: [
      ...new Set([
        ...rows.map((row) => row.labelId),
        labelId,
        ...(input.expectedSource ? [input.expectedSource.labelId] : []),
      ]),
    ],
  });
  const current = new Map(locked.map((parent) => [parent.labelId, parent]));
  const parent = current.get(labelId);
  if (!parent || parent.deletedAt !== null) return { kind: 'not_found' };
  if (input.expectedLabelRevision !== undefined && parent.revision !== input.expectedLabelRevision)
    return input.staleOnRevisionMismatch ? { kind: 'stale' } : { kind: 'changed' };
  if (input.expectedSource) {
    const sourceParent = current.get(input.expectedSource.labelId);
    if (
      !sourceParent ||
      sourceParent.deletedAt !== null ||
      sourceParent.revision !== input.expectedSource.labelRevision
    )
      return { kind: 'changed' };
    const source = await client.query<{
      assignmentId: string;
      revision: number;
      slotNo: number | null;
      deletedAt: string | null;
    }>(
      `SELECT assignment_id AS "assignmentId",revision,slot_no AS "slotNo",deleted_at::text AS "deletedAt"
       FROM library.label_assignment
       WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [input.route, input.accountId, input.subjectId, input.expectedSource.labelId],
    );
    const sourceAssignment = source.rows[0];
    if (
      !sourceAssignment ||
      sourceAssignment.assignmentId !== input.expectedSource.assignmentId ||
      sourceAssignment.revision !== input.expectedSource.revision ||
      sourceAssignment.deletedAt !== null ||
      sourceAssignment.slotNo === null
    )
      return { kind: 'changed' };
  }
  // Legacy tuples require a separate bounded cutover; reads never stamp identities or claims.
  if (desired && (desired.id === null || (desired.deletedAt === null && desired.slotNo === null)))
    return { kind: 'migration_required' };
  if (input.expectedTarget !== undefined) {
    const observedTarget = desired
      ? {
          id: desired.id!,
          revision: desired.revision,
          effective: desired.deletedAt === null && desired.slotNo !== null,
        }
      : null;
    if (JSON.stringify(observedTarget) !== JSON.stringify(input.expectedTarget)) return { kind: 'changed' };
  }
  if (desired && desired.deletedAt === null && desired.slotNo !== null)
    return { kind: 'existing', assignment: liveRecord(desired) };

  const occupied = new Set(sources.flatMap((row) => (row.slotNo === null ? [] : [row.slotNo])));
  let slot = Array.from({ length: 32 }, (_, n) => n).find((n) => !occupied.has(n));
  const victim =
    slot === undefined
      ? sources.find((row) => row.slotNo !== null && current.get(row.labelId)?.deletedAt != null)
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
    if (!reclaimed || reclaimed.assignment_id !== victim.id) lostObservation();
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
