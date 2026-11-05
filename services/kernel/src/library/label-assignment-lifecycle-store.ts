import type { PoolClient } from 'pg';
import read from './label-assignment-read.sql';
import unassign from './label-assignment-unassign.sql';
import {
  lockLabelAssignmentSubject,
  setLabelAssignment,
  type SetLabelAssignmentResult,
} from './label-assignment-store.ts';
import {
  executeLabelOperation,
  executeLabelSql,
  labelAssignmentLifecyclePlan,
  labelSqlPlan,
} from './label-operation-bounds.ts';

type Client = Pick<PoolClient, 'query'>;
type Tuple = { route: number; accountId: string; subjectId: string; labelId: string };
type Expected = Tuple & { assignmentId: string; revision: number };
type Context = { transactionId: string; time: string };

/** Private retained storage, never an Access or current-membership proof. Null identity is legacy storage. */
export type PrivateLabelAssignment = Tuple & {
  id: string | null;
  revision: number;
  slotNo: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  purgeAfter: string | null;
  transactionId: string;
};
type Observed = NonNullable<Awaited<ReturnType<typeof read.run>>>;
export type UnassignStoredLabelAssignmentResult =
  | { kind: 'applied'; assignment: PrivateLabelAssignment }
  | { kind: 'not_found' | 'stale' | 'migration_required' };
export type RestoreStoredLabelAssignmentResult =
  | { kind: 'applied'; assignment: Extract<SetLabelAssignmentResult, { assignment: unknown }>['assignment'] }
  | { kind: 'not_found' | 'stale' | 'expired' | 'capacity' | 'migration_required' };

function parameters(input: Tuple) {
  return { route: input.route, account_id: input.accountId, subject_id: input.subjectId, label_id: input.labelId };
}

function timestamp(value: string): string {
  const iso = new Date(value).toISOString();
  const submillisecond = value.match(/\.(\d+)/)?.[1]?.slice(3) ?? '';
  return /[1-9]/.test(submillisecond) ? iso.replace('Z', `${submillisecond}Z`) : iso;
}

function record(row: Omit<Observed, 'identityMatches' | 'started' | 'expired'>): PrivateLabelAssignment {
  if (row.createdAt === null || row.updatedAt === null) throw new TypeError('Assignment timestamps are required');
  return {
    route: row.route,
    accountId: row.accountId,
    subjectId: row.subjectId,
    labelId: row.labelId,
    id: row.id,
    revision: row.revision,
    slotNo: row.slotNo,
    transactionId: row.transactionId,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    deletedAt: row.deletedAt === null ? null : timestamp(row.deletedAt),
    purgeAfter: row.purgeAfter === null ? null : timestamp(row.purgeAfter),
  };
}

/** Exact owner tuple only. The supplied client and caller own the real SERIALIZABLE transaction. */
export async function readStoredLabelAssignment(client: Client, input: Tuple): Promise<PrivateLabelAssignment | null> {
  const db = { query: client.query.bind(client) };
  const operands = { ...parameters(input), assignment_id: null, time: null };
  const plan = labelSqlPlan('assignment.read', read.sql, operands, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 1,
    output: {
      route: 65_535,
      accountId: 'f'.repeat(36),
      subjectId: 'f'.repeat(36),
      labelId: 'f'.repeat(36),
      id: 'f'.repeat(36),
      revision: 2_147_483_647,
      slotNo: 31,
      createdAt: '\u0000'.repeat(64),
      updatedAt: '\u0000'.repeat(64),
      deletedAt: '\u0000'.repeat(64),
      purgeAfter: '\u0000'.repeat(64),
      transactionId: 'f'.repeat(36),
      identityMatches: false,
      started: false,
      expired: false,
    },
    outputRows: 1,
  });
  const row = await executeLabelSql(plan, (input) => read.run(db, input));
  return row ? record(row) : null;
}

async function observe(client: Client, input: Expected, context: Context, expectedLabelRevision?: number) {
  await lockLabelAssignmentSubject(client, input);
  if (expectedLabelRevision !== undefined) {
    const sql = `SELECT revision FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`;
    const values = [input.route, input.accountId, input.labelId] as const;
    const plan = labelSqlPlan('assignment.parent-revision', sql, values, {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      output: { revision: 2_147_483_647 },
      outputRows: 1,
    });
    const parent = await executeLabelSql(plan, (operands) =>
      client.query<{ revision: number }>(plan.sql, [...operands]),
    );
    if (parent.rows[0]?.revision !== expectedLabelRevision) return { row: null, parentChanged: true as const };
  }
  const db = { query: client.query.bind(client) };
  const readInput = { ...parameters(input), assignment_id: input.assignmentId, time: context.time };
  const plan = labelSqlPlan('assignment.observe', read.sql, readInput, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 1,
    output: {
      route: 65_535,
      accountId: 'f'.repeat(36),
      subjectId: 'f'.repeat(36),
      labelId: 'f'.repeat(36),
      id: 'f'.repeat(36),
      revision: 2_147_483_647,
      slotNo: 31,
      createdAt: '\u0000'.repeat(64),
      updatedAt: '\u0000'.repeat(64),
      deletedAt: '\u0000'.repeat(64),
      purgeAfter: '\u0000'.repeat(64),
      transactionId: 'f'.repeat(36),
      identityMatches: false,
      started: false,
      expired: false,
    },
    outputRows: 1,
  });
  return executeLabelSql(plan, (operands) => read.run(db, operands)).then((row) => ({
    row,
    parentChanged: false as const,
  }));
}

