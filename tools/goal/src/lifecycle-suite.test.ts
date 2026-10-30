import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertLifecycleComplete,
  MANAGER_INCIDENT_REGRESSIONS,
  REQUIRED_LIFECYCLE_SCENARIOS,
  runSmallPromotionScenario,
} from './lifecycle-scenarios.ts';
import { recordSystemdRun, requireWorkerCheck, writeEvidenceAtomically } from './lifecycle-fixture.ts';

test('the required dev worker-check runner fails closed when it is absent', () => {
  const missing = join(tmpdir(), `missing-worker-check-${randomUUID()}.ts`);
  expect(() => requireWorkerCheck(missing)).toThrow(`dev worker-check is required but missing: ${missing}`);
});

test('the real systemd prerequisite fails closed when systemd-run is not on PATH', () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = join(tmpdir(), `missing-systemd-${randomUUID()}`);
    expect(() => recordSystemdRun(join(tmpdir(), `lifecycle-systemd-${randomUUID()}`))).toThrow(
      'systemd-run is required for lifecycle smoke',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('small isolated promotion verifies ancestry, exact checked commit, and fast failure classification', async () => {
  const evidence = await runSmallPromotionScenario();
  expect(evidence.mainBaseIsAncestor).toBe(true);
  expect(evidence.mainAncestryVerifiedBeforePublication).toBe(true);
  expect(evidence.checkedCommitIsPublished).toBe(true);
  expect(evidence.checkedCommits.length).toBeGreaterThanOrEqual(3);
  expect(evidence.infrastructureFailureRetries).toBe(1);
  expect(evidence.infrastructureFailureClassified).toBe(true);
  expect(evidence.elapsedMs).toBeLessThan(60_000);

  const reportPath = process.env.REZICS_LIFECYCLE_SCENARIO_REPORT;
  if (process.env.REZICS_LIFECYCLE_EVIDENCE === '1' && reportPath) {
    const root = resolve(import.meta.dir, '../../..');
    writeEvidenceAtomically(reportPath, evidence, join(root, '.temp/goal/lifecycle-smoke'));
  }
}, 60_000);

test('lifecycle completion refuses any missing scenario or incident regression', () => {
  expect(() => assertLifecycleComplete({ scenarios: [], incidents: [] })).toThrow('lifecycle evidence is incomplete');
  const complete = {
    scenarios: REQUIRED_LIFECYCLE_SCENARIOS.map((id) => ({ id, status: 'passed' })),
    incidents: MANAGER_INCIDENT_REGRESSIONS.map(({ id }) => ({ id, status: 'passed' })),
  };
  expect(() => assertLifecycleComplete(complete)).not.toThrow();
});
