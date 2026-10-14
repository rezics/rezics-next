import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareMigrationPaths } from '../lib/migration-order.ts';
import {
  type Corpus,
  FIXTURE_FORMAT,
  IMPORT_SEQUENCE,
  sampleIndices,
  sha256,
  stable,
  workAt,
} from './corpus.ts';
import type { FixtureOwner } from './owners/types.ts';
import type { FixtureEngines } from './stack.ts';
import { fixtureModel } from './model.ts';

export const MANIFEST_FORMAT = 'rezics-fixture-manifest-v1';

export type RetainedJson = null | boolean | number | string | RetainedJson[] |
  { [key: string]: RetainedJson };
export type RetainedOwnerState = Record<string, RetainedJson>;
export interface RetainedFileIntegrity { sha256: string; bytes: number }
/** The metadata digest binds the RDF proof and restorable owner contract to
 * exactly the inventoried graph, object and PostgreSQL backup bytes. */
export interface RetainedIntegrity {
  files: Record<string, RetainedFileIntegrity>;
  rdfDigest: string;
  ownerState: RetainedOwnerState;
  digest: string;
}

function safeRetainedPath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Inventory the backup directory, excluding no files. The manifest belongs
 * outside this directory so neither its own digest nor temporary files escape custody. */
export function inventoryDirectory(directory: string): Record<string, RetainedFileIntegrity> {
  const files: Record<string, RetainedFileIntegrity> = {};
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`retained backup contains symlink: ${relative || '.'}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (!safeRetainedPath(child)) throw new Error(`unsafe retained backup path: ${child}`);
        visit(join(path, name), child);
      }
    } else if (stat.isFile() && relative) {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error(`retained backup is not a regular file: ${relative}`);
        const bytes = readFileSync(descriptor);
        Object.defineProperty(files, relative, {
          value: { sha256: sha256(bytes), bytes: bytes.length }, enumerable: true,
          configurable: true, writable: true,
        });
      } finally { closeSync(descriptor); }
    } else throw new Error(`retained backup is not a regular file or directory: ${relative || '.'}`);
  }
  visit(directory, '');
  return files;
}

export function isRetainedJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isRetainedJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

export function retainedIntegrity(directory: string, rdfDigest: string,
  ownerState: RetainedOwnerState): RetainedIntegrity {
  if (!/^[a-f0-9]{64}$/.test(rdfDigest)) throw new Error('retained RDF digest must be SHA-256');
  if (!ownerState || typeof ownerState !== 'object' || Array.isArray(ownerState) || !isRetainedJson(ownerState)) {
    throw new Error('retained owner state must be a JSON object');
  }
  const metadata = { files: inventoryDirectory(directory), rdfDigest,
    ownerState: JSON.parse(stable(ownerState)) as RetainedOwnerState };
  return { ...metadata, digest: sha256(stable(metadata)) };
}

/** Refusals are evidence; verification never repairs, reseals or follows a
 * manifest path outside the backup directory. */
export function verifyRetainedIntegrity(directory: string, integrity: RetainedIntegrity): string[] {
  const reasons: string[] = [];
  if (!integrity || !integrity.files || typeof integrity.files !== 'object' ||
    Array.isArray(integrity.files) || !isRetainedJson(integrity.files) || !integrity.ownerState ||
    typeof integrity.ownerState !== 'object' ||
    Array.isArray(integrity.ownerState) || !isRetainedJson(integrity.ownerState) ||
    !/^[a-f0-9]{64}$/.test(integrity.rdfDigest)) {
    return ['retained integrity metadata is invalid'];
  }
  const { files, rdfDigest, ownerState } = integrity;
  if (sha256(stable({ files, rdfDigest, ownerState })) !== integrity.digest) {
    reasons.push('retained integrity metadata digest differs');
  }
  for (const [path, entry] of Object.entries(files)) {
    if (!safeRetainedPath(path)) reasons.push(`unsafe retained manifest path: ${path}`);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      reasons.push(`invalid retained file integrity: ${path}`);
    }
  }
  let actual: Record<string, RetainedFileIntegrity>;
  try { actual = inventoryDirectory(directory); }
  catch (error) {
    reasons.push(`retained backup inventory refused: ${error instanceof Error ? error.message : String(error)}`);
    return reasons;
  }
  for (const path of Object.keys(files).sort()) {
    if (!Object.hasOwn(actual, path)) reasons.push(`retained backup file missing: ${path}`);
    else if (actual[path]!.sha256 !== files[path]?.sha256 || actual[path]!.bytes !== files[path]?.bytes) {
      reasons.push(`retained backup file changed: ${path}`);
    }
  }
  for (const path of Object.keys(actual).sort()) {
    if (!Object.hasOwn(files, path)) reasons.push(`retained backup file unexpected: ${path}`);
  }
  return reasons;
}
/** Tracked per file: applied files must stay byte-identical; newer files apply at restore. */
export const MIGRATION_DIRECTORIES = [
  'services/main/migrations/access',
  'services/main/migrations/relay',
  'services/content/migrations',
  'services/account/migrations',
] as const;
/** Better Auth derives Account's schema; restore runs its forward migration. */
const ACCOUNT_SCHEMA_INPUTS = ['services/account/package.json', 'services/account/src/auth.ts'];

export interface FixtureSample {
  index: number;
  work: string;
  mainVersion: string;
  workRevision: string;
  mainRevision: string;
  title: string;
  semanticTypes: string[];
  agent: string;
  variant: string;
  contentRevision: string;
  contentBody: string;
  language: string;
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
  owners: Record<
    string,
    {
      generator: string;
      digest: string;
      counts: Record<string, number>;
      inputs: Record<string, string>;
    }
  >;
  migrations: Record<string, string>;
  account: Record<string, string>;
  engines: FixtureEngines;
  /** Model generation compiled into the backup's build; retained as provenance at restore. */
  modelGeneration: string;
  samples: FixtureSample[];
}

export interface FixtureManifest extends FixtureManifestCore {
  id: string;
  digest: string;
  /** Measurements and physical identities; outside the deterministic digest. */
  build: {
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
    admissionWaitMs?: number;
    phases: Record<string, number>;
    textIndexGeneration: string;
    loads: Record<string, unknown>;
  };
  backup: { project: string; volumes: Record<string, { bytes: number; files: number }> };
}

function fileDigests(root: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.sort(compareMigrationPaths).map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
}

export function migrationInventory(root: string): Record<string, string> {
  return fileDigests(
    root,
    MIGRATION_DIRECTORIES.flatMap((directory) =>
      readdirSync(join(root, directory))
        .filter((file) => file.endsWith('.sql'))
        .map((file) => `${directory}/${file}`),
    ),
  );
}

export function manifestCore(
  root: string,
  corpus: Corpus,
  owners: readonly FixtureOwner[],
  engines: FixtureEngines,
): FixtureManifestCore {
  return {
    format: MANIFEST_FORMAT,
    fixture: FIXTURE_FORMAT,
    profile: corpus.profile,
    seed: corpus.seed,
    entities: { works: corpus.works, agents: corpus.agents, publicUnits: corpus.publicUnits },
    lineage: corpus.lineage,
    importOperation: corpus.importOperation,
    importSequence: IMPORT_SEQUENCE,
    owners: Object.fromEntries(
      owners.map((owner) => [
        owner.name,
        {
          generator: owner.generator,
          ...owner.summarize(corpus),
          inputs: owner.compatibilityInputs(root),
        },
      ]),
    ),
    migrations: migrationInventory(root),
    account: fileDigests(root, [...ACCOUNT_SCHEMA_INPUTS]),
    engines,
    modelGeneration: fixtureModel(root).generation,
    samples: sampleIndices(corpus).map((index) => {
      const work = workAt(corpus, index);
      return {
        index,
        work: work.work,
        mainVersion: work.mainVersion,
        workRevision: work.workRevision,
        mainRevision: work.mainRevision,
        title: work.title,
        semanticTypes: work.semanticTypes,
        agent: work.agent,
        variant: work.variant,
        contentRevision: work.contentRevision,
        contentBody: work.contentBody,
        language: work.language,
      };
    }),
  };
}

/** The same retained records, schema inputs and engines give the same ID.
 * The build model generation is provenance, outside retained-record identity. */
export function manifestIdentity(core: FixtureManifestCore): { digest: string; id: string } {
  const { modelGeneration: _modelGeneration, ...identity } = core;
  const digest = sha256(stable(identity));
  return { digest, id: `fx-${core.profile}-${digest.slice(0, 12)}` };
}

export interface RestoreCompatibility {
  compatible: boolean;
  reasons: string[];
  /** Newer migration files that restore applies in order. */
  pendingMigrations: string[];
  engineChanged: boolean;
  /** Restore installs the current model while preserving the backup's generation. */
  pendingModelAlignment: boolean;
}

/** One retained-fixture rule: generators/used shapes and vocabulary, Jena/text
 * configuration and Postgres/RustFS engines must match; applied migration bytes
 * cannot change or gain a predecessor. Newer migrations and unrelated additive
 * model definitions (separately or together) restore with migration/model alignment.
 * Every incompatible change requires a rebuild. */
export function restoreCompatibility(
  manifest: FixtureManifestCore,
  current: {
    owners: Record<string, { generator: string; inputs: Record<string, string> }>;
    migrations: Record<string, string>;
    engines: FixtureEngines;
    modelGeneration: string;
  },
): RestoreCompatibility {
  const reasons: string[] = [];
  if (manifest.format !== MANIFEST_FORMAT || manifest.fixture !== FIXTURE_FORMAT) {
    reasons.push('fixture format differs');
  }
  for (const [name, owner] of Object.entries(current.owners)) {
    const stored = manifest.owners[name];
    if (!stored) reasons.push(`owner ${name} is absent from the backup`);
    else if (stored.generator !== owner.generator) reasons.push(`owner ${name} generator changed`);
    else {
      for (const input of new Set([...Object.keys(stored.inputs), ...Object.keys(owner.inputs)])) {
        if (stored.inputs[input] !== owner.inputs[input])
          reasons.push(`owner ${name} model input changed: ${input}`);
      }
    }
  }
  const pendingMigrations: string[] = [];
  for (const [path, digest] of Object.entries(manifest.migrations)) {
    if (current.migrations[path] !== digest) reasons.push(`applied migration changed: ${path}`);
  }
  for (const path of Object.keys(current.migrations).sort(compareMigrationPaths)) {
    if (Object.hasOwn(manifest.migrations, path)) continue;
    const directory = path.slice(0, path.lastIndexOf('/'));
    const later = Object.keys(manifest.migrations).some(
      (applied) => applied.startsWith(`${directory}/`) && compareMigrationPaths(applied, path) > 0,
    );
    if (later) reasons.push(`migration inserted before applied files: ${path}`);
    else pendingMigrations.push(path);
  }
  for (const engine of ['postgres', 'rustfs'] as const) {
    if (
      manifest.engines[engine].image !== current.engines[engine].image ||
      manifest.engines[engine].id !== current.engines[engine].id
    )
      reasons.push(`${engine} engine changed`);
  }
  // A new command module is code; the Jena version and assembler are owner inputs above.
  const engineChanged = manifest.engines.fuseki.id !== current.engines.fuseki.id;
  return { compatible: reasons.length === 0, reasons, pendingMigrations, engineChanged,
    pendingModelAlignment: manifest.modelGeneration !== current.modelGeneration };
}
