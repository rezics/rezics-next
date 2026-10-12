import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { restoreRequestDigestFromAuthorityDigest, type OwnerRestoreEvidence }
  from '../src/modules/erasure/reconcile.ts';
import { qualificationRef, requireQualification, type ErasuresRecord }
  from '../src/modules/owner/restore-release-binding.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { AccountRecoveryProfileMismatch, assertNativeAccessErasureBaseBinding, assertRecoveryCoverage,
  RestoreLineageConflict, type RecoveryCoverage, type RestoredGraphReleaseExpectation }
  from '../src/modules/work/restore-lineage.ts';

const key = 'ab'.repeat(32);
const evidence: OwnerRestoreEvidence = {
  baseCoverageEnvelope: 'sealed-C0', baseCoverageDigest: 'a'.repeat(64),
  currentCoverageDigest: 'b'.repeat(64), nativeAccessDigest: 'c'.repeat(64),
  baseFenceGeneration: '5', journal: { epoch: '9', count: '3', digest: 'd'.repeat(64) },
};
const record: ErasuresRecord = {
  id: 'erasures', consumer: 'consumer', requestDigest: 'e'.repeat(64),
  outcomeDigest: 'f'.repeat(64), coverageGeneration: '7', erasureEpoch: '9', items: 6, cuts: 'cuts',
};
const expectation: RestoredGraphReleaseExpectation = {
  lineage: { dataEpoch: 'restored', routingEpoch: '2' }, restoreCutover: 'marker',
  saved: { dataEpoch: 'source', graphSequence: '10',
    main: { streamScope: 'main', dataEpoch: 'source', sequence: '8' } },
  effective: { dataEpoch: 'source', graphSequence: '10',
    main: { streamScope: 'main', dataEpoch: 'source', sequence: '8' } },
};

test('OPS12: signed C0 and C1 Account digests cannot be compared across profiles', () => {
  const base: RecoveryCoverage = {
    priorDataEpoch: 'source', priorSequence: '0',
    accountPg: { systemIdentifier: '1', flushedLsn: '0/1', walFile: '000000010000000000000001' },
    account: { rowCount: '0', rowDigest: 'a'.repeat(64) },
    accessOutboxCount: '0', accessOutboxDigest: 'b'.repeat(64),
    accessStateCount: '0', accessStateDigest: 'c'.repeat(64),
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'consumer', dataEpoch: 'source',
      sequence: '0', batchCount: '0', batchDigest: 'd'.repeat(64), eventCount: '0', eventDigest: 'e'.repeat(64) },
    commerce: { version: 1, tables: {} } as RecoveryCoverage['commerce'],
  };
  const current = { ...base, account: { ...base.account, profile: 'authority-v1' as const } };
  for (const legacy of [base, { ...base, account: { ...base.account, profile: 'full-rows' as const } }]) {
    assertRecoveryCoverage(legacy);
    assertRecoveryCoverage(current);
    for (const [c0, c1] of [[legacy, current], [current, legacy]]) {
      try {
        assertNativeAccessErasureBaseBinding(c1!, c0!, 'signed-C0');
        throw new Error('cross-profile binding unexpectedly accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(AccountRecoveryProfileMismatch);
        expect((error as AccountRecoveryProfileMismatch).code).toBe('account-recovery-profile-mismatch');
      }
    }
  }
  expect(() => assertRecoveryCoverage({ ...base,
    account: { ...base.account, profile: 'unknown' } } as unknown as RecoveryCoverage))
    .toThrow('invalid recovery coverage');
});

test('OPS12: two-cut request identity and qualification authenticate every retained native relation fact', async () => {
  const reference = qualificationRef(key, record, '5', expectation, evidence);
  const relay = { query: async (_sql: string, values: string[]) => ({
    rows: values[1] === 'restore-qualification:%' ? [{ item_ref: reference }] : [],
  }) } as unknown as PoolClient;
  await requireQualification(relay, key, 'outer', record, '5', expectation, evidence);
  const request = restoreRequestDigestFromAuthorityDigest(record.consumer, true,
    evidence.currentCoverageDigest, evidence);
  const changes: OwnerRestoreEvidence[] = [
    { ...evidence, baseCoverageEnvelope: 'another-C0' },
    { ...evidence, baseCoverageDigest: '1'.repeat(64) },
    { ...evidence, currentCoverageDigest: '2'.repeat(64) },
    { ...evidence, nativeAccessDigest: '3'.repeat(64) },
    { ...evidence, baseFenceGeneration: '6' },
    { ...evidence, journal: { ...evidence.journal, epoch: '10' } },
    { ...evidence, journal: { ...evidence.journal, count: '4' } },
    { ...evidence, journal: { ...evidence.journal, digest: '4'.repeat(64) } },
  ];
  for (const changed of changes) {
    expect(restoreRequestDigestFromAuthorityDigest(record.consumer, true,
      evidence.currentCoverageDigest, changed)).not.toBe(request);
    await expect(requireQualification(relay, key, 'outer', record, '5', expectation, changed))
      .rejects.toBeInstanceOf(RestoreLineageConflict);
  }
  await expect(requireQualification(relay, 'wrong-key', 'outer', record, '5', expectation, evidence))
    .rejects.toBeInstanceOf(RestoreLineageConflict);
  await expect(requireQualification(relay, key, 'outer', { ...record, outcomeDigest: '0'.repeat(64) },
    '5', expectation, evidence)).rejects.toBeInstanceOf(RestoreLineageConflict);
  await expect(requireQualification(relay, key, 'outer', record, '6', expectation, evidence))
    .rejects.toBeInstanceOf(RestoreLineageConflict);
  await expect(requireQualification(relay, key, 'outer', record, '5',
    { ...expectation, effective: { ...expectation.effective, graphSequence: '11' } }, evidence))
    .rejects.toBeInstanceOf(RestoreLineageConflict);
  // A two-cut finding cannot authorize the legacy request/release branch.
  expect(qualificationRef(key, record, '5', expectation)).not.toBe(reference);
  await expect(requireQualification(relay, key, 'outer', record, '5', expectation))
    .rejects.toBeInstanceOf(RestoreLineageConflict);
});
