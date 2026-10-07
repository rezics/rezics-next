import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../../services/main/src/modules/work/restore-lineage.ts';
import { migrateFixtureOwners, migrateOwnerData, type OwnerMigrationEvidence } from '../fixture/migrate.ts';
import { ownerReady } from '../load/restore.ts';
import { projectName, readEnv, stackDirectory, type StackOptions } from './config.ts';
import { assertReleasePins, releaseDigest, releaseManifest } from './release-manifest.ts';
import { scriptCommand } from './commands.ts';

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
  targetFormatVersion?: number;
  artifactDigest?: string;
  ownerMigrations?: OwnerMigrationEvidence[];
}

function markerPath(options: StackOptions): string {
  return join(stackDirectory(root, options), markerName);
}

export function readFormatMarker(options: StackOptions): FormatMarker | undefined {
  const path = markerPath(options);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FormatMarker : undefined;
}

export function saveFormatMarker(options: StackOptions, marker: FormatMarker): void {
  const path = markerPath(options);
  const next = `${path}.${randomUUID()}.next`;
  writeFileSync(next, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(next, path);
}

function command(args: string[], timeout: number): string {
  const result = spawnSync(...scriptCommand(args), { cwd: root, encoding: 'utf8', timeout });
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
    throw new Error('Pinned Fuseki image is absent; run task toolchain:install');
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

function assertMarker(marker: FormatMarker, apps: Record<string, string>, imageId: string,
  artifactDigest?: string): void {
  if (marker.schema !== 'rezics-format-marker-v1' || marker.state !== 'ready'
    || marker.formatVersion !== releaseManifest.formatVersion
    || marker.releaseDigest !== releaseDigest()
    || marker.fusekiImageId !== imageId || marker.artifactDigest !== artifactDigest
    || marker.dataEpoch !== apps.MAIN_DATA_EPOCH || marker.routingEpoch !== apps.MAIN_ROUTING_EPOCH) {
    throw new Error('Saved release format is unqualified or differs; keep the stack fenced and restore a compatible recovery set');
  }
}

export interface InstallationEvidence {
  releaseDigest: string;
  formatVersion: number;
  appliedMigrations: string[];
  ready: string[];
  fusekiImageId: string;
  artifactDigest?: string;
  ownerMigrations: OwnerMigrationEvidence[];
}

export interface ReleaseArtifactMigrations {
  digest: string;
  migrate: (apps: Record<string, string>) => Promise<string[]>;
}

async function assertStoredFormat(apps: Record<string, string>, expected = 1): Promise<void> {
  const access = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
  await access.connect();
  try {
    const table = await access.query<{ exists: string }>(
      "SELECT to_regclass('access.storage_format')::text AS exists");
    if (!table.rows[0]?.exists) {
      if (expected === 1) return; // Fresh stack, before migration 180.
      throw new Error('Access storage format record is missing');
    }
    const format = await access.query<{ version: number; state: string; subject_type: string }>(
      `SELECT f.version, f.state, c.data_type AS subject_type
       FROM access.storage_format f
       CROSS JOIN information_schema.columns c
       WHERE f.id = true AND c.table_schema = 'access'
         AND c.table_name = 'principal' AND c.column_name = 'account_subject'`);
    if (format.rows.length !== 1 || format.rows[0]?.version !== expected
      || format.rows[0]?.state !== 'ready' || format.rows[0]?.subject_type !== 'text') {
      throw new Error('Access storage format is pending or incompatible with this release');
    }
  } finally { await access.end(); }
}

/** Provision one isolated or development stack from the checked-in release pins.
 * The marker is written only after all owner checks pass. */
export async function installRelease(options: StackOptions,
  artifact?: ReleaseArtifactMigrations): Promise<InstallationEvidence> {
  assertReleasePins();
  const imageId = fusekiImageId();
  const existing = readFormatMarker(options);
  const dir = stackDirectory(root, options);
  if (existing) {
    const apps = readEnv(join(dir, 'apps.env'));
    assertMarker(existing, apps, imageId, artifact?.digest);
  } else if (existsSync(join(dir, 'compose.env'))) {
    // An unmarked saved project can contain old or partly upgraded data.
    throw new Error('Saved stack has no release format marker; use a fresh project or a qualified restore');
  }
  command(['stack:up', ...(options.profile === 'qa' ? ['--profile', 'qa', '--run-id', options.runId!, ...(options.persistent ? ['--persistent'] : [])] : [])], 180_000);
  assertRunningFusekiImage(options, imageId);
  const apps = readEnv(join(dir, 'apps.env'));
  if (existing) await assertStoredFormat(apps);
  const appliedMigrations = await (artifact ? artifact.migrate(apps) : migrateFixtureOwners(apps));
  await assertStoredFormat(apps);
  const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN);
  const health = await fuseki.commandHealth();
  if (health.moduleVersion !== releaseManifest.fusekiModule) throw new Error('Fuseki command module differs from release');
  const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
  const initialized = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> { <${DATASET}> rv:dataEpoch ?epoch } }`);
  if (!initialized.boolean) await initializeFreshGraph(fuseki, lineage);
  const ownerMigrations = await migrateOwnerData(apps);
  // A failed owner upgrade retains its own graph hold. Let that owner resume
  // before requiring ordinary admission to be open for resource startup.
  await assertGraphAdmissionOpen(fuseki, lineage);
  if (ownerMigrations.some(migration => migration.status === 'deferred')) {
    console.error('RELEASE OWNER MIGRATIONS INCOMPLETE: graph-name import must be retried; see release-format.json and installation evidence', ownerMigrations);
  }
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
  saveFormatMarker(options, { schema: 'rezics-format-marker-v1',
    formatVersion: releaseManifest.formatVersion, releaseDigest: releaseDigest(),
    fusekiImageId: imageId, dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH!,
    state: 'ready', ownerMigrations, ...(artifact ? { artifactDigest: artifact.digest } : {}) });
  return { releaseDigest: releaseDigest(), formatVersion: releaseManifest.formatVersion,
    appliedMigrations, ready: ['account', 'access', 'content', 'relay', 'fuseki'], fusekiImageId: imageId,
    ownerMigrations, ...(artifact ? { artifactDigest: artifact.digest } : {}) };
}
