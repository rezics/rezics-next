import type { PoolClient } from 'pg';
import insertLabel from './label-store-insert.sql';
import lifecycleLabel from './label-store-lifecycle.sql';
import readLabel from './label-store-read.sql';
import renameLabel from './label-store-rename.sql';

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
export function normalizePersonalLabelName(input: unknown): string {
  if (typeof input !== 'string') throw new TypeError('A personal label name must be a string');
  const name = input
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ | $/g, '');
  if (name.length === 0 || /[\p{Cc}\p{Cs}]/u.test(name))
    throw new TypeError('A personal label name must be nonempty and contain no controls or lone surrogates');
  let scalars = 0;
  for (const _scalar of name) {
    if (++scalars > 100) throw new RangeError('A personal label name is at most 100 Unicode scalars');
  }
  return name;
}

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function asRecord(row: LabelRecord): LabelRecord {
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
  const rows = await insertLabel.run(queryClient(client), {
    route,
    account_id: label.accountId,
    label_id: label.id,
    name: normalizePersonalLabelName(label.name),
    transaction_id: context.transactionId,
    time: context.time,
  });
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
  const row = await readLabel.run(queryClient(client), {
    route,
    account_id: accountId,
    label_id: labelId,
    include_deleted: includeDeleted,
  });
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
  const rows = await renameLabel.run(queryClient(client), {
    route,
    account_id: accountId,
    label_id: labelId,
    revision: expectedRevision,
    name: normalizePersonalLabelName(name),
    transaction_id: context.transactionId,
    time: context.time,
  });
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
  const rows = await lifecycleLabel.run(queryClient(client), {
    route,
    account_id: accountId,
    label_id: labelId,
    revision: expectedRevision,
    transaction_id: context.transactionId,
    time: context.time,
    restore,
  });
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
