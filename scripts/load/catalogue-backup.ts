import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const task = (args: string[]) => stream('task', args, dockerEnvironment(), undefined, 120_000);

export function catalogueBackupProject(
  runId: string,
  works: number,
  compatibility = loadCompatibility(root),
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Number.isSafeInteger(works) || works < 1)
    throw new Error('Invalid command catalogue backup');
  return `rezics-catalogue-g1038-${runId}-${works}-${compatibility.digest.slice(0, 16)}`;
}

/** No live TDB copy: close application writers before invoking; stop all storage
 * owners, copy every owner volume and the local immutable objects, then resume. */
export async function retainCatalogueBackup(
  runId: string,
  works: number,
  directory: string,
  startedAt: number,
): Promise<string> {
  const compatibility = loadCompatibility(root);
  const target = privateDirectory(directory),
    project = catalogueBackupProject(runId, works, compatibility);
  const source = `rezics-qa-${runId}`,
    sourceDirectory = join(root, '.temp/stack', source);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const compose = readEnv(join(sourceDirectory, 'compose.env'));
  const apps = readEnv(join(sourceDirectory, 'apps.env'));
  await task(['stack:down', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
  const docker = dockerEnvironment();
  if (projectRunning(source, docker)) throw new Error('Catalogue source is still running');
  for (const kind of VOLUME_KINDS)
    await copyVolume(`${source}_${kind}`, `${project}_${kind}`, docker);
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
  const manifest = join(target, 'backup.json');
  writeFileSync(manifest, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
  await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
  return manifest;
}

/** Restore into a distinct project under the QA slot; the caller closes it in
 * finally. The containing .temp directory may move with preserved worker
 * artifacts; recorded absolute directories are provenance, not restore keys.
 * Fresh ports, retained owner secrets/lineage and all stores agree. */
export async function restoreCatalogueBackup(path: string, runId: string) {
  const startedAt = Date.now(),
    directory = privateDirectory(resolve(path, '..'));
  const backup = JSON.parse(
    readFileSync(join(directory, 'backup.json'), 'utf8'),
  ) as CatalogueBackup;
  if (
    backup.format !== 'command-catalogue-backup-v1' ||
    !/^rezics-catalogue-g1038-[a-z0-9-]+$/.test(backup.project) ||
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
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const compose = { ...readEnv(join(directory, 'compose.env')), ...(await freshPorts()) };
  replacePrivate(join(target, 'compose.env'), compose);
  const apps = appEnvironment(compose, target);
  replacePrivate(join(target, 'apps.env'), apps);
  for (const kind of VOLUME_KINDS) {
    const existing = run(
      'docker',
      ['volume', 'ls', '-q', '--filter', `name=^${project}_${kind}$`],
      docker,
    );
    if (existing.trim()) throw new Error('Catalogue restore target already has storage');
    await copyVolume(`${backup.project}_${kind}`, `${project}_${kind}`, docker);
  }
  cpSync(join(directory, 'objects'), apps.MAIN_OBJECT_DIRECTORY!, { recursive: true });
  try {
    await task(['stack:up', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
  } catch (error) {
    await task(['stack:reset', '--', '--profile', 'qa', '--run-id', runId, '--persistent']);
    throw error;
  }
  if (Date.now() - startedAt > 600_000) throw new Error('Catalogue restore exceeded 600 seconds');
  return {
    apps,
    elapsedMs: Date.now() - startedAt,
    stop: () => task(['stack:reset', '--', '--profile', 'qa', '--run-id', runId, '--persistent']),
  };
}
