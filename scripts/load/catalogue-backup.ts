import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { Pool } from 'pg';
import { repairCopiedPostgresCollations } from '../fixture/postgres-collation.ts';
import { DATASET } from '../../services/main/src/modules/work/activate.ts';
import {
  run,
  stream,
  copyVolume,
  projectRunning,
  dockerEnvironment,
  freshPorts,
  VOLUME_KINDS,
  root,
  fixtureRoot,
} from '../fixture/stack.ts';
import { appEnvironment, readEnv, replacePrivate } from '../dev/config.ts';
import { admissionWaitDuration, runQaStartupChildAsync } from '../qa/stack-startup.ts';
import { qaResourceClasses, type QaResourceClass } from '../qa/resource-classes.ts';
import {
  loadCompatibility,
  compatibleLoadStorage,
  type LoadCompatibility,
} from './compatibility.ts';

interface CatalogueBackup {
  format: 'command-catalogue-backup-v1';
  project: string;
  runId: string;
  directory: string;
  compatibility: LoadCompatibility;
  preparationMs: number;
}
function privateDirectory(path: string) {
  const directory = resolve(path),
    local = relative(root, directory);
  if (local.startsWith('..') || !local.startsWith('.temp/'))
    throw new Error('Catalogue backups must stay in this checkout .temp');
  return directory;
}
/** Shared retained inputs are read-only; every destination still uses this checkout. */
export function corpusBackupSourceDirectory(path: string, checkout = root, fixtures = fixtureRoot): string {
  const directory = resolve(path);
  const local = relative(checkout, directory);
  const shared = relative(resolve(fixtures, '../work-profiles'), directory);
  if ((!local.startsWith('..') && local.startsWith('.temp/')) || !shared.startsWith('..')) return directory;
  throw new Error('Catalogue backup source must stay in checkout .temp or the declared shared work-profiles');
}
const task = async (args: string[]) => {
  if (args[0] !== 'stack:up') return await stream('task', args, dockerEnvironment(), undefined, 120_000);
  const result = await runQaStartupChildAsync(root, args.filter(arg => arg !== '--'), 180_000, dockerEnvironment());
  if (!result.ok) throw new Error(`Catalogue stack startup failed: ${result.output.slice(-2000)}`);
  return result.output;
};

export function catalogueBackupProject(
  runId: string,
  works: number,
  compatibility = loadCompatibility(root),
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Number.isSafeInteger(works) || works < 1)
    throw new Error('Invalid command catalogue backup');
  return stoppedBackupProject(runId, String(works), compatibility, 'g1038');
}

/** A stopped backup project name is unique for its source, purpose and data cut. */
export function stoppedBackupProject(
  runId: string,
  identity: string,
  compatibility = loadCompatibility(root),
  purpose: 'g1038' | 'work-profile' | 'corpus' = 'corpus',
): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) ||
    !/^[a-z0-9][a-z0-9-]{0,60}$/.test(identity) ||
    !['g1038', 'work-profile', 'corpus'].includes(purpose)
  )
    throw new Error('Invalid stopped owner backup identity');
  return `rezics-catalogue-${purpose}-${runId}-${identity}-${compatibility.digest.slice(0, 16)}`;
}

export interface RetainStoppedBackupOptions {
  /** Keep the source stopped while callers restore and compare independent copies. */
  resumeSource?: boolean;
  signal?: AbortSignal;
  purpose?: 'g1038' | 'work-profile' | 'corpus';
  onSourceStartup?: (elapsedMs: number) => void;
  /** Certify PostgreSQL shutdown only when capturing a new copy, after reuse checks. */
  stopSourcePostgres?: () => Promise<void>;
}

const retainRuntime = { task, run, copyVolume, projectRunning, dockerEnvironment };

