import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  recoveryChecks,
  type captureRecoveryProbes,
  type RetainedRecoveryChecks,
} from '../../../tests/qa/fault-recovery/g-727-recovery-checks.ts';
import type { RestoredContext } from '../restore.ts';

function incompleteOwner() {
  let ownerAccesses = 0;
  const relayPool = {
    connect: async () => {
      ownerAccesses++;
      throw new Error('An incomplete retained adapter must not access an owner');
    },
  } as unknown as Pool;
  const erasures: RetainedRecoveryChecks['erasures'] = {
    authority: { sealedCoverage: 'externally-retained-authority', hmacKey: 'ab'.repeat(32) },
    signingKey: 'cd'.repeat(32),
  };
  return { relayPool, erasures, accesses: () => ownerAccesses };
}

// No probes/context can accidentally supply a restored relay or backup authority.
const probes = null as unknown as Awaited<ReturnType<typeof captureRecoveryProbes>>;

test('operator recovery adapter requires independently supplied current owner evidence before any owner access', () => {
  const { relayPool, erasures, accesses } = incompleteOwner();
  for (const input of [
    undefined,
    { relayPool },
    { relayPool, erasures: { ...erasures, authority: undefined } },
    {
      relayPool,
      erasures: { ...erasures, authority: { ...erasures.authority, sealedCoverage: '' } },
    },
    { relayPool, erasures: { ...erasures, authority: { ...erasures.authority, hmacKey: '' } } },
    { relayPool, erasures: { ...erasures, signingKey: '' } },
    { relayPool: {}, erasures },
  ]) {
    expect(() =>
      recoveryChecks(probes, 'ef'.repeat(32), input as unknown as RetainedRecoveryChecks),
    ).toThrow('independently retained current erasure and authority evidence');
  }
  expect(accesses()).toBe(0);
});

test('operator recovery adapter derives maintenance from the restored target graph before any owner access', async () => {
  const { relayPool, erasures, accesses } = incompleteOwner();
  const checks = recoveryChecks(probes, 'ef'.repeat(32), { relayPool, erasures });
  // Verification gates release; the target must also hold a real maintenance capability.
  await expect(
    checks.reconcile(
      {
        apps: { FUSEKI_URL: 'http://target.invalid', FUSEKI_MAINTENANCE_TOKEN: 'ordinary' },
      } as unknown as RestoredContext,
      {
        profile: 'owner-reconciliation-v1',
        kind: 'restore',
        sealedCoverage: '',
        sealedDeletionSets: [],
      },
      'key',
    ),
  ).rejects.toThrow('invalid maintenance capability');
  expect(accesses()).toBe(0);
});
