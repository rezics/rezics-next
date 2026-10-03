import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertWorkCost, type WorkProfile } from '../support/work-profile.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';

test('G1025: Feed API work stays bounded at three public-command corpus scales on first and repeated reads', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  // Calibrate the same profiler on deliberately repeated real work. The
  // owning run must fail a lower cap instead of trusting a counter's zero.
  const calibration = await workProfileProbe(9, true);
  expect(calibration.profile.fusekiRequests).toBe(9);
  expect(calibration.profile.postgresStatements).toBe(9);
  expect(() => assertWorkCost(calibration.profile, { postgresStatements: 3 })).toThrow();
  const child = Bun.spawn([process.execPath, 'services/main/tests/g-1025-profile-child.ts'], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const [code, output, errors] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Home profile failed (${code}): ${errors}\n${output.slice(-2000)}`);
  const saved = JSON.parse(readFileSync('.temp/work-profiles/g-1025-home.json', 'utf8')) as {
    plans: unknown[]; comparison: unknown[]; evidence: { dimension: string; scale: string; profile: WorkProfile }[] };
  expect(saved.plans).toHaveLength(3);
  expect(saved.comparison).toHaveLength(2);
  expect(saved.evidence).toHaveLength(132);
  expect(new Set(saved.evidence.map(row => row.dimension)).size).toBe(4);
}, 420_000);
