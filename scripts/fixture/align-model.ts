import { ensureLocalDatasetModelGeneration } from '../datasets/model-bootstrap.ts';
import type { FixtureManifestCore } from './manifest.ts';
import { fixtureModel } from './model.ts';

export interface FixtureModelAlignment {
  backupGeneration: string;
  currentGeneration: string;
  /** Artifacts held by the installed model generation, including all added definitions. */
  artifacts: Record<string, string>;
  installation: Record<string, unknown>;
}

/** Refresh and restored fixtures share the existing model bootstrap's custody,
 * head CAS, zero-event receipt and audit. No retained record is rewritten. */
export async function alignFixtureModel(root: string, stack: string, apps: Record<string, string>,
  manifest: Pick<FixtureManifestCore, 'modelGeneration' | 'importOperation'>,
  align: typeof ensureLocalDatasetModelGeneration = ensureLocalDatasetModelGeneration,
): Promise<FixtureModelAlignment> {
  const current = fixtureModel(root);
  const installation = await align(stack, { apps, importOperation: manifest.importOperation });
  if (installation.generation !== current.generation
    || (installation.state !== 'current' && installation.state !== 'completed'))
    throw new Error('Fixture model alignment did not install the current generation');
  return { backupGeneration: manifest.modelGeneration, currentGeneration: current.generation,
    artifacts: current.manifest.artifacts, installation };
}
