import { isDeepStrictEqual } from 'node:util';
import { deadlineFor } from '../../request/deadline.ts';
import {
  DEFAULT_REQUEST_DEADLINE_MS,
  currentCommand,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../../command/command.ts';
import { nativeReceiptKeyCandidates } from '../../command/receipt-key.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import type {
  HistoryArtifact,
  HistoryBarrier,
  HistoryRegistry,
  HistoryReadiness,
  LibraryBulkReceiptBinding,
  LibraryBulkReceiptDisposition,
  LibraryBulkReceiptDispositionPort,
  LibraryBulkReceiptLocator,
} from '../contract/index.ts';
import {
  decodeLocator,
  encodeLocator,
  LIBRARY_BULK_TARGET_COMMAND_KIND,
  LIBRARY_BULK_TARGET_COMMAND_KIND_ID,
} from '../contract/index.ts';
import { lockHistoryBarrier, recordHistoryReceivingProof, verifyCurrentHistoryReceiving } from './receiving.ts';
import { minimizeHistoryReceipt } from './receipt.ts';
import { nativePool } from './handles.ts';

type SourceRow = Readonly<{
  sourceDigest: string;
  request: Record<string, unknown>;
  target: Record<string, unknown>;
  receipt: LibraryBulkReceiptLocator;
  state: string;
  evidence: unknown;
}>;
type CoreReceipt = Readonly<{
  idempotencyKey: string;
  digest: Buffer;
  transactionId: string | null;
  payloadState: 'present' | 'minimized';
  response: unknown;
}>;
type LibraryBulkReceiptEvidence = Readonly<{
  operationId: string;
  ordinal: string;
  sourceDigest: string;
  receipt: LibraryBulkReceiptLocator;
  transactionId: string | null;
  outcome: 'applied' | 'no_effect' | 'conflict' | 'denied' | 'failed' | 'cancelled';
}>;
type DispositionBinding = Readonly<{
  source: LibraryBulkReceiptBinding;
  barrier: HistoryBarrier;
  transactionId: string;
  locator: Buffer;
}>;

const dispositions = new WeakMap<LibraryBulkReceiptDisposition, DispositionBinding>();
const terminalOutcomes: ReadonlySet<string> = new Set([
  'applied',
  'no_effect',
  'conflict',
  'denied',
  'failed',
  'cancelled',
]);

