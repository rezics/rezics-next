import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { assertGraphReady } from '../fixture/smoke.ts';
import { copyVolume, dockerEnvironment, freshPorts, volumeExists } from '../fixture/stack.ts';
import { appEnvironment, readEnv, savePrivate, stackDirectory, type StackOptions } from '../dev/config.ts';
import { installRelease, readFormatMarker, type FormatMarker } from '../dev/install.ts';
import { installReleaseArtifact } from '../dev/release-artifact.ts';
import { releaseDigest, releaseManifest } from '../dev/release-manifest.ts';
import { ownerReady } from '../load/restore.ts';

const root = resolve(import.meta.dir, '../..');
const kinds = ['postgres_data', 'fuseki_data', 'rustfs_data'] as const;

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`Docker inspection failed: ${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}

function project(options: StackOptions): string {
  if (options.profile !== 'qa' || !options.persistent || !options.runId) {
    throw new Error('Manual failover requires persistent isolated QA projects');
  }
  return `rezics-qa-${options.runId}`;
}

function backupDirectory(id: string): string {
  if (!/^ops-[a-z0-9-]{1,27}$/.test(id)) throw new Error('Invalid recovery cut ID');
  return join(root, '.temp', 'ops', id);
}

function backupVolume(id: string, kind: string): string { return `rezics-ops-${id}_${kind}`; }

export interface RecoverySamples { accountEmail: string; accessPrincipalId: string; accessSubject: string;
  contentRevision: string; contentBody: string }
export interface RecoveryCut { id: string; source: string; marker: FormatMarker; samples: RecoverySamples }

function readCut(id: string): RecoveryCut {
  const path = join(backupDirectory(id), 'cut.json');
  if (!existsSync(path)) throw new Error('Declared recovery cut is missing');
  const cut = JSON.parse(readFileSync(path, 'utf8')) as RecoveryCut;
  if (cut.id !== id || cut.marker.state !== 'ready') throw new Error('Recovery cut is invalid');
  return cut;
}

function hostCut(options: StackOptions): RecoveryCut {
  const path = join(stackDirectory(root, options), 'recovery-cut.json');
  if (!existsSync(path)) throw new Error('Host has no declared recovery cut');
  const id = (JSON.parse(readFileSync(path, 'utf8')) as { id?: string }).id;
  if (!id) throw new Error('Host recovery cut ID is absent');
  return readCut(id);
}

function recordHostCut(options: StackOptions, id: string): void {
  writeFileSync(join(stackDirectory(root, options), 'recovery-cut.json'),
    `${JSON.stringify({ id })}\n`, { mode: 0o600 });
}

/** Copy all owner volumes and the local object directory while the source is
 * stopped. The result is a read-only recovery cut until copied to a target. */
export async function createStoppedRecoveryCut(id: string, source: StackOptions,
  samples: RecoverySamples): Promise<RecoveryCut> {
  const started = Date.now();
  const sourceName = project(source);
  const dir = backupDirectory(id);
  if (existsSync(dir)) throw new Error('Recovery cut already exists');
  if (docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${sourceName}`])) {
    throw new Error('Stop all source writers before copying owner volumes');
  }
  const marker = readFormatMarker(source);
  if (!marker || marker.state !== 'ready') throw new Error('Source release is unqualified');
  const sourceDir = stackDirectory(root, source);
  const apps = readEnv(join(sourceDir, 'apps.env'));
  const saved = readEnv(join(sourceDir, 'compose.env'));
  const environment = dockerEnvironment();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    savePrivate(join(dir, 'compose.env'), saved);
    cpSync(apps.MAIN_OBJECT_DIRECTORY!, join(dir, 'objects'), { recursive: true });
    const copies = await Promise.allSettled(kinds.map(async kind => {
      const from = `${sourceName}_${kind}`;
      if (!volumeExists(from, environment)) throw new Error(`Source ${kind} volume is missing`);
      await copyVolume(from, backupVolume(id, kind), environment);
    }));
    const failed = copies.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (Date.now() - started > 600_000) throw new Error('Stopped backup exceeded 600 seconds');
    const cut: RecoveryCut = { id, source: sourceName, marker, samples };
    writeFileSync(join(dir, 'cut.json'), `${JSON.stringify(cut, null, 2)}\n`, { mode: 0o600 });
    recordHostCut(source, id);
    return cut;
  } catch (error) {
    for (const kind of kinds) {
      const volume = backupVolume(id, kind);
      if (volumeExists(volume, environment)) docker(['volume', 'rm', volume]);
    }
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Stage a complete writable copy without starting any owner or exposing ports. */
export async function restoreRecoveryCut(id: string, target: StackOptions): Promise<void> {
  const started = Date.now();
  const cut = readCut(id);
  const targetName = project(target);
  const targetDir = stackDirectory(root, target);
  const environment = dockerEnvironment();
  if (targetName === cut.source || existsSync(targetDir)
    || kinds.some(kind => volumeExists(`${targetName}_${kind}`, environment))) {
    throw new Error('Restore target must be a fresh isolated project');
  }
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  try {
    const saved = { ...readEnv(join(backupDirectory(id), 'compose.env')),
      ...await freshPorts(), REZICS_STACK_STORAGE: 'persistent', REZICS_STACK_RAW_UPDATE: '0' };
    savePrivate(join(targetDir, 'compose.env'), saved);
    const apps = appEnvironment(saved, targetDir);
    savePrivate(join(targetDir, 'apps.env'), apps);
    cpSync(join(backupDirectory(id), 'objects'), apps.MAIN_OBJECT_DIRECTORY!, { recursive: true });
    const copies = await Promise.allSettled(kinds.map(kind =>
      copyVolume(backupVolume(id, kind), `${targetName}_${kind}`, environment)));
    const failed = copies.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (Date.now() - started > 600_000) throw new Error('Routine restore exceeded 600 seconds');
    writeFileSync(join(targetDir, 'release-format.json'), `${JSON.stringify(cut.marker, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' });
    recordHostCut(target, id);
  } catch (error) {
    const result = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', target.runId!, '--persistent'],
      { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0) for (const kind of kinds) {
      const volume = `${targetName}_${kind}`;
      if (volumeExists(volume, environment)) docker(['volume', 'rm', volume]);
    }
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }
}

/** Start only after the former writer is externally fenced. */
export async function startRestoredHost(outage: HostOutageRecord, target: StackOptions): Promise<void> {
  if (hostCut(target).id !== outage.cutId) throw new Error('Target has a different recovery cut');
  if (docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${outage.project}`])) {
    throw new Error('Principal is still live; fence it before starting the restore');
  }
  const marker = readFormatMarker(target);
  if (!marker) throw new Error('Restored host has no release format marker');
  const installed = marker.artifactDigest
    ? await installReleaseArtifact(join(root, '.temp', 'releases', marker.artifactDigest), target)
    : await installRelease(target);
  if (installed.appliedMigrations.length) throw new Error('Recovery cut required unexpected migration');
}

