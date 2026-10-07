import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { phaseDFixture } from './fixture-phase-d.ts';

const root = resolve(import.meta.dir, '../../..');

test('SEARCH18: restored 10k public units meet cold, degree, language, byte, cursor and retry bounds', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated load tier');
  }
  const fixture = phaseDFixture('SEARCH18');
  const artifacts = join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'search-phase-d');
  mkdirSync(artifacts, { recursive: true });
  const result = await runQaAdmissionChildAsync(root, 'bun', ['scripts/load/search-probe.ts', artifacts, fixture.runId], 145_000, { ...process.env, ...fixture.apps,
      REZICS_LOAD_RUN_ID: `load-${Bun.env.REZICS_QA_RUN_ID}`,
      REZICS_LOAD_STACK_RUN_ID: fixture.runId,
      REZICS_LOAD_BACKGROUND_PUBLIC_UNITS: String(fixture.manifest.entities.publicUnits) });
  const evidence = JSON.parse(readFileSync(join(artifacts, 'search-probe-evidence.json'), 'utf8')) as {
    failure?: string; storageColdRestartMs?: number; publicUnitPopulation?: number;
    candidateDegree?: { admitted?: { total?: number }; refused?: { status?: number } };
    movementRetry?: { additionalFusekiCallsOverStableBaseline?: number;
      searchProof?: { fullInventories: number; deltaRequests: number; deltaAvailable: number } };
  };
  expect(result.error?.message).toBeUndefined();
  expect(evidence.failure).toBeUndefined();
  expect(result.status).toBe(0);
  expect(evidence.storageColdRestartMs).toBeGreaterThan(0);
  expect(evidence.publicUnitPopulation).toBe(10_000);
  expect(evidence.candidateDegree?.admitted?.total).toBe(512);
  expect(evidence.candidateDegree?.refused?.status).toBe(422);
  expect(evidence.movementRetry?.additionalFusekiCallsOverStableBaseline).toBeGreaterThan(0);
  expect(evidence.movementRetry?.searchProof?.fullInventories).toBe(0);
  expect(evidence.movementRetry?.searchProof?.deltaRequests).toBeGreaterThan(0);
  expect(evidence.movementRetry?.searchProof?.deltaAvailable).toBeGreaterThan(0);
}, qaStartupTestTimeout(160_000));
