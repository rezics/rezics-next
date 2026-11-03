import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSettings } from './config.ts';
import { acquireDirectoryLease } from './lease.ts';
import { acquireControlPlaneDevLane, controlPlaneChecks, runAffectedTest } from './merge-train.ts';
import { readControlPolicy } from './policy.ts';
import { harness, temporaryDirectory } from './test-support.ts';

test('local integration, lane, lease and verifier overrides retain omitted defaults', async () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.policy = {
      integration: { affectedTransportAttempts: 1 },
      controlPlane: { devLeaseWaitMs: 31000, testTimeoutMs: 17 },
      leases: { acquisitionAttempts: 1 },
      verifier: { concurrency: 1, existingProbes: 1, findingAssertions: 1 },
    };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const policy = checkSettings({ cwd: h.root, env: {} }).policy!;
    expect(policy.integration.affectedTransportAttempts).toBe(1);
    expect(policy.controlPlane.checkTimeoutMs).toBe(600000);
    expect(policy.verifier).toMatchObject({ concurrency: 1, existingProbes: 1, findingAssertions: 1 });
    expect(controlPlaneChecks(policy.controlPlane).at(-1)).toEqual([
      'bun',
      'test',
      '--timeout',
      '17',
      'tools/goal/src',
    ]);
    // The configured lane ceiling admits a longer explicit caller wait, while defaults still reject it.
    const lease = await acquireControlPlaneDevLane(h.settings.stateDirectory, 31000, policy);
    lease.release();
    await expect(acquireControlPlaneDevLane(h.settings.stateDirectory, 31000)).rejects.toThrow('30 seconds');
    const log = join(h.root, 'affected.log');
    const result = await runAffectedTest(
      [process.execPath, '-e', 'console.error("remote-check: no check host answered"); process.exit(1)'],
      h.root,
      log,
      process.env,
      undefined,
      policy,
    );
    expect(result.status).toBe('unverified');
    expect(readFileSync(log, 'utf8').match(/^\$ /gm)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('lease acquisition retries remain bounded and never erase a successor', () => {
  const t = temporaryDirectory();
  try {
    const path = join(t.path, 'owner.lease');
    mkdirSync(path);
    writeFileSync(
      join(path, 'dead.json'),
      JSON.stringify({ pid: 1000000000, start: '1', boot: 'dead', group: 0, token: 'dead' }),
    );
    const policy = readControlPolicy({ leases: { acquisitionAttempts: 1 } });
    expect(() => acquireDirectoryLease(path, policy.leases)).toThrow('Lease held');
    const next = acquireDirectoryLease(path, policy.leases);
    try {
      expect(() => acquireDirectoryLease(path, policy.leases)).toThrow('Lease held');
    } finally {
      next.release();
    }
  } finally {
    t.close();
  }
});