export function removeRecoveryCut(id: string): void {
  const dir = backupDirectory(id);
  const environment = dockerEnvironment();
  for (const kind of kinds) {
    const volume = backupVolume(id, kind);
    if (volumeExists(volume, environment)) docker(['volume', 'rm', volume]);
  }
  rmSync(dir, { recursive: true, force: true });
}

export interface HostOutageRecord { project: string; networkId: string; cutId: string;
  releaseDigest: string; dataEpoch: string; routingEpoch: string }

/** Capture while the principal is live; this is an operator record, not a vote. */
export function capturePrincipalHost(options: StackOptions): HostOutageRecord {
  const name = project(options);
  const marker = readFormatMarker(options);
  if (!marker || marker.state !== 'ready') throw new Error('Principal release is unqualified');
  const networkId = docker(['network', 'inspect', `${name}_default`, '--format', '{{.Id}}']);
  if (!docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${name}`])) {
    throw new Error('Principal host is not live');
  }
  return { project: name, networkId, cutId: hostCut(options).id,
    releaseDigest: marker.releaseDigest, dataEpoch: marker.dataEpoch, routingEpoch: marker.routingEpoch };
}

export async function qualifyManualFailover(outage: HostOutageRecord,
  target: StackOptions): Promise<{ status: 'manual-route-ready'; cutId: string; samples: number }> {
  const name = project(target);
  if (name === outage.project) throw new Error('Target must be a distinct project');
  if (docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${outage.project}`])) {
    throw new Error('Principal is still live; fence it before manual routing');
  }
  const targetNetwork = docker(['network', 'inspect', `${name}_default`, '--format', '{{.Id}}']);
  if (targetNetwork === outage.networkId) throw new Error('Second host must use an isolated Docker network');
  if (!docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${name}`])) {
    throw new Error('Restored target is unavailable');
  }
  const cut = hostCut(target);
  if (cut.id !== outage.cutId) throw new Error('Target has a different recovery cut');
  const marker = readFormatMarker(target);
  if (!marker || marker.state !== 'ready' || marker.formatVersion !== releaseManifest.formatVersion
    || marker.releaseDigest !== releaseDigest() || marker.releaseDigest !== outage.releaseDigest
    || marker.dataEpoch !== outage.dataEpoch || marker.routingEpoch !== outage.routingEpoch) {
    throw new Error('Target release format or lineage differs from the declared cut');
  }
  const apps = readEnv(join(stackDirectory(root, target), 'apps.env'));
  for (const [key, database] of [
    ['ACCOUNT_DATABASE_URL', 'account'], ['ACCESS_DATABASE_URL', 'access'],
    ['CONTENT_DATABASE_URL', 'content'], ['ACCOUNT_RELAY_DATABASE_URL', 'relay'],
  ] as const) await ownerReady(apps[key]!, database);
  await assertGraphReady(apps, { lineage: { dataEpoch: marker.dataEpoch, routingEpoch: marker.routingEpoch } });
  const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL, max: 1 });
  const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1 });
  const content = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 1 });
  try {
    const [accountRow, accessRow, exact] = await Promise.all([
      account.query('SELECT id FROM "user" WHERE email = $1', [cut.samples.accountEmail]),
      access.query('SELECT account_subject FROM access.principal WHERE id = $1', [cut.samples.accessPrincipalId]),
      new ContentCore(content).readExactBatch([cut.samples.contentRevision], async ids => new Set(ids)),
    ]);
    if (accountRow.rowCount !== 1 || accessRow.rows[0]?.account_subject !== cut.samples.accessSubject
      || exact[0]?.status !== 'available'
      || JSON.stringify(exact[0].body) !== cut.samples.contentBody) {
      throw new Error('Restored exact owner samples differ from the recovery cut');
    }
    return { status: 'manual-route-ready', cutId: cut.id, samples: 3 };
  } finally { await Promise.all([account.end(), access.end(), content.end()]); }
}
