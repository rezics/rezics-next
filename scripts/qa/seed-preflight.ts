import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256, stable } from '../fixture/corpus.ts';
import { inventoryDirectory, type RetainedFileIntegrity } from '../fixture/manifest.ts';
import { retainedDatabaseCollationDifferences, retainedRuntimeDifferences, retainedRuntimeFacts, type RetainedRuntimeFacts } from '../fixture/runtime-facts.ts';
import { currentEngines, dockerEnvironment, fixtureRoot, VOLUME_KINDS, type FixtureEngines } from '../fixture/stack.ts';
import { compatibleLoadStorage, loadCompatibility } from '../load/compatibility.ts';
import type { RetainedSeed } from '../../tests/qa/support/seed-checkpoints.ts';
import { retainedVolumeInventory } from './retained-volume.ts';
import { workProfileCorpusId } from '../load/work-profile-corpus.ts';
import { seedSpecification } from '../../tests/qa/support/seed-specification.ts';
import { SEED_AXES, seedCheckpointPlan } from '../../tests/qa/support/seed-checkpoint-plan.ts';

export interface SeedCustody {
  digest: string;
  runtime: RetainedRuntimeFacts;
  engines: FixtureEngines;
  backups: Record<string, { files: Record<string, RetainedFileIntegrity>; volumes: Record<string, Record<string, RetainedFileIntegrity>> }>;
}

/** Custody covers every independent population series, including reused backups. */
export function seedCustodyCuts(seed: RetainedSeed) {
  const plan = seedCheckpointPlan();
  if (seed.format !== 'seed-checkpoints-v3' || !Array.isArray(seed.cuts) || seed.cuts.length !== 3
    || SEED_AXES.some(axis => !Array.isArray(seed.axes?.[axis]) || seed.axes[axis].length !== 3)
    || stable(seed.cuts) !== stable(seed.axes.unrelatedWorks))
    throw new Error('seed manifest is incomplete');
  return plan.map(stage => {
    const cut = seed.axes[stage.axis].find(cut => cut.manifest.scale === stage.scale);
    if (!cut || cut.manifest.dimension !== stage.axis) throw new Error('seed manifest is incomplete');
    return cut;
  });
}

/** Called only by explicit BUILD, after all stopped cuts exist. */
export function sealSeedCheckpoints(seed: RetainedSeed): SeedCustody {
  const cuts = seedCustodyCuts(seed);
  const docker = dockerEnvironment();
  const backups: SeedCustody['backups'] = {};
  for (const cut of cuts) {
    const backup = JSON.parse(readFileSync(cut.manifest.backup, 'utf8')) as { project: string };
    backups[cut.manifest.id] = { files: inventoryDirectory(dirname(cut.manifest.backup)),
      volumes: Object.fromEntries(VOLUME_KINDS.map(kind => {
        const volume = `${backup.project}_${kind}`;
        return [volume, retainedVolumeInventory(volume, docker)];
      })) };
  }
  const { custody: _custody, ...body } = seed;
  const facts = { runtime: retainedRuntimeFacts(), engines: currentEngines(docker), backups };
  return { ...facts, digest: sha256(stable({ seed: body, ...facts })) };
}

export function preflightSeedCheckpoints(root: string,
  path = join(dirname(fixtureRoot), 'work-profiles/seed-checkpoints/retained.json')): string {
  let seed: RetainedSeed;
  try { seed = JSON.parse(readFileSync(path, 'utf8')) as RetainedSeed; }
  catch { throw new Error(`seed build or complete manifest is missing/unreadable: ${path}`); }
  const cuts = seedCustodyCuts(seed);
  const compatibility = loadCompatibility(root);
  for (const [index, stage] of seedCheckpointPlan().entries()) {
    const cut = cuts[index]!;
    const expected = workProfileCorpusId({ ...seedSpecification, fixed: stage.fixed }, stage.axis, stage.scale, compatibility);
    if (cut.manifest.id !== expected) throw new Error(`seed stale key: retained ${cut.manifest.id}; expected ${expected} (${stage.axis}/${stage.scale})`);
  }
  for (const cut of cuts) {
    if (!compatibleLoadStorage(cut.manifest.compatibility, compatibility))
      throw new Error(`seed stale key: ${cut.manifest.id}; frozen storage key ${compatibility.digest}`);
  }
  if (!seed.custody) throw new Error('seed integrity and PostgreSQL/collation provenance are missing');
  const differences = retainedRuntimeDifferences(seed.custody.runtime, retainedRuntimeFacts());
  for (const cut of cuts) {
    if (!cut.collations) differences.push(`seed ${cut.manifest.id}: recorded database collations are missing`);
    else differences.push(...retainedDatabaseCollationDifferences(cut.collations, retainedRuntimeFacts()));
  }
  if (differences.length) throw new Error(differences.join('; '));
  const { custody, ...body } = seed;
  const { digest, ...facts } = custody;
  if (digest !== sha256(stable({ seed: body, ...facts }))) throw new Error('seed manifest custody digest differs');
  const docker = dockerEnvironment();
  if (stable(custody.engines) !== stable(currentEngines(docker))) throw new Error('seed recorded image differs from host image');
  for (const cut of cuts) {
    const backup = custody.backups[cut.manifest.id];
    if (!backup) throw new Error(`seed backup custody missing: ${cut.manifest.id}`);
    if (stable(backup.files) !== stable(inventoryDirectory(dirname(cut.manifest.backup))))
      throw new Error(`seed backup integrity differs: ${cut.manifest.id}`);
    for (const [volume, files] of Object.entries(backup.volumes))
      if (stable(files) !== stable(retainedVolumeInventory(volume, docker)))
        throw new Error(`seed volume integrity differs: ${volume}`);
  }
  return cuts.map(cut => cut.manifest.id).join(', ');
}
