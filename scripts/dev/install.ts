import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../../services/main/src/modules/work/restore-lineage.ts';
import { migrateFixtureOwners } from '../fixture/migrate.ts';
import { ownerReady } from '../load/restore.ts';
import { projectName, readEnv, stackDirectory, type StackOptions } from './config.ts';
import { assertReleasePins, releaseDigest, releaseManifest } from './release-manifest.ts';

const root = resolve(import.meta.dir, '../..');
const markerName = 'release-format.json';

export interface FormatMarker {
  schema: 'rezics-format-marker-v1';
  formatVersion: number;
  releaseDigest: string;
  fusekiImageId: string;
  dataEpoch: string;
  routingEpoch: string;
  state: 'ready' | 'upgrade-pending';
}

function markerPath(options: StackOptions): string {
  return join(stackDirectory(root, options), markerName);
}

export function readFormatMarker(options: StackOptions): FormatMarker | undefined {
  const path = markerPath(options);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FormatMarker : undefined;
}

function saveFormatMarker(options: StackOptions, marker: FormatMarker): void {
  const path = markerPath(options);
  const next = `${path}.${randomUUID()}.next`;
  writeFileSync(next, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(next, path);
}

function command(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root, encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-1500)}`);
  }
  return result.stdout;
}

function fusekiImageId(): string {
  const result = spawnSync('docker', ['image', 'inspect', releaseManifest.images.fuseki, '--format', '{{.Id}}'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const id = result.stdout.trim();
  if (result.error || result.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new Error('Pinned Fuseki image is absent; run yarn toolchain:install');
  }
  return id;
}

function assertRunningFusekiImage(options: StackOptions, expected: string): void {
  const container = spawnSync('docker', ['ps', '-q',
    '--filter', `label=com.docker.compose.project=${projectName(options)}`,
    '--filter', 'label=com.docker.compose.service=fuseki'],
  { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const id = container.stdout.trim();
  if (container.error || container.status !== 0 || !/^[0-9a-f]{12,64}$/.test(id)) {
    throw new Error('Pinned Fuseki container is unavailable');
  }
  const image = spawnSync('docker', ['inspect', id, '--format', '{{.Image}}'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (image.error || image.status !== 0 || image.stdout.trim() !== expected) {
    throw new Error('Running Fuseki image differs from the release manifest identity');
  }
}

function assertMarker(marker: FormatMarker, apps: Record<string, string>, imageId: string): void {
  if (marker.schema !== 'rezics-format-marker-v1' || marker.state !== 'ready'
    || marker.formatVersion !== releaseManifest.formatVersion
    || marker.releaseDigest !== releaseDigest()
    || marker.fusekiImageId !== imageId
    || marker.dataEpoch !== apps.MAIN_DATA_EPOCH || marker.routingEpoch !== apps.MAIN_ROUTING_EPOCH) {
    throw new Error('Saved release format is unqualified or differs; keep the stack fenced and restore a compatible recovery set');
  }
}

/** A format boundary is a fenced, explicit maintenance step. A failed attempt
 * leaves the old data untouched but refuses routine re-provision until restore. */
export function beginFormatUpgrade(options: StackOptions, targetVersion: number): void {
  const marker = readFormatMarker(options);
  if (!marker || marker.state !== 'ready' || !Number.isSafeInteger(targetVersion)
    || targetVersion <= marker.formatVersion) throw new Error('No qualified current format or invalid target');
  saveFormatMarker(options, { ...marker, state: 'upgrade-pending' });
}

export interface InstallationEvidence {
  releaseDigest: string;
  formatVersion: number;
  appliedMigrations: string[];
  ready: string[];
  fusekiImageId: string;
}

/** Provision one isolated or development stack from the checked-in release pins.
 * The marker is written only after all owner checks pass. */
export async function installRelease(options: StackOptions): Promise<InstallationEvidence> {
  assertReleasePins();
  const imageId = fusekiImageId();
  const existing = readFormatMarker(options);
  const dir = stackDirectory(root, options);
  if (existing) {
    const apps = readEnv(join(dir, 'apps.env'));
    assertMarker(existing, apps, imageId);
  } else if (existsSync(join(dir, 'compose.env'))) {
    // An unmarked saved project can contain old or partly upgraded data.
    throw new Error('Saved stack has no release format marker; use a fresh project or a qualified restore');
  }
  command(['stack:up', ...(options.profile === 'qa' ? ['--profile', 'qa', '--run-id', options.runId!, ...(options.persistent ? ['--persistent'] : [])] : [])], 180_000);
  assertRunningFusekiImage(options, imageId);
  const apps = readEnv(join(dir, 'apps.env'));
  const appliedMigrations = await migrateFixtureOwners(apps);
  const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN);
  const health = await fuseki.commandHealth();
  if (health.moduleVersion !== releaseManifest.fusekiModule) throw new Error('Fuseki command module differs from release');
  const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
  const initialized = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> { <${DATASET}> rv:dataEpoch ?epoch } }`);
  if (!initialized.boolean) await initializeFreshGraph(fuseki, lineage);
  await assertGraphAdmissionOpen(fuseki, lineage);
  for (const [key, database] of [
    ['ACCOUNT_DATABASE_URL', 'account'], ['ACCESS_DATABASE_URL', 'access'],
    ['CONTENT_DATABASE_URL', 'content'], ['ACCOUNT_RELAY_DATABASE_URL', 'relay'],
  ] as const) await ownerReady(apps[key]!, database);
  const content = new Client({ connectionString: apps.CONTENT_DATABASE_URL });
  await content.connect();
  try {
    const result = await content.query('SELECT count(*)::int AS n FROM content.schema_migration');
    if (Number(result.rows[0]?.n) < 1) throw new Error('Content schema has no applied migrations');
  } finally { await content.end(); }
  const graph = await fuseki.query('ASK {}');
  if (graph.boolean !== true) throw new Error('Fuseki graph query unavailable');
  if (!existing) saveFormatMarker(options, { schema: 'rezics-format-marker-v1',
    formatVersion: releaseManifest.formatVersion, releaseDigest: releaseDigest(),
    fusekiImageId: imageId, dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH!, state: 'ready' });
  return { releaseDigest: releaseDigest(), formatVersion: releaseManifest.formatVersion,
    appliedMigrations, ready: ['account', 'access', 'content', 'relay', 'fuseki'], fusekiImageId: imageId };
}
