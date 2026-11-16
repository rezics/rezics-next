import type { CommandTransaction } from '../command/command.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { identityJobPartition } from '../semantic/identity-adapters/identity-epoch-contract.ts';
import { identityEpochStore, type IdentityJobRef } from '../semantic/identity-adapters/index.ts';
import type { IdentityFrontier, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  SEARCH_IDENTITY_WRITER_ACCEPT,
  SEARCH_IDENTITY_WRITER_DISPATCH,
  SEARCH_IDENTITY_WRITER_REQUEST,
} from '../semantic/contract/identity-epoch-ports.ts';
import { snapshotSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import {
  readSearchIdentityDirectorySql,
  readSearchIdentityMaterializedOriginalSql,
} from './identity-search-receiving-directory-sql.ts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Search directory or checkpoint changed');
export type SearchWriterPlanRequest = Readonly<{ planId: string; holdId?: string }>;

type Directory = Readonly<{
  scope: string;
  release: string;
  transactionId: string | null;
  after: string | null;
  count: number;
  writerRequest?: {
    frontier: IdentityFrontier;
    native: IdentityNativeReceipt;
    original: string;
    terminal: string;
    plan?: SearchWriterPlanRequest;
  };
}>;

export async function readSearchIdentityDirectory(tx: CommandTransaction, job: IdentityJobRef): Promise<Directory> {
  const row = (
    await tx.query<{
      scope_digest: string;
      release: string;
      transaction_id: string | null;
      native_epoch: number | null;
      native_position: string | null;
      frontier: unknown;
      proven: boolean;
    }>(readSearchIdentityDirectorySql, [identityJobPartition(job), job.jobId, String(job.epoch)])
  ).rows[0];
  if (!row?.proven || !/^[0-9a-f]{64}$/.test(row.scope_digest) || !/^sha256:[0-9a-f]{64}$/.test(row.release))
    throw unavailable();
  if (row.transaction_id === null)
    return { scope: row.scope_digest, release: row.release, transactionId: null, after: null, count: 0 };
  const frontier = snapshotSearchIdentityReceivingFrontier(row.frontier);
  const [kind, after, count, action, original, terminal, planId, holdId] = frontier?.after ?? [];
  if (
    frontier?.segment !== 0 ||
    kind !== 'search-directory' ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (count === 0 ? after !== null : typeof after !== 'string' || !uuid.test(after))
  )
    throw unavailable();
  const previous = {
    scope: row.scope_digest,
    release: row.release,
    transactionId: row.transaction_id,
    after: after as string | null,
    count,
  };
  if (frontier.after.length === 3 && count > 0) return previous;
  const plan =
    action === SEARCH_IDENTITY_WRITER_DISPATCH &&
    frontier.after.length === 8 &&
    typeof planId === 'string' &&
    uuid.test(planId) &&
    typeof holdId === 'string' &&
    uuid.test(holdId)
      ? { planId, holdId }
      : action === SEARCH_IDENTITY_WRITER_ACCEPT &&
          frontier.after.length === 7 &&
          typeof planId === 'string' &&
          uuid.test(planId)
        ? { planId }
        : undefined;
  if (
    (!plan && (frontier.after.length !== 6 || action !== SEARCH_IDENTITY_WRITER_REQUEST)) ||
    typeof original !== 'string' ||
    !uuid.test(original) ||
    typeof terminal !== 'string' ||
    !uuid.test(terminal) ||
    (typeof after === 'string' && original <= after) ||
    !row.native_epoch ||
    !row.native_position ||
    !/^[1-9][0-9]*$/.test(row.native_position)
  )
    throw unavailable();
  return {
    ...previous,
    writerRequest: {
      frontier,
      original,
      terminal,
      ...(plan && { plan }),
      native: {
        partition: identityJobPartition(job),
        transactionId: row.transaction_id,
        epoch: row.native_epoch,
        position: BigInt(row.native_position),
      },
    },
  };
}

export async function requireCurrentSearchIdentityDirectory(
  tx: CommandTransaction,
  job: IdentityJobRef,
  expected: Directory,
) {
  const actual = await readSearchIdentityDirectory(tx, job);
  if (
    actual.transactionId !== expected.transactionId ||
    actual.scope !== expected.scope ||
    actual.release !== expected.release
  )
    throw unavailable();
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

export function requestSearchIdentityWriter(
  directory: Directory,
  original: string,
  terminal: string,
  plan?: SearchWriterPlanRequest,
): IdentityFrontier {
  const prior = directory.writerRequest;
  if (
    (prior && (!plan || prior.plan?.holdId || (prior.plan && prior.plan.planId !== plan.planId))) ||
    (directory.after !== null && original <= directory.after)
  )
    throw unavailable();
  return {
    after: [
      'search-directory',
      directory.after,
      directory.count,
      plan?.holdId
        ? SEARCH_IDENTITY_WRITER_DISPATCH
        : plan
          ? SEARCH_IDENTITY_WRITER_ACCEPT
          : SEARCH_IDENTITY_WRITER_REQUEST,
      original,
      terminal,
      ...(plan ? [plan.planId] : []),
      ...(plan?.holdId ? [plan.holdId] : []),
    ],
    segment: 0,
  };
}
