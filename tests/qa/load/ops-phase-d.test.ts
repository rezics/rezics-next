import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { phaseDFixture } from './fixture-phase-d.ts';

const root = resolve(import.meta.dir, '../../..');

test('OPS05: named 100k host mix records latency, relay lag, memory and storage recovery', () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated load tier');
  }
  const fixture = phaseDFixture('OPS05');
  const artifacts = join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'ops-phase-d');
  mkdirSync(artifacts, { recursive: true });
  const result = spawnSync('bun', ['scripts/load/practical.ts', '10', '20', artifacts, '1'], {
    cwd: root, encoding: 'utf8', timeout: 155_000,
    env: { ...process.env, ...fixture.apps,
      REZICS_LOAD_RUN_ID: `load-${Bun.env.REZICS_QA_RUN_ID}`,
      REZICS_LOAD_STACK_RUN_ID: fixture.runId,
      REZICS_LOAD_ARTIFACT_DIR: artifacts,
      REZICS_LOAD_PHASE_D: '1', REZICS_LOAD_SOURCE_FIXTURE: fixture.restore.fixture,
      REZICS_LOAD_BACKGROUND_WORKS: String(fixture.manifest.entities.works),
      REZICS_LOAD_BACKGROUND_PUBLIC_UNITS: String(fixture.manifest.entities.publicUnits) },
  });
  const evidence = JSON.parse(readFileSync(join(artifacts, 'evidence.json'), 'utf8')) as {
    failure?: string; qualification?: { durationSeconds: number };
    selectionPreparation?: { contributions: number; elapsedMs: number; outsideMix: boolean };
    mixed?: { reads: number; writes: number; readP95Ms: number };
    relayDuringMix?: { samples: unknown[]; trend: { growingAtEnd: boolean } };
    mainHighWaterKiB?: number; storageRecoveryMs?: number;
    memoryBeforeRecovery?: { fuseki: unknown; postgres: unknown };
    memoryAfterRecovery?: { fuseki: unknown; postgres: unknown };
  };
  expect(result.error?.message).toBeUndefined();
  expect(evidence.failure).toBeUndefined();
  expect(result.status).toBe(0);
  expect(evidence.qualification?.durationSeconds).toBe(20);
  expect(evidence.selectionPreparation?.contributions).toBeGreaterThan(0);
  expect(evidence.selectionPreparation?.elapsedMs).toBeGreaterThan(0);
  expect(evidence.selectionPreparation?.outsideMix).toBe(true);
  expect(evidence.mixed?.reads).toBeGreaterThan(0);
  expect(evidence.mixed?.writes).toBeGreaterThan(0);
  expect(evidence.mixed?.readP95Ms).toBeLessThanOrEqual(1500);
  expect(evidence.relayDuringMix?.samples.length).toBeGreaterThan(0);
  expect(evidence.relayDuringMix?.trend.growingAtEnd).toBe(false);
  expect(evidence.mainHighWaterKiB).toBeGreaterThan(0);
  expect(evidence.memoryBeforeRecovery?.fuseki).toBeDefined();
  expect(evidence.memoryBeforeRecovery?.postgres).toBeDefined();
  expect(evidence.memoryAfterRecovery?.fuseki).toBeDefined();
  expect(evidence.memoryAfterRecovery?.postgres).toBeDefined();
  expect(evidence.storageRecoveryMs).toBeGreaterThan(0);
  expect(evidence.storageRecoveryMs).toBeLessThanOrEqual(90_000);
}, 170_000);
