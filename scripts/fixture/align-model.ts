import { ensureLocalDatasetModelGeneration, type ModelBootstrapOptions, type LocalModelBootstrapResult,
  type ModelArtifactEvidence } from '../datasets/model-bootstrap.ts';
import type { FixtureManifestCore } from './manifest.ts';
import { fixtureModel } from './model.ts';
import { ModelWorkBudget } from './model-deadline.ts';

export interface FixtureModelAlignment {
  backupGeneration: string;
  currentGeneration: string;
  /** Exact generated artifacts verified by the alignment step's custody operation. */
  artifacts: ModelArtifactEvidence[];
  artifactCount: number;
  installation: LocalModelBootstrapResult;
}

/** Refresh and restored fixtures share the existing model bootstrap's custody,
 * head CAS, zero-event receipt and audit. No retained record is rewritten. */
export async function alignFixtureModel(root: string, stack: string, apps: Record<string, string>,
  manifest: Pick<FixtureManifestCore, 'modelGeneration' | 'importOperation'>,
  options: ModelBootstrapOptions = {},
  align: typeof ensureLocalDatasetModelGeneration = ensureLocalDatasetModelGeneration,
): Promise<FixtureModelAlignment> {
  const current = fixtureModel(root);
  const deadline = Date.now() + 180_000;
  const budget = new ModelWorkBudget(options.remaining ?? (() => deadline - Date.now()), options.signal);
  try {
    const installation = await budget.run(() => align(stack, { apps, importOperation: manifest.importOperation },
      { ...options, remaining: () => budget.remaining(), signal: budget.signal }));
    if (installation.generation !== current.generation
      || (installation.state !== 'current' && installation.state !== 'completed')
      || installation.artifactCount !== installation.artifacts.length)
      throw new Error('Fixture model alignment did not install the current generation');
    return { backupGeneration: manifest.modelGeneration, currentGeneration: current.generation,
      artifacts: installation.artifacts, artifactCount: installation.artifactCount, installation };
  } finally { budget.close(); }
}