/** Stop every storage owner before copying; resume the source after the cut by default. */
export async function retainStoppedOwnerBackup(
  runId: string,
  identity: string,
  directory: string,
  startedAt: number,
  options: RetainStoppedBackupOptions = {},
  dependencies: Partial<typeof retainRuntime> = {},
): Promise<string> {
  const { task, run, copyVolume, projectRunning, dockerEnvironment } = { ...retainRuntime, ...dependencies };
  const compatibility = loadCompatibility(root);
  const target = privateDirectory(directory);
  const project = stoppedBackupProject(runId, identity, compatibility, options.purpose ?? 'corpus');
  const checkSignal = () => options.signal?.throwIfAborted();
  const source = `rezics-qa-${runId}`,
    sourceDirectory = join(root, '.temp/stack', source);
  checkSignal();
  const manifest = join(target, 'backup.json');
  if (existsSync(target)) {
    if (!existsSync(manifest)) throw new Error('Stopped owner backup directory is incomplete');
    const saved = JSON.parse(readFileSync(manifest, 'utf8')) as CatalogueBackup;
    if (
      saved.format !== 'command-catalogue-backup-v1' ||
      saved.project !== project ||
      !compatibleLoadStorage(saved.compatibility, compatibility) ||
      !Number.isFinite(saved.preparationMs) ||
      saved.preparationMs < 0 ||
      !existsSync(join(target, 'compose.env')) ||
      !existsSync(join(target, 'objects'))
    )
      throw new Error('Incompatible or incomplete stopped owner backup');
    return manifest;
  }
  const compose = readEnv(join(sourceDirectory, 'compose.env'));
  // Named-volume copies cannot retain a disposable stack's tmpfs stores. Reject
  // that source before stopping it or creating misleading backup artifacts.
  if (compose.REZICS_STACK_STORAGE !== 'persistent')
    throw new Error('Stopped owner backups require a persistent catalogue-disk QA source');
  const apps = readEnv(join(sourceDirectory, 'apps.env'));
  const docker = dockerEnvironment();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  let downAttempted = false;
  let published = false;
  let result: string | undefined;
  let failure: unknown;
  try {
    checkSignal();
    downAttempted = true;
    await options.stopSourcePostgres?.();
    checkSignal();
    await task(['stack:down', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
    checkSignal();
    if (projectRunning(source, docker)) throw new Error('Catalogue source is still running');
    for (const kind of VOLUME_KINDS) {
      checkSignal();
      await copyVolume(`${source}_${kind}`, `${project}_${kind}`, docker, options.signal);
      checkSignal();
    }
    cpSync(apps.MAIN_OBJECT_DIRECTORY!, join(target, 'objects'), { recursive: true });
    replacePrivate(join(target, 'compose.env'), compose);
    const backup: CatalogueBackup = {
      format: 'command-catalogue-backup-v1',
      project,
      runId,
      directory: target,
      compatibility,
      preparationMs: Date.now() - startedAt,
    };
    if (backup.preparationMs > 600_000)
      throw new Error('Catalogue preparation and backup exceeded 600 seconds');
    checkSignal();
    writeFileSync(manifest, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
    published = true;
    result = manifest;
  } catch (error) {
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  if (!published) {
    for (const kind of VOLUME_KINDS) {
      const name = `${project}_${kind}`;
      try {
        if (run('docker', ['volume', 'ls', '-q', '--filter', `name=^${name}$`], docker).trim())
          run('docker', ['volume', 'rm', name], docker, 900_000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (downAttempted && (options.resumeSource !== false || failure !== undefined)) {
    try {
      const startupStartedAt = performance.now();
      await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
      options.onSourceStartup?.(performance.now() - startupStartedAt);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure !== undefined) {
    if (cleanupErrors.length)
      throw new AggregateError([failure, ...cleanupErrors], 'Stopped owner backup failed and cleanup was incomplete', {
        cause: failure,
      });
    throw failure;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Stopped owner backup cleanup failed');
  return result!;
}

/** The catalogue caller keeps its established naming and resumes the source. */
export async function retainCatalogueBackup(
  runId: string,
  works: number,
  directory: string,
  startedAt: number,
): Promise<string> {
  if (!Number.isSafeInteger(works) || works < 1) throw new Error('Invalid command catalogue backup');
  return retainStoppedOwnerBackup(runId, String(works), directory, startedAt, { purpose: 'g1038' });
}

async function retargetRestoredGraphRoute(apps: Record<string, string>): Promise<void> {
  const pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    // A copied route points at the source stack's Fuseki port. Bind this isolated
    // Access copy to its fresh endpoint before any Main process takes the route lease.
    const changed = await pool.query(`UPDATE access.owner_partition_route
      SET location = $1,
        lease_epoch = lease_epoch + CASE WHEN location <> $1 THEN 1 ELSE 0 END,
        updated_at = CASE WHEN location <> $1 THEN clock_timestamp() ELSE updated_at END
      WHERE owner = 'graph' AND dataset_id = $2 AND routing_epoch = $3
      RETURNING location`, [apps.FUSEKI_URL, DATASET, apps.MAIN_ROUTING_EPOCH]);
    if (changed.rowCount !== 1) throw new Error('Restored graph route does not match the copied lineage');
  } finally {
    await pool.end();
  }
}

const restoreRuntime = { task, run, copyVolume, projectRunning, dockerEnvironment, freshPorts,
  repairCollations: repairCopiedPostgresCollations, retargetGraphRoute: retargetRestoredGraphRoute, now: Date.now };

/** Wall time includes startup admission, storage copy and readiness. */
export interface CorpusPreparationTiming {
  restoreMs: number;
  volumeCopyMs?: Record<(typeof VOLUME_KINDS)[number], number>;
  objectCopyMs?: number;
  startupMs: number;
  readinessMs: number;
  totalMs: number;
}

/** Restore into a distinct project under the QA slot; the caller closes it in
 * finally. The containing .temp directory may move with preserved worker
 * artifacts; recorded absolute directories are provenance, not restore keys.
 * Fresh ports, retained owner secrets/lineage and all stores agree. */
export async function restoreCatalogueBackup(path: string, runId: string,
  dependencies: Partial<typeof restoreRuntime> & { signal?: AbortSignal; resourceClass?: QaResourceClass } = {}) {
  const { signal, resourceClass, ...runtimeDependencies } = dependencies;
  const { task, run, copyVolume, projectRunning, dockerEnvironment, freshPorts,
    repairCollations, retargetGraphRoute, now } = { ...restoreRuntime, ...runtimeDependencies };
  const checkSignal = () => signal?.throwIfAborted();
  const startedAt = now(),
    directory = corpusBackupSourceDirectory(resolve(path, '..'));
  const backup = JSON.parse(
    readFileSync(join(directory, 'backup.json'), 'utf8'),
  ) as CatalogueBackup;
  if (
    backup.format !== 'command-catalogue-backup-v1' ||
    !/^rezics-catalogue-(?:g1038|work-profile|corpus)-[a-z0-9-]+$/.test(backup.project) ||
    !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) ||
    runId === backup.runId ||
    !compatibleLoadStorage(backup.compatibility, loadCompatibility(root))
  )
    throw new Error('Incompatible catalogue backup or restore target');
  const docker = dockerEnvironment(),
    project = `rezics-qa-${runId}`;
  if (projectRunning(project, docker) || projectRunning(backup.project, docker))
    throw new Error('Catalogue restore target/backup is running');
  const target = join(root, '.temp/stack', project);
  checkSignal();
  if (existsSync(target)) throw new Error('Catalogue restore target already exists');
  // Check every destination before copying any store. Reset must never erase a
  // stopped target's preexisting data discovered halfway through the restore.
  const volumeExists = (name: string) => run('docker',
    ['volume', 'ls', '-q', '--filter', `name=^${name}$`], docker).trim() !== '';
  const destinations = VOLUME_KINDS.map(kind => `${project}_${kind}`);
  if (destinations.some(volumeExists)) throw new Error('Catalogue restore target already has storage');
  mkdirSync(join(root, '.temp/stack'), { recursive: true });
  mkdirSync(target, { mode: 0o700 });
  const copied: string[] = [];
  let stackAttempted = false;
  const cleanup = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    if (stackAttempted) {
      try { await task(['stack:reset', '--', '--profile', 'qa', '--run-id', runId, '--persistent']); }
      catch (error) { errors.push(error); }
    }
    // A copy may have created its destination before rejecting. Also try each
    // volume when stack reset fails, without abandoning the remaining cleanup.
    for (const name of copied) {
      try { if (volumeExists(name)) run('docker', ['volume', 'rm', name], docker); }
      catch (error) { errors.push(error); }
    }
    try { rmSync(target, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    return errors;
  };
  try {
    const volumeCopyMs = {} as Record<(typeof VOLUME_KINDS)[number], number>;
    const compose = { ...readEnv(join(directory, 'compose.env')), ...(await freshPorts()) };
    if (resourceClass) {
      // Storage lineage is retained; a modest restored corpus can qualify
      // under an existing smaller QA allocation without inheriting BUILD's cap.
      compose.REZICS_FUSEKI_MEMORY_LIMIT = qaResourceClasses[resourceClass].memory;
      compose.REZICS_FUSEKI_JVM_ARGS = qaResourceClasses[resourceClass].jvmArgs;
    }
    replacePrivate(join(target, 'compose.env'), compose);
    const apps = appEnvironment(compose, target);
    replacePrivate(join(target, 'apps.env'), apps);
    for (const [index, kind] of VOLUME_KINDS.entries()) {
      checkSignal();
      copied.push(destinations[index]!);
      // The copy helper creates an unlabelled volume by default. This fresh
      // destination belongs to Compose; label it before copying so startup and
      // reset agree on ownership. cp -a retains the source store's UID/GID.
      run('docker', ['volume', 'create',
        '--label', `com.docker.compose.project=${project}`,
        '--label', `com.docker.compose.volume=${kind}`,
        destinations[index]!], docker);
      const copyStarted = now();
      await copyVolume(`${backup.project}_${kind}`, destinations[index]!, docker, signal);
      volumeCopyMs[kind] = now() - copyStarted;
      checkSignal();
    }
    const objectCopyStarted = now();
    cpSync(join(directory, 'objects'), apps.MAIN_OBJECT_DIRECTORY!, { recursive: true });
    const objectCopyMs = now() - objectCopyStarted;
    const copiedAt = now();
    stackAttempted = true;
    let startup: string;
    try { startup = await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']); }
    catch (error) {
      // Startup's Compose tail does not contain PostgreSQL's failure reason.
      // Capture it while the failed container still exists, before cleanup.
      let postgres = '';
      try { postgres = run('docker', ['logs', '--tail', '60', `${project}-postgres-1`], docker); }
      catch { /* Preserve the original startup failure if the container is gone. */ }
      if (postgres.trim()) throw new Error(`${error instanceof Error ? error.message : String(error)}\nPostgreSQL startup diagnostics:\n${postgres}`, { cause: error });
      throw error;
    }
    const startedUpAt = now();
    checkSignal();
    const collationRepairs = await repairCollations({
      host: '127.0.0.1', port: Number(compose.POSTGRES_PORT), user: 'postgres', password: compose.POSTGRES_PASSWORD });
    await retargetGraphRoute(apps);
    checkSignal();
    const admissionWaitMs = admissionWaitDuration(startup);
    const readyAt = now();
    const preparation: CorpusPreparationTiming = {
      restoreMs: copiedAt - startedAt,
      volumeCopyMs,
      objectCopyMs,
      startupMs: startedUpAt - copiedAt,
      readinessMs: readyAt - startedUpAt,
      totalMs: readyAt - startedAt,
    };
    if (preparation.totalMs - admissionWaitMs > 600_000)
      throw new Error('Catalogue restore exceeded 600 seconds');
    return {
      apps,
      collationRepairs,
      elapsedMs: now() - startedAt - admissionWaitMs,
      admissionWaitMs,
      preparation,
      stop: async () => {
        const errors = await cleanup();
        if (errors.length) throw new AggregateError(errors, 'Catalogue restore cleanup failed');
      },
    };
  } catch (error) {
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
      `Catalogue restore failed: ${error instanceof Error ? error.message : String(error)}; cleanup also failed`,
      { cause: error });
    throw error;
  }
}
