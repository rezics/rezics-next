import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import {
  run,
  stream,
  copyVolume,
  projectRunning,
  dockerEnvironment,
  freshPorts,
  VOLUME_KINDS,
  root,
} from '../fixture/stack.ts';
import { appEnvironment, readEnv, replacePrivate } from '../dev/config.ts';
import { admissionWaitDuration, runQaStartupChildAsync } from '../qa/stack-startup.ts';
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
}

/** Stop every storage owner before copying; resume the source after the cut by default. */
export async function retainStoppedOwnerBackup(
  runId: string,
  identity: string,
  directory: string,
  startedAt: number,
  options: RetainStoppedBackupOptions = {},
): Promise<string> {
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
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const compose = readEnv(join(sourceDirectory, 'compose.env'));
  const apps = readEnv(join(sourceDirectory, 'apps.env'));
  const docker = dockerEnvironment();
  let downAttempted = false;
  let published = false;
  let result: string | undefined;
  let failure: unknown;
  try {
    checkSignal();
    downAttempted = true;
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
      await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
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

/** G-1038's catalogue caller keeps its established naming and resumes the source. */
export async function retainCatalogueBackup(
  runId: string,
  works: number,
  directory: string,
  startedAt: number,
): Promise<string> {
  if (!Number.isSafeInteger(works) || works < 1) throw new Error('Invalid command catalogue backup');
  return retainStoppedOwnerBackup(runId, String(works), directory, startedAt, { purpose: 'g1038' });
}

const restoreRuntime = { task, run, copyVolume, projectRunning, dockerEnvironment, freshPorts, now: Date.now };

/** Restore into a distinct project under the QA slot; the caller closes it in
 * finally. The containing .temp directory may move with preserved worker
 * artifacts; recorded absolute directories are provenance, not restore keys.
 * Fresh ports, retained owner secrets/lineage and all stores agree. */
export async function restoreCatalogueBackup(path: string, runId: string,
  dependencies: Partial<typeof restoreRuntime> & { signal?: AbortSignal } = {}) {
  const { signal, ...runtimeDependencies } = dependencies;
  const { task, run, copyVolume, projectRunning, dockerEnvironment, freshPorts, now } = { ...restoreRuntime, ...runtimeDependencies };
  const checkSignal = () => signal?.throwIfAborted();
  const startedAt = now(),
    directory = privateDirectory(resolve(path, '..'));
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
    const compose = { ...readEnv(join(directory, 'compose.env')), ...(await freshPorts()) };
    replacePrivate(join(target, 'compose.env'), compose);
    const apps = appEnvironment(compose, target);
    replacePrivate(join(target, 'apps.env'), apps);
    for (const [index, kind] of VOLUME_KINDS.entries()) {
      checkSignal();
      copied.push(destinations[index]!);
      await copyVolume(`${backup.project}_${kind}`, destinations[index]!, docker, signal);
      checkSignal();
    }
    cpSync(join(directory, 'objects'), apps.MAIN_OBJECT_DIRECTORY!, { recursive: true });
    stackAttempted = true;
    const startup = await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
    checkSignal();
    const admissionWaitMs = admissionWaitDuration(startup);
    if (now() - startedAt - admissionWaitMs > 600_000) throw new Error('Catalogue restore exceeded 600 seconds');
    return {
      apps,
      elapsedMs: now() - startedAt - admissionWaitMs,
      admissionWaitMs,
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
