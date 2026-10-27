import { expect, test } from 'bun:test';
import { newId, partitionOf } from '../../src/route/route.ts';
import { preparationHeaderCommitment } from '../../src/library/preparation-bindings.ts';
test('preparation creator commitment binds the complete native header without source text', () => {
  const route = 0x6a10,
    accountId = newId(route),
    subjectId = newId(0x7b20),
    sourcePartition = partitionOf(0x7b20),
    transactionId = newId(0x7b20),
    preparationId = newId(route);
  const identity = {
    sourceId: subjectId,
    partition: sourcePartition,
    epoch: 2,
    revision: 4,
    transactionId,
    redirect: null,
  };
  const payload = {
    version: 1 as const,
    route,
    accountId,
    preparationId,
    binding: {
      accountId,
      subjectId,
      requestKey: 'request-key',
      sourceId: subjectId,
      sourcePartition,
      sourceEpoch: 2,
      sourcePosition: '9007199254740993',
      ownerEpoch: '3',
    },
    origin: {
      sourceId: subjectId,
      partition: sourcePartition,
      epoch: 2,
      position: '9007199254740993',
      survivorId: null,
    },
    sourceIdentity: identity,
    originIdentity: identity,
    principalNamespace: {
      principal: { kind: 'account' as const, id: accountId },
      basis: { clientId: 'website', requestedBy: null },
    },
    reservationId: newId(route),
    inputByteLength: '9007199254740993',
    inputDigest: 'a'.repeat(64),
    creationTransactionId: newId(route),
    creationReceipt: {
      partition: partitionOf(route),
      principalKind: 'account' as const,
      principalId: accountId,
      commandKind: 'library.type-preparation.create',
      key: 'metadata-key',
      digest: 'b'.repeat(64),
    },
    createdAt: '2026-10-27T00:00:00.000001Z',
  };
  const digest = preparationHeaderCommitment(payload);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  for (const changed of [
    { ...payload, createdAt: '2026-10-27T00:00:00.000002Z' },
    { ...payload, inputByteLength: '9007199254740992' },
    { ...payload, sourceIdentity: { ...identity, revision: 5 } },
    { ...payload, originIdentity: { ...identity, transactionId: newId(0x7b20) } },
    { ...payload, creationReceipt: { ...payload.creationReceipt, key: 'other' } },
  ])
    expect(preparationHeaderCommitment(changed)).not.toBe(digest);
  expect(() => preparationHeaderCommitment({ ...payload, inputByteLength: '01' })).toThrow();
  expect(() => preparationHeaderCommitment({ ...payload, fullType: 'schema:Secret' } as typeof payload)).toThrow();
});
