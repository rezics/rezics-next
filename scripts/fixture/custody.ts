import { join } from 'node:path';
import { sha256, stable } from './corpus.ts';
import { inventoryDirectory, manifestIdentity, type FixtureManifest, type RetainedFileIntegrity } from './manifest.ts';
import { POSTGRES_COLLATION_FILE, retainedCollationDifferences, retainedRuntimeDifferences,
  retainedRuntimeFacts, type RetainedRuntimeFacts } from './runtime-facts.ts';
import { fixtureDirectory } from './stack.ts';
import { retainedVolumeInventory } from '../qa/retained-volume.ts';

export interface FixtureCustody {
  runtime: RetainedRuntimeFacts;
  files: Record<string, RetainedFileIntegrity>;
  volumes: Record<string, Record<string, RetainedFileIntegrity>>;
  digest: string;
}

function files(id: string, directory = fixtureDirectory(id)) {
  return Object.fromEntries(Object.entries(inventoryDirectory(directory))
    .filter(([path]) => path !== 'manifest.json'));
}

/** Explicit fixture publication seals the stopped copy, never a QA consumer. */
export function sealFixture(manifest: FixtureManifest, docker: NodeJS.ProcessEnv): FixtureCustody {
  const facts = { runtime: retainedRuntimeFacts(), files: files(manifest.id),
    volumes: Object.fromEntries(Object.keys(manifest.backup.volumes)
      .map(volume => [volume, retainedVolumeInventory(volume, docker)])) };
  const { custody: _custody, ...body } = manifest;
  return { ...facts, digest: sha256(stable({ manifest: body, ...facts })) };
}

export function verifyFixtureCustody(manifest: FixtureManifest, docker: NodeJS.ProcessEnv, directory = fixtureDirectory(manifest.id)): void {
  const { custody, id, digest, build: _build, backup: _backup, ...core } = manifest;
  const expected = manifestIdentity(core);
  if (id !== expected.id || digest !== expected.digest) throw new Error(`fixture manifest key differs: ${id}; expected ${expected.id}`);
  if (!custody) throw new Error(`fixture ${id}: backup integrity and collation provenance are missing`);
  const host = retainedRuntimeFacts();
  const differences = retainedRuntimeDifferences(custody.runtime, host);
  if (custody.files[POSTGRES_COLLATION_FILE])
    differences.push(...retainedCollationDifferences(join(directory, POSTGRES_COLLATION_FILE), host));
  if (differences.length) throw new Error(`fixture ${id}: ${differences.join('; ')}`);
  const { digest: seal, ...facts } = custody;
  const { custody: _custody, ...body } = manifest;
  if (seal !== sha256(stable({ manifest: body, ...facts }))) throw new Error(`fixture ${id}: custody digest differs`);
  if (stable(custody.files) !== stable(files(id, directory))) throw new Error(`fixture ${id}: backup files differ`);
  for (const [volume, inventory] of Object.entries(custody.volumes))
    if (stable(inventory) !== stable(retainedVolumeInventory(volume, docker)))
      throw new Error(`fixture ${id}: backup volume integrity differs: ${volume}`);
}
