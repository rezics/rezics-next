import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Corpus, FIXTURE_FORMAT, IMPORT_SEQUENCE, sampleIndices, sha256, stable,
  workAt } from './corpus.ts';
import type { FixtureOwner } from './owners/types.ts';
import type { FixtureEngines } from './stack.ts';

export const MANIFEST_FORMAT = 'rezics-fixture-manifest-v1';
/** Tracked per file: applied files must stay byte-identical; newer files apply at restore. */
export const MIGRATION_DIRECTORIES = ['services/main/migrations/access', 'services/main/migrations/relay',
  'services/content/migrations'] as const;
/** Better Auth derives Account's schema; restore runs its forward migration. */
const ACCOUNT_SCHEMA_INPUTS = ['services/account/package.json', 'services/account/src/auth.ts'];

export interface FixtureSample {
  index: number; work: string; mainVersion: string; workRevision: string; mainRevision: string;
  title: string; semanticTypes: string[]; agent: string; variant: string; contentRevision: string;
  contentBody: string; language: string;
}

export interface FixtureManifestCore {
  format: typeof MANIFEST_FORMAT;
  fixture: typeof FIXTURE_FORMAT;
  profile: Corpus['profile'];
  seed: string;
  entities: { works: number; agents: number; publicUnits: number };
  lineage: Corpus['lineage'];
  importOperation: string;
  importSequence: typeof IMPORT_SEQUENCE;
  owners: Record<string, { generator: string; digest: string; counts: Record<string, number>;
    inputs: Record<string, string> }>;
  migrations: Record<string, string>;
  account: Record<string, string>;
  engines: FixtureEngines;
  samples: FixtureSample[];
}

export interface FixtureManifest extends FixtureManifestCore {
  id: string;
  digest: string;
  /** Measurements and physical identities; outside the deterministic digest. */
  build: { startedAt: string; completedAt: string; elapsedMs: number; phases: Record<string, number>;
    textIndexGeneration: string; loads: Record<string, unknown> };
  backup: { project: string; volumes: Record<string, { bytes: number; files: number }> };
}

function fileDigests(root: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.sort().map(path => [path, sha256(readFileSync(join(root, path)))]));
}

export function migrationInventory(root: string): Record<string, string> {
  return fileDigests(root, MIGRATION_DIRECTORIES.flatMap(directory =>
    readdirSync(join(root, directory)).filter(file => file.endsWith('.sql'))
      .map(file => `${directory}/${file}`)));
}

export function manifestCore(root: string, corpus: Corpus, owners: readonly FixtureOwner[],
  engines: FixtureEngines): FixtureManifestCore {
  return { format: MANIFEST_FORMAT, fixture: FIXTURE_FORMAT, profile: corpus.profile, seed: corpus.seed,
    entities: { works: corpus.works, agents: corpus.agents, publicUnits: corpus.publicUnits }, lineage: corpus.lineage,
    importOperation: corpus.importOperation, importSequence: IMPORT_SEQUENCE,
    owners: Object.fromEntries(owners.map(owner => [owner.name, { generator: owner.generator,
      ...owner.summarize(corpus), inputs: owner.compatibilityInputs(root) }])),
    migrations: migrationInventory(root), account: fileDigests(root, [...ACCOUNT_SCHEMA_INPUTS]),
    engines,
    samples: sampleIndices(corpus).map(index => {
      const work = workAt(corpus, index);
      return { index, work: work.work, mainVersion: work.mainVersion, workRevision: work.workRevision,
        mainRevision: work.mainRevision, title: work.title, semanticTypes: work.semanticTypes,
        agent: work.agent, variant: work.variant, contentRevision: work.contentRevision,
        contentBody: work.contentBody, language: work.language };
    }) };
}

/** The same seed, profile, owner generators, schema inputs and engines give the same ID. */
export function manifestIdentity(core: FixtureManifestCore): { digest: string; id: string } {
  const digest = sha256(stable(core));
  return { digest, id: `fx-${core.profile}-${digest.slice(0, 12)}` };
}

export interface RestoreCompatibility {
  compatible: boolean;
  reasons: string[];
  /** Newer migration files that restore applies in order. */
  pendingMigrations: string[];
  engineChanged: boolean;
}

/** Decide from the manifest alone whether a backup may serve the current checkout. */
export function restoreCompatibility(manifest: FixtureManifestCore, current: {
  owners: Record<string, { generator: string; inputs: Record<string, string> }>;
  migrations: Record<string, string>; engines: FixtureEngines;
}): RestoreCompatibility {
  const reasons: string[] = [];
  if (manifest.format !== MANIFEST_FORMAT || manifest.fixture !== FIXTURE_FORMAT) {
    reasons.push('fixture format differs');
  }
  for (const [name, owner] of Object.entries(current.owners)) {
    const stored = manifest.owners[name];
    if (!stored) reasons.push(`owner ${name} is absent from the backup`);
    else if (stored.generator !== owner.generator) reasons.push(`owner ${name} generator changed`);
    else if (stable(stored.inputs) !== stable(owner.inputs)) reasons.push(`owner ${name} model inputs changed`);
  }
  const pendingMigrations: string[] = [];
  for (const [path, digest] of Object.entries(manifest.migrations)) {
    if (current.migrations[path] !== digest) reasons.push(`applied migration changed: ${path}`);
  }
  for (const path of Object.keys(current.migrations).sort()) {
    if (Object.hasOwn(manifest.migrations, path)) continue;
    const directory = path.slice(0, path.lastIndexOf('/'));
    const later = Object.keys(manifest.migrations).some(applied =>
      applied.startsWith(`${directory}/`) && applied > path);
    if (later) reasons.push(`migration inserted before applied files: ${path}`);
    else pendingMigrations.push(path);
  }
  for (const engine of ['postgres', 'rustfs'] as const) {
    if (manifest.engines[engine].image !== current.engines[engine].image
      || manifest.engines[engine].id !== current.engines[engine].id) reasons.push(`${engine} engine changed`);
  }
  // A new command module is code; the Jena version and assembler are owner inputs above.
  const engineChanged = manifest.engines.fuseki.id !== current.engines.fuseki.id;
  return { compatible: reasons.length === 0, reasons, pendingMigrations, engineChanged };
}
