import type { PoolClient } from 'pg';
import insertLabel from './label-store-insert.sql';
import lifecycleLabel from './label-store-lifecycle.sql';
import readLabel from './label-store-read.sql';
import renameLabel from './label-store-rename.sql';
import {
  executeLabelOperation,
  executeLabelSql,
  LABEL_NAME_SCALARS,
  labelCreatePlan,
  labelLifecyclePlan,
  labelRenamePlan,
  labelSqlPlan,
} from './label-operation-bounds.ts';

type Client = Pick<PoolClient, 'query'>;
type WriteContext = { transactionId: string; time: string };

/** Private catalogue metadata; admission belongs to the owning native command. */
export type LabelRecord = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  purgeAfter: string | null;
};

/** Version 1: preserve case and format characters, and count Unicode scalars after NFC. */
function normalize(input: unknown, allowEmpty: boolean): string {
  if (typeof input !== 'string') throw new TypeError('A personal label name must be a string');
  const name = input
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ | $/g, '');
  if ((!allowEmpty && name.length === 0) || /[\p{Cc}\p{Cs}]/u.test(name))
    throw new TypeError('A personal label name must be nonempty and contain no controls or lone surrogates');
  let scalars = 0;
  for (const _scalar of name) {
    if (++scalars > LABEL_NAME_SCALARS)
      throw new RangeError(`A personal label name is at most ${LABEL_NAME_SCALARS} Unicode scalars`);
  }
  return name;
}

export function normalizePersonalLabelName(input: unknown): string {
  return normalize(input, false);
}

export function normalizePersonalLabelPrefix(input: unknown): string {
  return normalize(input, true);
}

/** Exclusive C-order upper bound, incrementing scalars and skipping surrogate code points. */
export function personalLabelPrefixEnd(prefix: string): string | null {
  const scalars = [...prefix];
  for (let i = scalars.length - 1; i >= 0; i--) {
    let point = scalars[i]!.codePointAt(0)!;
    if (point === 0x10ffff) continue;
    point++;
    if (point === 0xd800) point = 0xe000;
    return scalars.slice(0, i).join('') + String.fromCodePoint(point);
  }
  return null;
}

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function asRecord(
  row: Omit<LabelRecord, 'createdAt' | 'updatedAt'> & { createdAt: string | null; updatedAt: string | null },
): LabelRecord {
  if (row.createdAt === null || row.updatedAt === null) throw new Error('Personal label timestamps are required');
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
    purgeAfter: row.purgeAfter === null ? null : new Date(row.purgeAfter).toISOString(),
  };
}

export async function insertPersonalLabel(
  client: Client,
  route: number,
  label: { accountId: string; id: string; name: unknown },
  context: WriteContext,
): Promise<LabelRecord> {
  const input = {
    route,
    account_id: label.accountId,
    label_id: label.id,
    name: normalizePersonalLabelName(label.name),
    transaction_id: context.transactionId,
    time: context.time,
  };
  const operation = labelCreatePlan({
    route,
    accountId: label.accountId,
    labelId: label.id,
    name: input.name,
    transactionId: context.transactionId,
    time: context.time,
  });
  const plan = operation.leaves[0]!;
  const rows = await executeLabelOperation(operation, () =>
    executeLabelSql(plan, (operands) =>
      insertLabel.run(queryClient(client), operands as Parameters<typeof insertLabel.run>[1]),
    ),
  );
  const row = rows[0];
  if (!row) throw new Error('Personal label insert returned no row');
  return asRecord(row);
}

export async function readPersonalLabel(
  client: Client,
  route: number,
  accountId: string,
  labelId: string,
  includeDeleted = false,
): Promise<LabelRecord | null> {
  const input = {
    route,
    account_id: accountId,
    label_id: labelId,
    include_deleted: includeDeleted,
  };
  const plan = labelSqlPlan('label.read', readLabel.sql, input, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 1,
    output: {
      id: 'f'.repeat(36),
      name: '\u{10ffff}'.repeat(LABEL_NAME_SCALARS),
      revision: 2_147_483_647,
      createdAt: '\u0000'.repeat(64),
      updatedAt: '\u0000'.repeat(64),
      deletedAt: '\u0000'.repeat(64),
      purgeAfter: '\u0000'.repeat(64),
    },
    outputRows: 1,
  });
  const row = await executeLabelSql(plan, (operands) => readLabel.run(queryClient(client), operands));
  return row ? asRecord(row) : null;
}

export async function renamePersonalLabel(
  client: Client,
  route: number,
  accountId: string,
  labelId: string,
  expectedRevision: number,
  name: unknown,
  context: WriteContext,
): Promise<LabelRecord | null> {
  const normalizedName = normalizePersonalLabelName(name);
  const operation = labelRenamePlan({
    route,
    accountId,
    labelId,
    revision: expectedRevision,
    name: normalizedName,
    transactionId: context.transactionId,
    time: context.time,
    includeRead: false,
  });
  const plan = operation.leaves[0]!;
  const rows = await executeLabelOperation(operation, () =>
    executeLabelSql(plan, (operands) =>
      renameLabel.run(queryClient(client), operands as Parameters<typeof renameLabel.run>[1]),
    ),
  );
  return rows[0] ? asRecord(rows[0]) : null;
}

async function lifecycle(
  client: Client,
  route: number,
  accountId: string,
  labelId: string,
  expectedRevision: number,
  context: WriteContext,
  restore: boolean,
): Promise<LabelRecord | null> {
  const operation = labelLifecyclePlan({
    route,
    accountId,
    labelId,
    revision: expectedRevision,
    transactionId: context.transactionId,
    time: context.time,
    restore,
    includeRead: false,
  });
  const plan = operation.leaves[0]!;
  const rows = await executeLabelOperation(operation, () =>
    executeLabelSql(plan, (operands) =>
      lifecycleLabel.run(queryClient(client), operands as Parameters<typeof lifecycleLabel.run>[1]),
    ),
  );
  return rows[0] ? asRecord(rows[0]) : null;
}

export async function deletePersonalLabel(
  client: Client,
  route: number,
  accountId: string,
  labelId: string,
  expectedRevision: number,
  context: WriteContext,
): Promise<LabelRecord | null> {
  return lifecycle(client, route, accountId, labelId, expectedRevision, context, false);
}

export async function restorePersonalLabel(
  client: Client,
  route: number,
  accountId: string,
  labelId: string,
  expectedRevision: number,
  context: WriteContext,
): Promise<LabelRecord | null> {
  return lifecycle(client, route, accountId, labelId, expectedRevision, context, true);
}