function isTerminalOutcome(value: unknown): value is LibraryBulkReceiptEvidence['outcome'] {
  return typeof value === 'string' && terminalOutcomes.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function receiptEvidence(value: unknown): LibraryBulkReceiptEvidence | null {
  if (!isRecord(value) || !isRecord(value.receipt)) return null;
  const operationId = value.operationId;
  const ordinal = value.ordinal;
  const sourceDigest = value.sourceDigest;
  const transactionId = value.transactionId;
  const outcome = value.outcome;
  const receipt = value.receipt;
  if (
    typeof operationId !== 'string' ||
    typeof ordinal !== 'string' ||
    typeof sourceDigest !== 'string' ||
    (transactionId !== null && typeof transactionId !== 'string') ||
    !isTerminalOutcome(outcome) ||
    typeof receipt.partition !== 'number' ||
    typeof receipt.principalId !== 'string' ||
    receipt.principalKind !== 'account' ||
    receipt.commandKind !== LIBRARY_BULK_TARGET_COMMAND_KIND ||
    typeof receipt.key !== 'string' ||
    typeof receipt.digest !== 'string'
  )
    return null;
  return {
    operationId,
    ordinal,
    sourceDigest,
    receipt: {
      partition: receipt.partition,
      principalKind: 'account',
      principalId: receipt.principalId,
      commandKind: LIBRARY_BULK_TARGET_COMMAND_KIND,
      key: receipt.key,
      digest: receipt.digest,
    },
    transactionId,
    outcome,
  };
}

function validBinding(binding: LibraryBulkReceiptBinding): boolean {
  return (
    routeOf(binding.accountId) === binding.accountRoute &&
    routeOf(binding.operationId) === binding.accountRoute &&
    /^[a-f0-9]{64}$/.test(binding.sourceDigest) &&
    /^(0|[1-9][0-9]*)$/.test(binding.ordinal) &&
    Number(binding.ordinal) < 1_000 &&
    binding.receipt.principalKind === 'account' &&
    binding.receipt.principalId === binding.accountId &&
    binding.receipt.commandKind === LIBRARY_BULK_TARGET_COMMAND_KIND &&
    Number.isInteger(binding.receipt.partition) &&
    binding.receipt.partition >= 0 &&
    binding.receipt.partition < 4_096 &&
    binding.receipt.partition !== partitionOf(binding.accountRoute) &&
    typeof binding.receipt.key === 'string' &&
    binding.receipt.key.length > 0 &&
    binding.receipt.key.length <= 255 &&
    /^[a-f0-9]{64}$/.test(binding.receipt.digest)
  );
}

function sameSource(left: LibraryBulkReceiptBinding, right: LibraryBulkReceiptBinding): boolean {
  return (
    left.accountRoute === right.accountRoute &&
    left.accountId === right.accountId &&
    left.operationId === right.operationId &&
    left.sourceDigest === right.sourceDigest &&
    left.ordinal === right.ordinal &&
    isDeepStrictEqual(left.receipt, right.receipt)
  );
}

function remoteTarget(row: SourceRow, route: number): boolean {
  const action = row.request.action;
  const targetKind = row.target.kind;
  const collectionId = row.target.collectionId;
  const requestedCollectionId = row.request.collectionId;
  const targetRoute = typeof collectionId === 'string' ? routeOf(collectionId) : null;
  return (
    ((action === 'add_to_collection' && targetKind === 'subject') ||
      (action === 'remove_from_collection' && targetKind === 'occurrence')) &&
    targetRoute !== null &&
    targetRoute !== route &&
    row.receipt.partition === partitionOf(targetRoute) &&
    collectionId === requestedCollectionId
  );
}

async function sourceRow(
  tx: CommandTransaction,
  binding: LibraryBulkReceiptBinding,
  lock: 'share' | 'update',
): Promise<SourceRow | null> {
  const row = (
    await tx.query<SourceRow>(
      `SELECT operation.source_digest AS "sourceDigest", operation.request, target.target, target.receipt,
        target.state, target.evidence
       FROM library.bulk_operation operation
       JOIN library.bulk_target target ON target.route=operation.route
         AND target.operation_id=operation.operation_id AND target.account_id=operation.account_id
       WHERE operation.route=$1 AND operation.operation_id=$2 AND operation.account_id=$3 AND target.ordinal=$4
       FOR ${lock.toUpperCase()} OF operation,target`,
      [binding.accountRoute, binding.operationId, binding.accountId, binding.ordinal],
    )
  ).rows[0];
  if (
    !row ||
    row.sourceDigest !== binding.sourceDigest ||
    !isDeepStrictEqual(row.receipt, binding.receipt) ||
    !remoteTarget(row, binding.accountRoute)
  )
    return null;
  return row;
}

async function sourceBarrier(tx: CommandTransaction, accountId: string, accountRoute: number) {
  return (
    await tx.query<{ version: number; at: string }>(
      'SELECT version,at::text AS at FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
      [accountRoute, accountId],
    )
  ).rows[0];
}

function receiptToken(locator: HistoryArtifact['locator']): string {
  if (locator.artifactType !== 'command-receipt/v1') throw new TypeError('Library bulk receipt locator mismatch');
  return `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`;
}

async function readReceipt(
  tx: CommandTransaction,
  binding: LibraryBulkReceiptBinding,
): Promise<{
  locator: Extract<HistoryArtifact['locator'], { artifactType: 'command-receipt/v1' }>;
  receipt: CoreReceipt;
} | null> {
  const keys = nativeReceiptKeyCandidates(tx, LIBRARY_BULK_TARGET_COMMAND_KIND, binding.accountId, binding.receipt.key);
  const rows = (
    await tx.query<CoreReceipt>(
      `SELECT idempotency_key AS "idempotencyKey",request_digest AS digest,transaction_id AS "transactionId",
        payload_state AS "payloadState",response
       FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=ANY($4::text[]) LIMIT 2 FOR UPDATE`,
      [binding.receipt.partition, binding.accountId, LIBRARY_BULK_TARGET_COMMAND_KIND, keys],
    )
  ).rows;
  if (rows.length !== 1) return null;
  const receipt = rows[0]!;
  if (!Buffer.from(receipt.digest).equals(Buffer.from(binding.receipt.digest, 'hex'))) return null;
  const token = /^rk1\.(0|[1-9][0-9]*)\.([A-Za-z0-9_-]{43})$/.exec(receipt.idempotencyKey);
  const version = Number(token?.[1]);
  if (!token || !Number.isInteger(version) || version > 0xffff) return null;
  const locator = {
    artifactType: 'command-receipt/v1' as const,
    partitionNo: binding.receipt.partition,
    principalKind: 'account' as const,
    principalId: binding.accountId,
    commandKindId: LIBRARY_BULK_TARGET_COMMAND_KIND_ID,
    keyVersion: version,
    keyToken: Buffer.from(token[2]!, 'base64url').toString('hex'),
  };
  return { locator, receipt };
}

function evidenceMatches(
  value: unknown,
  receipt: CoreReceipt,
  binding: LibraryBulkReceiptBinding,
): value is LibraryBulkReceiptEvidence {
  const evidence = receiptEvidence(value);
  return (
    evidence !== null &&
    evidence.transactionId !== null &&
    receipt.transactionId !== null &&
    evidence.transactionId === receipt.transactionId &&
    evidence.operationId === binding.operationId &&
    evidence.ordinal === binding.ordinal &&
    evidence.sourceDigest === binding.sourceDigest &&
    isRecord(value) &&
    isDeepStrictEqual(value.receipt, binding.receipt) &&
    Buffer.from(binding.receipt.digest, 'hex').equals(Buffer.from(receipt.digest))
  );
}

async function readiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<HistoryReadiness> {
  const pending = (gap: string): HistoryReadiness => ({ ready: false, gap });
  if (
    artifact.locator.artifactType !== 'command-receipt/v1' ||
    artifact.locator.commandKindId !== LIBRARY_BULK_TARGET_COMMAND_KIND_ID ||
    artifact.partition !== artifact.locator.partitionNo
  )
    return pending('library-bulk-receipt-locator-unavailable');

  const sourceAccount = artifact.locator.principalId;
  const sourceRoute = routeOf(sourceAccount);
  if (sourceRoute === null || artifact.locator.principalKind !== 'account')
    return pending('library-bulk-receipt-source-unavailable');

  // The actual artifact locator, rather than caller JSON, is authoritative here. Locate the
  // receipt by its already-HMACed native key and validate the source binding from its response.
  const exact = (
    await tx.query<CoreReceipt>(
      `SELECT idempotency_key AS "idempotencyKey",request_digest AS digest,transaction_id AS "transactionId",
        payload_state AS "payloadState",response
       FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=$4 FOR UPDATE`,
      [artifact.partition, sourceAccount, LIBRARY_BULK_TARGET_COMMAND_KIND, receiptToken(artifact.locator)],
    )
  ).rows[0];
  if (!exact) return pending('library-bulk-receipt-source-unavailable');
  const coreReceipt: CoreReceipt = exact;

  if (coreReceipt.payloadState === 'minimized') {
    const sourceErasure = await sourceBarrier(tx, sourceAccount, sourceRoute);
    if (!sourceErasure) return pending('library-bulk-receipt-minimized-source-proof-unavailable');
    const sourceBarrierValue = {
      accountId: sourceAccount,
      accountRoute: sourceRoute,
      version: sourceErasure.version,
      at: sourceErasure.at,
    };
    return (await verifyCurrentHistoryReceiving(tx, sourceBarrierValue, artifact))
      ? { ready: true }
      : pending('library-bulk-receipt-minimized-source-proof-unavailable');
  }

  const evidence = receiptEvidence(coreReceipt.response);
  if (!evidence || evidence.transactionId === null || coreReceipt.transactionId === null)
    return pending('library-bulk-receipt-response-unavailable');
  const binding: LibraryBulkReceiptBinding = {
    accountRoute: sourceRoute,
    accountId: sourceAccount,
    operationId: evidence.operationId,
    sourceDigest: evidence.sourceDigest,
    ordinal: evidence.ordinal,
    receipt: evidence.receipt,
  };
  if (!validBinding(binding) || !evidenceMatches(coreReceipt.response, coreReceipt, binding))
    return pending('library-bulk-receipt-response-unavailable');
  if (
    !nativeReceiptKeyCandidates(tx, LIBRARY_BULK_TARGET_COMMAND_KIND, sourceAccount, binding.receipt.key).includes(
      coreReceipt.idempotencyKey,
    )
  )
    return pending('library-bulk-receipt-locator-mismatch');
  const source = await sourceRow(tx, binding, 'share');
  if (!source) return pending('library-bulk-receipt-source-manifest-unavailable');
  if (source.evidence !== null) {
    const sourceEvidence = receiptEvidence(source.evidence);
    if (
      !sourceEvidence ||
      !evidenceMatches(source.evidence, coreReceipt, binding) ||
      !isDeepStrictEqual(source.evidence, coreReceipt.response)
    )
      return pending('library-bulk-receipt-source-acknowledgement-changed');
    if (source.state !== sourceEvidence.outcome)
      return pending('library-bulk-receipt-source-acknowledgement-changed');
    return { ready: true };
  }

  const sourceErasure = await sourceBarrier(tx, sourceAccount, sourceRoute);
  if (
    barrier.accountId === sourceAccount &&
    barrier.accountRoute === sourceRoute &&
    sourceErasure?.version === barrier.version &&
    sourceErasure.at === barrier.at &&
    (await sourceRow(tx, binding, 'share')) !== null
  )
    return { ready: true };
  return pending('library-bulk-receipt-source-acknowledgement-pending');
}

export function createLibraryBulkReceiptDispositionPort(history: HistoryRegistry): LibraryBulkReceiptDispositionPort {
  return {
    async settle(poolHandle, source) {
      if (!validBinding(source)) return null;
      const pool = nativePool(poolHandle);
      const settled = await runCommand<DispositionBinding | null>(
        pool,
        { partition: source.receipt.partition, deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) },
        async (tx) => {
          const committed = await sourceBarrier(tx, source.accountId, source.accountRoute);
          if (!committed) return noEffect(null);
          const barrier: HistoryBarrier = {
            accountId: source.accountId,
            accountRoute: source.accountRoute,
            version: committed.version,
            at: committed.at,
          };
          if (!(await lockHistoryBarrier(tx, barrier))) return noEffect(null);
          const row = await sourceRow(tx, source, 'share');
          if (!row) return noEffect(null);
          const resolved = await readReceipt(tx, source);
          if (!resolved) return noEffect(null);
          const evidence = resolved.receipt.response;
          if (resolved.receipt.payloadState === 'present' && !evidenceMatches(evidence, resolved.receipt, source))
            return noEffect(null);

          const locatorBytes = Buffer.from(encodeLocator(resolved.locator));
          let gap: string | null;
          try {
            gap = await minimizeHistoryReceipt(
              tx,
              {
                partition_no: source.receipt.partition,
                account_route: source.accountRoute,
                account_id: source.accountId,
              },
              locatorBytes,
              history,
              barrier,
            );
          } catch (error) {
            // Old or incomplete producer rows have no native History association. They stay
            // pending so this target cannot stall unrelated local account cleanup.
            if (error instanceof TypeError && error.message === 'Receipt source scope proof unavailable')
              return noEffect(null);
            throw error;
          }
          if (gap) return noEffect(null);
          const receivingGap = await recordHistoryReceivingProof(
            tx,
            barrier,
            source.receipt.partition,
            resolved.locator,
            pool,
          );
          if (receivingGap) return noEffect(null);
          if (!resolved.receipt.transactionId) return noEffect(null);
          return noEffect({
            source: structuredClone(source),
            barrier,
            transactionId: resolved.receipt.transactionId,
            locator: locatorBytes,
          });
        },
      );
      if (!settled.value) return null;
      const disposition = Object.freeze({}) as LibraryBulkReceiptDisposition;
      dispositions.set(disposition, settled.value);
      return disposition;
    },
    async verify(txHandle, binding, disposition) {
      if (!validBinding(binding)) return false;
      const held = dispositions.get(disposition);
      if (!held || !sameSource(held.source, binding)) return false;
      const tx = txHandle as CommandTransaction;
      if (partitionOf(binding.accountRoute) !== currentCommand(tx).partition) return false;
      if (!(await lockHistoryBarrier(tx, held.barrier))) return false;
      const source = await sourceRow(tx, binding, 'update');
      if (!source) return false;
      if (
        source.evidence &&
        (source.state !== source.evidence.outcome ||
          source.evidence.transactionId !== held.transactionId ||
          source.evidence.operationId !== binding.operationId ||
          source.evidence.ordinal !== binding.ordinal ||
          source.evidence.sourceDigest !== binding.sourceDigest ||
          !isDeepStrictEqual(source.evidence.receipt, binding.receipt))
      )
        return false;
      return true;
    },
  };
}

export async function libraryBulkReceiptReadiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<HistoryReadiness> {
  return readiness(tx, artifact, barrier);
}
