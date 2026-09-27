import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { readManifest } from '../../../scripts/fixture/build.ts';

const root = resolve(import.meta.dir, '../../..');
export const PHASE_D_FIXTURE = 'fx-medium-c9f6e4fdcb52';

/** The QA coordinator prepares this writable copy before its 180-second test clock. */
export function phaseDFixture(caseId: 'OPS05' | 'SEARCH18' | 'REC02') {
  const runId = Bun.env[`REZICS_QA_FIXTURE_${caseId}_RUN_ID`] ?? Bun.env.REZICS_QA_FIXTURE_RUN_ID;
  if (!runId || !/^fixture-[a-z0-9-]{1,27}$/.test(runId)) {
    throw new Error('Set REZICS_QA_FIXTURE_RUN_ID to a separately restored fixture copy');
  }
  const record = join(root, '.artifacts', 'fixture-restore', runId, 'run.json');
  if (!existsSync(record)) throw new Error(`Fixture restore record missing for ${runId}`);
  const restore = JSON.parse(readFileSync(record, 'utf8')) as {
    fixture: string; target: string; works: number; failure?: string;
    elapsedMs?: number; completedAt?: string;
  };
  const manifest = readManifest(PHASE_D_FIXTURE);
  if (restore.fixture !== PHASE_D_FIXTURE || restore.target !== runId || restore.failure
    || !restore.completedAt || !manifest || restore.works !== manifest.entities.works
    || manifest.entities.works !== 100_000 || manifest.entities.publicUnits !== 10_000
    || !Number.isFinite(restore.elapsedMs) || restore.elapsedMs! > 600_000) {
    throw new Error(`Fixture ${runId} is not a qualified isolated medium restore`);
  }
  const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const apps = readEnv(join(stack, 'apps.env'));
  return { runId, restore, manifest, apps };
}
