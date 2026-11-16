import type { CommandTransaction } from '../command/command.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { identityJobPartition } from '../semantic/identity-adapters/identity-epoch-contract.ts';
import { identityEpochStore, type IdentityJobRef } from '../semantic/identity-adapters/index.ts';
import type { IdentityFrontier } from '../semantic/identity-epoch-contract.ts';
import { snapshotSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import {
  readSearchIdentityDirectorySql,
  readSearchIdentityMaterializedOriginalSql,
} from './identity-search-receiving-directory-sql.ts';

const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Search directory or checkpoint changed');
type Directory = Readonly<{
  scope: string;
  transactionId: string | null;
  after: string | null;
  count: number;
}>;

export async function readSearchIdentityDirectory(tx: CommandTransaction, job: IdentityJobRef): Promise<Directory> {
  const row = (
    await tx.query<{ scope_digest: string; transaction_id: string | null; frontier: unknown; proven: boolean }>(
      readSearchIdentityDirectorySql,
      [identityJobPartition(job), job.jobId, String(job.epoch)],
    )
  ).rows[0];
  if (!row?.proven || !/^[0-9a-f]{64}$/.test(row.scope_digest)) throw unavailable();
  if (row.transaction_id === null) return { scope: row.scope_digest, transactionId: null, after: null, count: 0 };
  const frontier = snapshotSearchIdentityReceivingFrontier(row.frontier);
  const [kind, after, count] = frontier?.after ?? [];
  if (
    frontier?.segment !== 0 ||
    frontier.after.length !== 3 ||
    kind !== 'search-directory' ||
    typeof after !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(after) ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 1
  )
    throw unavailable();
  return { scope: row.scope_digest, transactionId: row.transaction_id, after, count };
}

export async function requireCurrentSearchIdentityDirectory(
  tx: CommandTransaction,
  job: IdentityJobRef,
  expected: Directory,
) {
  const actual = await readSearchIdentityDirectory(tx, job);
  if (actual.transactionId !== expected.transactionId || actual.scope !== expected.scope) throw unavailable();
}

export async function readSearchIdentityDirectoryOriginal(
  tx: CommandTransaction,
  job: IdentityJobRef,
  directory: Directory,
) {
  const page = await identityEpochStore().pageChanges(tx, job, directory.after, 1);
  const input = page.changes[0];
  const materialized = (
    await tx.query<{ original: string; previous_terminal: string; terminal: string }>(
      readSearchIdentityMaterializedOriginalSql,
      [identityJobPartition(job), job.jobId, directory.after],
    )
  ).rows[0];
  if (!materialized) return input ?? null;
  if (input && input.original <= materialized.original) {
    if (
      input.original === materialized.original &&
      (input.previousTerminal !== materialized.previous_terminal || input.terminal !== materialized.terminal)
    )
      throw unavailable();
    return input;
  }
  return {
    original: materialized.original,
    previousTerminal: materialized.previous_terminal,
    terminal: materialized.terminal,
  };
}

export function advanceSearchIdentityDirectory(directory: Directory, original: string): IdentityFrontier {
  if ((directory.after !== null && original <= directory.after) || !Number.isSafeInteger(directory.count + 1))
    throw unavailable();
  return { after: ['search-directory', original, directory.count + 1], segment: 0 };
}