async function unassignStoredLabelAssignmentInOperation(
  client: Client,
  input: Expected,
  context: Context,
  expectedLabelRevision?: number,
  expectedTarget?: { labelId: string; assignmentId: string; revision: number; labelRevision: number },
): Promise<UnassignStoredLabelAssignmentResult> {
  const observation = await observe(client, input, context, expectedLabelRevision);
  if (observation.parentChanged) return { kind: 'stale' };
  const row = observation.row;
  if (!row) return { kind: 'not_found' };
  if (row.id === null) return { kind: 'migration_required' };
  if (!row.identityMatches || row.revision !== input.revision || row.deletedAt !== null) return { kind: 'stale' };
  if (expectedTarget) {
    const sql = `SELECT revision FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`;
    const values = [input.route, input.accountId, expectedTarget.labelId] as const;
    const plan = labelSqlPlan('assignment.target-parent-revision', sql, values, {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      output: { revision: 2_147_483_647 },
      outputRows: 1,
    });
    const targetParent = await executeLabelSql(plan, (operands) =>
      client.query<{ revision: number }>(plan.sql, [...operands]),
    );
    if (targetParent.rows[0]?.revision !== expectedTarget.labelRevision) return { kind: 'stale' };
    const target = await readStoredLabelAssignment(client, { ...input, labelId: expectedTarget.labelId });
    if (
      target?.id !== expectedTarget.assignmentId ||
      target.revision !== expectedTarget.revision ||
      target.deletedAt !== null ||
      target.slotNo === null
    )
      return { kind: 'stale' };
  }
  if (row.revision === 2_147_483_647) throw new RangeError('Label assignment revision exhausted');
  const unassignInput = {
    ...parameters(input),
    assignment_id: input.assignmentId,
    revision: input.revision,
    time: context.time,
    transaction_id: context.transactionId,
  };
  const unassignPlan = labelSqlPlan('assignment.unassign', unassign.sql, unassignInput, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 0,
    output: {
      route: 65_535,
      accountId: 'f'.repeat(36),
      subjectId: 'f'.repeat(36),
      labelId: 'f'.repeat(36),
      id: 'f'.repeat(36),
      revision: 2_147_483_647,
      slotNo: 31,
      createdAt: '\u0000'.repeat(64),
      updatedAt: '\u0000'.repeat(64),
      deletedAt: '\u0000'.repeat(64),
      purgeAfter: '\u0000'.repeat(64),
      transactionId: 'f'.repeat(36),
    },
    outputRows: 1,
  });
  const rows = await executeLabelSql(unassignPlan, (operands) =>
    unassign.run({ query: client.query.bind(client) }, operands),
  );
  if (!rows[0]) throw new TypeError('Label assignment unassign lost its guarded observation');
  return { kind: 'applied', assignment: record(rows[0]) };
}

async function restoreStoredLabelAssignmentInOperation(
  client: Client,
  input: Expected,
  context: Context,
): Promise<RestoreStoredLabelAssignmentResult> {
  const row = (await observe(client, input, context)).row;
  if (!row) return { kind: 'not_found' };
  if (row.id === null) return { kind: 'migration_required' };
  if (!row.identityMatches || row.revision !== input.revision || row.deletedAt === null) return { kind: 'stale' };
  if (row.expired) return { kind: 'expired' };
  if (!row.started) return { kind: 'stale' };
  // Native timestamp predicates above retain database precision; admission owns the only capacity algorithm.
  const result = await setLabelAssignment(client, input, context);
  if (result.kind === 'existing') throw new TypeError('Label assignment restore found an impossible live observation');
  if (result.kind === 'changed') return { kind: 'stale' };
  if (result.kind === 'applied' && (result.assignment.id !== row.id || result.assignment.revision !== row.revision + 1))
    throw new TypeError('Label assignment restore changed retained identity or revision');
  return result.kind === 'applied' ? { kind: 'applied', assignment: result.assignment } : { kind: result.kind };
}

/** The retained episode and optional exact target are priced before the guard/read sequence. */
export async function unassignStoredLabelAssignment(
  client: Client,
  input: Expected,
  context: Context,
  expectedLabelRevision?: number,
  expectedTarget?: { labelId: string; assignmentId: string; revision: number; labelRevision: number },
): Promise<UnassignStoredLabelAssignmentResult> {
  const plan = labelAssignmentLifecyclePlan({
    ...input,
    time: context.time,
    transactionId: context.transactionId,
    ...(expectedLabelRevision === undefined ? {} : { expectedLabelRevision }),
    ...(expectedTarget === undefined ? {} : { expectedTarget }),
  });
  return executeLabelOperation(plan, () =>
    unassignStoredLabelAssignmentInOperation(client, input, context, expectedLabelRevision, expectedTarget),
  );
}

/** Restore composes retained identity observation with the existing capacity admission once. */
export async function restoreStoredLabelAssignment(
  client: Client,
  input: Expected,
  context: Context,
): Promise<RestoreStoredLabelAssignmentResult> {
  const plan = labelAssignmentLifecyclePlan({
    ...input,
    time: context.time,
    transactionId: context.transactionId,
    restore: true,
  });
  return executeLabelOperation(plan, () => restoreStoredLabelAssignmentInOperation(client, input, context));
}
