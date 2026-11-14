import { expect, test } from 'bun:test';
import type { CommandTransaction } from '../../src/command/command.ts';
import { bindReceiptKeys, encodeReceiptKey } from '../../src/command/receipt-key.ts';
import { libraryBulkReceiptReadiness } from '../../src/history/adapters/library-bulk-receipts.ts';
import type { HistoryArtifact, HistoryBarrier } from '../../src/history/contract/index.ts';
import { LIBRARY_BULK_TARGET_COMMAND_KIND_ID } from '../../src/history/contract/index.ts';
import type { TargetEvidence } from '../../src/library/bulk-contract.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const sourceRoute = 0x1200;
const targetRoute = 0x2410;
const accountId = newId(sourceRoute);
const operationId = newId(sourceRoute);
const collectionId = newId(targetRoute);
const sourceDigest = 'ab'.repeat(32);
const rawReceiptKey = `${operationId}:0`;
const keyRing: KeyRing = { current: 2, keys: new Map<number, Uint8Array>([[2, Buffer.alloc(32, 17)]]) };
const targetReceiptToken = encodeReceiptKey(
  keyRing,
  'library.collectionBulk.target',
  { kind: 'account', id: accountId },
  rawReceiptKey,
);
const receipt = {
  partition: partitionOf(targetRoute),
  principalKind: 'account' as const,
  principalId: accountId,
  commandKind: 'library.collectionBulk.target' as const,
  key: rawReceiptKey,
  digest: 'cd'.repeat(32),
};
const transactionId = newId(targetRoute);
const evidence: TargetEvidence = {
  operationId,
  ordinal: '0',
  sourceDigest,
  receipt,
  transactionId,
  outcome: 'applied',
  reason: null,
  resultingMemberId: newId(targetRoute),
};
const artifact: HistoryArtifact = {
  partition: partitionOf(targetRoute),
  locator: {
    artifactType: 'command-receipt/v1',
    partitionNo: partitionOf(targetRoute),
    principalKind: 'account',
    principalId: accountId,
    commandKindId: LIBRARY_BULK_TARGET_COMMAND_KIND_ID,
    keyVersion: 2,
    keyToken: Buffer.from(targetReceiptToken.split('.')[2]!, 'base64url').toString('hex'),
  },
  accounts: [{ accountRoute: sourceRoute, accountId, roles: 32 }],
};
const barrier: HistoryBarrier = {
  accountRoute: sourceRoute,
  accountId,
  version: 4,
  at: '2026-11-14T10:00:00.000Z',
};

function transaction(input: { sourceEvidence: TargetEvidence | null; sourceState: string; barrierVersion?: number }) {
  const source = {
    sourceDigest,
    request: { action: 'add_to_collection', collectionId },
    target: { kind: 'subject', collectionId },
    receipt,
    state: input.sourceState,
    evidence: input.sourceEvidence,
  };
  const exactReceipt = {
    idempotencyKey: targetReceiptToken,
    digest: Buffer.from(receipt.digest, 'hex'),
    transactionId,
    payloadState: 'present' as const,
    response: evidence,
  };
  const tx = {
    async query(sql: string) {
      if (sql.includes('FROM core.receipt')) return { rows: [exactReceipt] };
      if (sql.includes('FROM library.bulk_operation')) return { rows: [source] };
      if (sql.includes('FROM access.erasure'))
        return { rows: [{ version: input.barrierVersion ?? barrier.version, at: barrier.at }] };
      throw new Error(`Unexpected custody query: ${sql}`);
    },
  };
  bindReceiptKeys(tx, keyRing);
  return tx as unknown as CommandTransaction;
}

test('History accepts the exact committed source acknowledgement and tombstone-before-ack closure only', async () => {
  const acknowledged = await libraryBulkReceiptReadiness(transaction({ sourceEvidence: evidence, sourceState: 'applied' }), artifact, barrier);
  expect(acknowledged).toEqual({ ready: true });

  const tombstonedBeforeAck = await libraryBulkReceiptReadiness(
    transaction({ sourceEvidence: null, sourceState: 'pending' }),
    artifact,
    barrier,
  );
  expect(tombstonedBeforeAck).toEqual({ ready: true });

  const changedBarrier = await libraryBulkReceiptReadiness(
    transaction({ sourceEvidence: null, sourceState: 'pending', barrierVersion: barrier.version + 1 }),
    artifact,
    barrier,
  );
  expect(changedBarrier).toMatchObject({ ready: false });
});
