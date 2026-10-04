import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { assertWorkCost, type WorkProfile } from '../support/work-profile.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';

test('G1025: Feed API work stays bounded at three public-command corpus scales on first and repeated reads', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const started = performance.now();
  await integrationOrderPrelude('g-1025-home');
  // Calibrate the same profiler on deliberately repeated real work. The
  // owning run must fail a lower cap instead of trusting a counter's zero.
  const calibration = await workProfileProbe(9, true);
  expect(calibration.profile.fusekiRequests).toBe(9);
  expect(calibration.profile.postgresStatements).toBe(9);
  expect(() => assertWorkCost(calibration.profile, { postgresStatements: 3 })).toThrow();
  const { resultPath } = await runWorkProfileChild('services/main/tests/g-1025-profile-child.ts', {
    timeoutMs: Math.max(1, 410_000 - (performance.now() - started)),
  });
  const saved = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    plans: unknown[];
    comparison: unknown[];
    evidence: { dimension: string; scale: string; profile: WorkProfile }[];
  };
  expect(saved.plans).toHaveLength(3);
  expect(saved.comparison).toHaveLength(2);
  expect(saved.evidence).toHaveLength(132);
  expect(new Set(saved.evidence.map((row) => row.dimension)).size).toBe(4);
}, 420_000);
