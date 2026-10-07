import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  recoveryChecks,
  type captureRecoveryProbes,
  type RetainedRecoveryChecks,
} from '../../../tests/qa/fault-recovery/g-727-recovery-checks.ts';

test('operator recovery adapter requires independently supplied current owner evidence before any owner access', () => {
  let ownerAccesses = 0;
  const relayPool = {
    connect: async () => {
      ownerAccesses++;
      throw new Error('An incomplete retained adapter must not access an owner');
    },
  } as unknown as Pool;
  const erasures: RetainedRecoveryChecks['erasures'] = {
    originalSource: 'retained-native-event',
    authority: { sealedCoverage: 'externally-retained-authority', hmacKey: 'ab'.repeat(32) },
    signingKey: 'cd'.repeat(32),
    maintenance: {
      command: async () => {
        throw new Error('An incomplete retained adapter must not send a graph command');
      },
    },
  };
  // No probes/context can accidentally supply a restored relay or backup authority.
  const probes = null as unknown as Awaited<ReturnType<typeof captureRecoveryProbes>>;
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
    { relayPool, erasures: { ...erasures, maintenance: undefined } },
    { relayPool, erasures: { ...erasures, originalSource: undefined } },
    { relayPool, erasures: { ...erasures, originalSource: 'unknown' } },
    { relayPool, erasures: { ...erasures, originalSource: 'original-graph', originalGraph: {} } },
    { relayPool, erasures: { ...erasures, originalGraph: undefined } },
    { relayPool, erasures: { ...erasures, originalGraph: {} } },
  ]) {
    expect(() =>
      recoveryChecks(probes, 'ef'.repeat(32), input as unknown as RetainedRecoveryChecks),
    ).toThrow('independently retained current erasure and authority evidence');
  }
  expect(ownerAccesses).toBe(0);
});
