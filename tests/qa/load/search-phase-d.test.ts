import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { phaseDFixture } from './fixture-phase-d.ts';

const root = resolve(import.meta.dir, '../../..');

test('SEARCH18: restored 10k public units meet cold, degree, language, byte, cursor and retry bounds', () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated load tier');
  }
  const fixture = phaseDFixture('SEARCH18');
  const artifacts = join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'search-phase-d');
  mkdirSync(artifacts, { recursive: true });
  const result = spawnSync('bun', ['scripts/load/search-probe.ts', artifacts, fixture.runId], {
    cwd: root, encoding: 'utf8', timeout: 145_000,
    env: { ...process.env, ...fixture.apps,
      REZICS_LOAD_RUN_ID: `load-${Bun.env.REZICS_QA_RUN_ID}`,
      REZICS_LOAD_STACK_RUN_ID: fixture.runId,
      REZICS_LOAD_BACKGROUND_PUBLIC_UNITS: String(fixture.manifest.entities.publicUnits) },
  });
  const evidence = JSON.parse(readFileSync(join(artifacts, 'search-probe-evidence.json'), 'utf8')) as {
    failure?: string; storageColdRestartMs?: number; publicUnitPopulation?: number;
    candidateDegree?: { admitted?: { total?: number }; refused?: { status?: number } };
    movementRetry?: { additionalFusekiCallsOverStableBaseline?: number };
  };
  expect(result.error?.message).toBeUndefined();
  expect(evidence.failure).toBeUndefined();
  expect(result.status).toBe(0);
  expect(evidence.storageColdRestartMs).toBeGreaterThan(0);
  expect(evidence.publicUnitPopulation).toBe(10_000);
  expect(evidence.candidateDegree?.admitted?.total).toBe(512);
  expect(evidence.candidateDegree?.refused?.status).toBe(422);
  expect(evidence.movementRetry?.additionalFusekiCallsOverStableBaseline).toBeGreaterThan(0);
}, 160_000);
