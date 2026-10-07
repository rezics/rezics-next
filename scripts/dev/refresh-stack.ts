import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync,
  existsSync,
  mkdirSync, readFileSync, readlinkSync,
  realpathSync,
  renameSync,
  rmSync, statSync, writeFileSync ,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client, Pool } from 'pg';
import { acquireHeavy } from '../goal/goalctl.ts';
import { migrationDirectories, migrationRecords, type SchemaOwner } from '../ops/migrate.ts';
import { fusekiImageFromCompose } from '../load/image.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { readActiveModelGeneration } from '../../services/main/src/modules/semantic/generation-guard.ts';
import { statementUpgradeCurrent } from '../../services/main/src/modules/statement/upgrade.ts';
import { hasUnnormalizedMembership } from '../../services/main/src/modules/structure/membership-normalize.ts';
import { mainSpec, relaySpec } from '../../services/main/src/config.ts';
import { accountSpec } from '../../services/account/src/config.ts';
import { appEnvironment, composeProcessEnvironment, readEnv, stackDirectory } from './config.ts';
import { AppHostResourceLost, appHostRestartInstruction, type RefreshInputs, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  activeBackend,
  activateBackend,
  backendCommand,
  storageBackend,
  syncBackendInputs,
  pruneBackendRevisions,
  appHostSourceHash,
  stageBackend,
  refreshResources, type RefreshResource } from './refresh.ts';
import { inspectOfficialZoneApprovals } from './seed/official-zones-step.ts';
import { officialSourceDigest } from './seed/official-theme-step.ts';

interface Resource {
  name: string; displayName?: string; state?: string; healthStatus?: string;
  dashboardUrl?: string; urls?: { url: string }[];
  environment?: Record<string, string | null>;
  properties?: { 'executable.pid'?: number | null };
}
interface Checkpoint { revision: string; appHostHash: string; appHostSession: string; refreshId?: string }

/** A unique checkpoint ID is the commit boundary, even for maintenance at the
 * same revision. An obsolete snapshot must never rewind subsequently accepted writes. */
export function refreshRecoveryCommitted(current: { refreshId?: string } | null,
  previous: { refreshId?: string } | null): boolean {
  return Boolean(current?.refreshId && current.refreshId !== previous?.refreshId);
}

function command(root: string, executable: string, args: string[], env = process.env, timeout = 30_000): string {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Describe and Compose output can contain secrets; never include it in errors.
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args[0]} failed (exit ${result.status ?? 'timeout/error'})`);
  return result.stdout.trim();
}

/** CLI exit 16 and nested DCP NotFound (including stop's exit 17) both
 * require a new AppHost. Parse diagnostics without exposing their contents. */
export function refreshAspireOutput(args: string[], result: {
  status: number | null; stdout: string; stderr: string; error?: Error;
}): string {
  if (result.error || result.status !== 0) {
    const resource = args[0] === 'resource' || args[0] === 'wait' ? args[1] : undefined;
    if (resource && (result.status === 16 || /\bNotFound\b|\bnot found\b/i.test(`${result.stdout}\n${result.stderr}`))) {
      throw new AppHostResourceLost(resource, args[0] === 'wait' ? 'wait' : args[2]!);
    }
    throw new Error(`Aspire ${args[0]} failed (exit ${result.status ?? 'timeout/error'})`);
  }
  return result.stdout.trim();
}

function aspire(root: string, args: string[], timeout = 30_000): string {
  const result = spawnSync('node', [join(root, 'node_modules/@microsoft/aspire-cli/bin/aspire.js'),
    ...args, '--apphost', join(root, 'apphost/apphost.mts'), '--non-interactive', '--nologo'],
  { cwd: root, env: process.env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
  try { return refreshAspireOutput(args, result); }
  catch (error) {
    if (error instanceof AppHostResourceLost) throw error;
    if ((args[0] === 'resource' || args[0] === 'wait') && refreshResources.includes(args[1] as RefreshResource)) {
      // A wait timeout can mask a dead executable behind cached Running state.
      // Preserve the original error when the follow-up describe also fails.
      try { assertRefreshResourcePresent(root, args[1] as RefreshResource); }
      catch (inspectionError) { if (inspectionError instanceof AppHostResourceLost) throw inspectionError; }
    }
    throw error;
  }
}

export function refreshProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    // A zombie still answers signal 0 but cannot run a writer.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch { return false; }
}

export function lostRefreshResources(resources: Partial<Record<RefreshResource, Resource>>,
  alive = refreshProcessAlive): RefreshResource[] {
  return refreshResources.filter(name => !resources[name] || (resources[name].state === 'Running'
    && !alive(resources[name].properties?.['executable.pid'] ?? 0)));
}

function assertRefreshResourcePresent(root: string, name: RefreshResource): void {
  const described = JSON.parse(aspire(root, ['describe', '--format', 'Json'])) as { resources?: Resource[] };
  const resource = described.resources?.find(item => item.displayName === name || item.name === name);
  if (lostRefreshResources({ [name]: resource }).includes(name)) {
    throw new AppHostResourceLost(name, 'missing or dead executable');
  }
}

function compose(root: string, args: string[], timeout = 180_000, stackRoot = root): string {
  const file = join(stackDirectory(stackRoot, { profile: 'dev' }), 'compose.env');
  return command(root, 'docker', ['compose', '--env-file', file, '-f', join(root, 'infra/dev/compose.yaml'),
    '--project-name', 'rezics-dev', ...args], composeProcessEnvironment(process.env, readEnv(file)), timeout);
}

function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Same generated environment overlays as dev:prepare, without generating a
 * secret, writing a file, running migrations or registering a client. */
export function expectedRefreshEnvironment(root: string): Record<string, string> {
  const dir = stackDirectory(root, { profile: 'dev' });
  const saved = readEnv(join(dir, 'compose.env'));
  const issued = readEnv(join(dir, 'web-auth/runtime.env'));
  const publicConfig = JSON.parse(readFileSync(join(dir, 'web-auth/public.json'), 'utf8')) as { clientId: string };
  const overrideFile = join(root, '.env.dev');
  const overrides = existsSync(overrideFile) ? parseEnv(readFileSync(overrideFile, 'utf8')) : {};
  return { ...appEnvironment(saved, dir),
    ACCOUNT_OPERATOR_USER_IDS: issued.ACCOUNT_OPERATOR_USER_IDS ?? '',
    ACCOUNT_MAIN_CLIENT_ID: issued.ACCOUNT_MAIN_CLIENT_ID ?? saved.ACCOUNT_MAIN_CLIENT_ID!,
    ACCOUNT_MAIN_CLIENT_SECRET: issued.ACCOUNT_MAIN_CLIENT_SECRET ?? saved.ACCOUNT_MAIN_CLIENT_SECRET!,
    WEB_OAUTH_CLIENT_ID: publicConfig.clientId, ...overrides };
}

export async function pendingRefreshMigrations(root: string, env: Record<string, string>): Promise<string[]> {
  const pending: string[] = [];
  const databases: Record<SchemaOwner, string> = { access: env.ACCESS_DATABASE_URL!,
    relay: env.MAIN_RELAY_DATABASE_URL!, content: env.CONTENT_DATABASE_URL!, account: env.ACCOUNT_DATABASE_URL! };
  for (const owner of Object.keys(migrationDirectories) as SchemaOwner[]) {
    const client = new Client({ connectionString: databases[owner], connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000, query_timeout: 6_000 });
    try {
      await client.connect();
      const table = owner === 'content' ? 'content.schema_migration' : 'public.rezics_local_migration';
      const exists = await client.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [table]);
      const history = exists.rows[0]?.relation
        ? (await client.query<{ name?: string; version?: number }>(`SELECT ${owner === 'content' ? 'version' : 'name'} FROM ${table}`)).rows
        : [];
      for (const file of migrationRecords(root, owner)) {
        if (!history.some(row => owner === 'content' ? row.version === file.version : row.name === file.name)) pending.push(file.name);
      }
    } finally { await client.end(); }
  }
  return pending;
}

interface RehearsalClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
}

/** RESTART allocates transactional sequence storage. Plain rollback does not
 * undo nextval/setval on existing sequences (including calls from triggers).
 * Preserve their state in the rehearsal storage; rollback restores the original.
 * The transaction deadline bounds how long these locks can delay live writers. */
const isolateRehearsalSequences = `DO $$
DECLARE sequence_name text; sequence_value bigint; sequence_called boolean;
BEGIN
  FOR sequence_name IN
    SELECT format('%I.%I', n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %s', sequence_name)
      INTO sequence_value, sequence_called;
    EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', sequence_name, sequence_value);
    PERFORM pg_catalog.setval(sequence_name::regclass, sequence_value, sequence_called);
  END LOOP;
END $$`;

/** Pending files share their owner's transaction so later files can consume
 * earlier schema and data changes. The transaction deadline bounds the entire
 * owner's rehearsal, including locks held by earlier migrations. */
export async function rehearseRefreshMigrations(root: string, env: Record<string, string>,
  pending: readonly string[], createClient: (url: string) => RehearsalClient = url => new Client({
    connectionString: url, connectionTimeoutMillis: 5_000,
    lock_timeout: 1_000, statement_timeout: 5_000, query_timeout: 6_000,
    options: '-c transaction_timeout=10000 -c idle_in_transaction_session_timeout=5000',
  })): Promise<void> {
  const databases: Record<SchemaOwner, string> = { access: env.ACCESS_DATABASE_URL!,
    relay: env.MAIN_RELAY_DATABASE_URL!, content: env.CONTENT_DATABASE_URL!, account: env.ACCOUNT_DATABASE_URL! };
  for (const owner of Object.keys(migrationDirectories) as SchemaOwner[]) {
    const files = migrationRecords(root, owner).filter(file => pending.includes(file.name));
    if (!files.length) continue;
    const client = createClient(databases[owner]);
    let migration = files[0]!.name;
    try {
      await client.connect();
      await client.query('BEGIN');
      try {
        await client.query(isolateRehearsalSequences);
        for (const file of files) {
          migration = file.name;
          await client.query(readFileSync(join(root, file.name), 'utf8'));
        }
      } catch (error) {
        // A transaction timeout closes the connection and rolls back on the
        // server; a failed cleanup query must not hide its original diagnostic.
        try { await client.query('ROLLBACK'); } catch { /* Connection may be closed. */ }
        throw error;
      }
      await client.query('ROLLBACK');
    } catch (error) {
      throw new Error(`Migration rehearsal failed: ${migration}: ${error instanceof Error ? error.message : String(error)}. Writers were not stopped`,
        { cause: error });
    } finally { await client.end(); }
  }
}

/** Read the lock without reaping stale tickets: dry-run has no writes. */
export function refreshHeavyLockHeld(path: string, alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}): boolean {
  if (!existsSync(path)) return false;
  const pid = existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
  return alive(pid) || Date.now() - statSync(path).mtimeMs < 10_000;
}

/** Absolute Compose bind paths belong to the last storage reconciliation,
 * not to every code revision. Compare authored inputs independently of them. */
export function refreshStorageDefinitionChanged(target: string, installed: string): boolean {
  return ['infra/dev/compose.yaml', 'infra/dev/postgres/00-owners.sh',
    'infra/dev/toxiproxy/config.json'].some(path =>
    !existsSync(join(installed, path)) || !readFileSync(join(target, path)).equals(readFileSync(join(installed, path))));
}

export async function inspectRefresh(root: string, stackRoot = root, gateToken?: string) {
  const dir = stackDirectory(stackRoot, { profile: 'dev' });
  const env = readEnv(join(dir, 'dev.env'));
  const expected = expectedRefreshEnvironment(stackRoot);
  const environmentChanges = changedEnvironment(env, expected);
  const composeEnv = readEnv(join(dir, 'compose.env'));
  for (const key of ['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY', 'ACCOUNTS_PORT']) {
    if (!composeEnv[key] && !environmentChanges.includes(key)) environmentChanges.push(key);
  }
  const described = JSON.parse(aspire(stackRoot, ['describe', '--format', 'Json'])) as { resources?: Resource[] };
  const resources = Object.fromEntries(refreshResources.map(name => {
    const resource = described.resources?.find(item => item.displayName === name || item.name === name);
    return [name, resource ?? { name, state: 'Missing' }];
  })) as Record<RefreshResource, Resource>;
  const lostResources = lostRefreshResources(Object.fromEntries(refreshResources.map(name =>
    [name, resources[name].state === 'Missing' ? undefined : resources[name]])));
  for (const name of refreshResources) {
    if (lostResources.includes(name) || resources[name].state !== 'Running') continue;
    try { aspire(stackRoot, ['wait', name, '--status', 'up', '--timeout', '1'], 5_000); }
    catch (error) {
      if (error instanceof AppHostResourceLost) lostResources.push(name);
      else throw error;
    }
  }
  const specs = { account: accountSpec, main: mainSpec, 'main-relay': relaySpec };
  // Compare non-secret values with the environment Aspire actually loaded. Its
  // dynamically assigned listening ports differ from the public proxy ports.
  for (const name of refreshResources) {
    for (const key of Object.keys(specs[name])) {
      if (expected[key] === undefined || ['ACCOUNT_PORT', 'MAIN_PORT'].includes(key) || key.startsWith('OTEL_')) continue;
      const actual = resources[name].environment?.[key];
      if (actual === undefined || (actual !== null && actual !== expected[key])) environmentChanges.push(`${name}.${key}`);
    }
  }
  const dashboard = described.resources?.find(resource => resource.dashboardUrl)?.dashboardUrl;
  if (!dashboard) throw new Error(`Shared AppHost session is unavailable. ${appHostRestartInstruction}`);
  const appHostSession = new URL(dashboard).origin;
  const checkpointPath = join(dir, 'refresh.json');
  const checkpoint = existsSync(checkpointPath)
    ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint : undefined;
  const appHostHash = appHostSourceHash(root);
  const loadedHashFile = join(dir, 'apphost-hash');
  const loadedAppHostHash = existsSync(loadedHashFile) ? readFileSync(loadedHashFile, 'utf8') : undefined;
  const pinned = activeBackend(dir);
  const pinnedRevision = pinned ? command(pinned, 'git', ['rev-parse', 'HEAD']) : undefined;
  const unpinned = refreshResources.some((name) => {
    const pid = resources[name].properties?.['executable.pid'];
    if (!pid || resources[name].state !== 'Running') return false;
    try {
      return !pinned || realpathSync(readlinkSync(`/proc/${pid}/cwd`)) !== realpathSync(pinned);
    } catch {
      return true;
    }
  });
  const image = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image;
  const inspected = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (inspected.error || (inspected.status !== 0 && !/No such image|No such object/i.test(inspected.stderr))) {
    throw new Error('Cannot inspect the pinned Fuseki image; check Docker availability');
  }
  const imagePresent = inspected.status === 0;
  const containerOutput = compose(root, ['ps', '--all', '--format', 'json'], 180_000, stackRoot);
  const containers = (containerOutput.startsWith('[') ? JSON.parse(containerOutput)
    : containerOutput.split('\n').filter(Boolean).map(line => JSON.parse(line))) as
    Array<{ ID: string; Service: string; State: string; Health?: string }>;
  const storageRoot = storageBackend(dir) ?? root;
  const hashes = compose(storageRoot, ['config', '--hash', '*'], 180_000, stackRoot).split('\n').filter(Boolean).map(line => line.split(/\s+/));
  let storageChanged = !imagePresent || refreshStorageDefinitionChanged(root, storageRoot);
  for (const [service, hash] of hashes) {
    const container = containers.find(item => item.Service === service);
    if (!container || container.State !== 'running' || (container.Health && container.Health !== 'healthy')) {
      storageChanged = true; continue;
    }
    const detail = JSON.parse(command(root, 'docker', ['inspect', container.ID])) as
      Array<{ Image: string; Config: { Labels: Record<string, string> } }>;
    if (detail[0]?.Config.Labels['com.docker.compose.config-hash'] !== hash
      || (service === 'fuseki' && detail[0]?.Image !== inspected.stdout.trim())) storageChanged = true;
  }
  const serviceReady = (service: string) => containers.some(item => item.Service === service
    && item.State === 'running' && (!item.Health || item.Health === 'healthy'));
  const pendingMigrations = serviceReady('postgres') ? await pendingRefreshMigrations(root, env)
    : (Object.keys(migrationDirectories) as SchemaOwner[]).flatMap(owner => migrationRecords(root, owner).map(file => file.name));
  const targetGeneration = `urn:rezics:model-generation:${sha256(readFileSync(join(root, 'generated/model/manifest.json')))}`;
  const active = serviceReady('fuseki')
    ? await readActiveModelGeneration(new FusekiClient(env.FUSEKI_URL!, env.FUSEKI_MAINTENANCE_TOKEN, env.FUSEKI_COMMAND_TOKEN))
    : { generation: 'unavailable until storage is prepared' };
  const revision = command(root, 'git', ['rev-parse', 'HEAD']);
  let statementCurrent = false;
  if (serviceReady('postgres') && serviceReady('fuseki')) {
    const pool = new Pool({connectionString: env.ACCESS_DATABASE_URL,max: 1,connectionTimeoutMillis: 5_000});
    try { statementCurrent = await statementUpgradeCurrent(new FusekiClient(env.FUSEKI_URL!,
      env.FUSEKI_MAINTENANCE_TOKEN,env.FUSEKI_COMMAND_TOKEN),env.MAIN_DATA_EPOCH!,pool); }
    finally { await pool.end(); }
  }
  // If Main is unavailable, the restart is blocked or planned first. Inspect
  // again after readiness so a recovered stack cannot miss package changes.
  const zoneApprovals = lostResources.includes('main') || resources.main.state !== 'Running'
    || resources.main.healthStatus !== 'Healthy' ? [] : await inspectOfficialZoneApprovals(
      path => fetch(new URL(path, env.MAIN_ORIGIN!), { signal: AbortSignal.timeout(10_000),
        ...(gateToken ? { headers: { 'x-rezics-refresh': gateToken } } : {}) }),
      slug => officialSourceDigest(slug, join(stackRoot, 'apps/web/zones/official')));
  const input = { revision, previousRevision: pinnedRevision ?? checkpoint?.revision,
    checkpointMissing: !checkpoint, imagePresent, storageChanged, pendingMigrations,
    modelCurrent: active.generation === targetGeneration, statementCurrent,
    membershipCurrent: serviceReady('fuseki') && !await hasUnnormalizedMembership(
      new FusekiClient(env.FUSEKI_URL!, env.FUSEKI_MAINTENANCE_TOKEN, env.FUSEKI_COMMAND_TOKEN)),
    unhealthyResources: refreshResources.filter(name => resources[name].state !== 'Running'
      || resources[name].healthStatus !== 'Healthy'),
    environmentChanges: [...new Set(environmentChanges)].sort(),
    appHostChanged: unpinned || (loadedAppHostHash ? loadedAppHostHash !== appHostHash :
      checkpoint?.appHostSession === appHostSession && checkpoint.appHostHash !== appHostHash),
    lostResources, zoneApprovals };
  return { input, plan: refreshPlan(input), image, active, targetGeneration, resources,
    checkpointPath, checkpoint: { revision, appHostHash, appHostSession } satisfies Checkpoint };
}

/** Both the active executable revision and live storage must match the frozen target. */
export function refreshIsCurrent(input: RefreshInputs): boolean {
  const plan = refreshPlan({ ...input, checkpointMissing: false });
  return !plan.steps.length && !plan.blockers.length;
}

/** Physical copies are made only with both owners stopped. Restore SQL too:
 * alignment may fail after its graph commit or after writing the Account audit.
 * Immutable object uploads can remain; no old object is overwritten by prepare. */
export class RefreshStorageBackup {
  private complete = false;
  private owned = false;
  private readonly dir: string;
  private readonly volumes: Array<{ service: string; volume: string }> = [];
  private image = '';
  constructor(
    private readonly previous: string,
    private readonly stackRoot: string,
    private readonly run = command,
    private readonly composeCommand = (root: string, args: string[], timeout: number) =>
      compose(root, args, timeout, stackRoot),
  ) {
    this.dir = join(stackDirectory(stackRoot, { profile: 'dev' }), 'refresh-recovery');
  }
  capture(): void {
    if (existsSync(this.dir))
      throw new Error(
        'A retained refresh-recovery snapshot exists; inspect and recover it before another maintenance refresh',
      );
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.owned = true;
    for (const [service, destination] of [
      ['postgres', '/var/lib/postgresql'],
      ['fuseki', '/fuseki/databases'],
    ]) {
      const id = this.composeCommand(this.previous, ['ps', '-q', service!], 30_000);
      const [detail] = JSON.parse(this.run(this.previous, 'docker', ['inspect', id])) as Array<{
        Image: string;
        Mounts: Array<{ Type: string; Name: string; Destination: string }>;
      }>;
      const volume = detail?.Mounts.find(
        (mount) => mount.Type === 'volume' && mount.Destination === destination,
      )?.Name;
      if (!volume) throw new Error(`Cannot snapshot ${service} owner volume`);
      this.volumes.push({ service: service!, volume });
      if (service === 'postgres') this.image = detail!.Image;
    }
    this.composeCommand(this.previous, ['stop', 'postgres', 'fuseki'], 150_000);
    try {
      for (const { service, volume } of this.volumes) this.archive(service, volume, false);
      const stack = stackDirectory(this.stackRoot, { profile: 'dev' });
      for (const path of ['compose.env', 'apps.env', 'dev.env', 'web-auth']) {
        if (existsSync(join(stack, path)))
          cpSync(join(stack, path), join(this.dir, path), { recursive: true });
      }
      writeFileSync(
        join(this.dir, 'snapshot.json.tmp'),
        JSON.stringify({
          previous: this.previous,
          backend: activeBackend(stack),
          image: this.image,
          volumes: this.volumes,
          checkpoint: existsSync(join(stack, 'refresh.json'))
            ? JSON.parse(readFileSync(join(stack, 'refresh.json'), 'utf8'))
            : null,
        }),
        { mode: 0o600 },
      );
      renameSync(join(this.dir, 'snapshot.json.tmp'), join(this.dir, 'snapshot.json'));
      this.complete = true;
    } finally {
      this.composeCommand(this.previous, ['up', '-d', '--wait', 'postgres', 'fuseki'], 180_000);
    }
  }
  private archive(service: string, volume: string, restore: boolean): void {
    this.run(
      this.previous,
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=volume,source=${volume},target=/volume`,
        '--mount',
        `type=bind,source=${this.dir},target=/backup`,
        '--entrypoint',
        'sh',
        this.image,
        '-ec',
        restore
          ? `find /volume -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /volume -xpf /backup/${service}.tar`
          : `tar -C /volume -cpf /backup/${service}.tar .`,
      ],
      process.env,
      300_000,
    );
  }
  restore(): void {
    if (!this.owned) return;
    if (!this.complete) {
      // A failed capture has not changed owner data, but may have stopped storage.
      if (existsSync(this.dir)) this.composeCommand(this.previous, ['up', '-d', '--wait'], 180_000);
      this.discard();
      return;
    }
    this.composeCommand(this.previous, ['stop', 'postgres', 'fuseki'], 150_000);
    for (const { service, volume } of this.volumes) this.archive(service, volume, true);
    const stack = stackDirectory(this.stackRoot, { profile: 'dev' });
    for (const path of ['compose.env', 'apps.env', 'dev.env', 'web-auth']) {
      if (!existsSync(join(this.dir, path))) continue;
      rmSync(join(stack, path), { recursive: true, force: true });
      cpSync(join(this.dir, path), join(stack, path), { recursive: true });
    }
    this.composeCommand(this.previous, ['up', '-d', '--wait'], 180_000);
  }
  discard(): void {
    if (this.owned) rmSync(this.dir, { recursive: true, force: true });
  }
  load(): { backend: string; checkpoint: Checkpoint | null } {
    const saved = JSON.parse(readFileSync(join(this.dir, 'snapshot.json'), 'utf8')) as {
      previous: string;
      backend: string;
      checkpoint: Checkpoint | null;
      image: string;
      volumes: Array<{ service: string; volume: string }>;
    };
    const revisions = join(stackDirectory(this.stackRoot, { profile: 'dev' }), 'backend-revisions');
    const validRevision = (path: string) =>
      dirname(resolve(path)) === resolve(revisions) && /^[a-f0-9]{40,64}$/.test(basename(path));
    if (
      saved.previous !== this.previous ||
      !validRevision(saved.backend) ||
      !validRevision(saved.previous) ||
      saved.volumes.length !== 2 ||
      !['postgres', 'fuseki'].every((service) =>
        saved.volumes.some((volume) => volume.service === service),
      )
    )
      throw new Error(
        'Retained refresh snapshot does not identify this stack and both owner volumes',
      );
    this.image = saved.image;
    this.volumes.push(...saved.volumes);
    this.complete = true;
    this.owned = true;
    return { backend: saved.backend, checkpoint: saved.checkpoint };
  }
}

/** Inspection is exported so a worker can exercise the shared-stack dry-run
 * from its own checkout without changing shared files or bypassing the CLI guard. */
export function printRefreshPlan(snapshot: Awaited<ReturnType<typeof inspectRefresh>>): void {
  console.log(`Shared stack refresh to ${snapshot.input.revision}`);
  console.log(`  Image: ${snapshot.image} (${snapshot.input.imagePresent ? 'present' : 'build required'})`);
  console.log(`  Storage: ${snapshot.input.storageChanged ? 'reconcile containers; keep data volumes' : 'current'}`);
  console.log(`  Pending SQL migrations: ${snapshot.input.pendingMigrations.join(', ') || 'none'}`);
  console.log(`  Model generation: ${snapshot.active.generation} -> ${snapshot.targetGeneration}`);
  console.log(`  Catalogue Statement upgrade: ${snapshot.input.statementCurrent ? 'current' : 'prepare-storage required'}`);
  console.log(`  Ordered membership: ${snapshot.input.membershipCurrent ? 'current' : 'owner preparation required'}`);
  console.log(`  Resources requiring AppHost restart: ${snapshot.input.lostResources.join(', ') || 'none'}`);
  console.log(`  Official Zones to re-approve: ${snapshot.input.zoneApprovals.map(zone =>
    `${zone.slug} (${zone.approvedDigest ?? 'no active approval'} -> ${zone.digest})`).join(', ')
    || (snapshot.input.lostResources.includes('main') || snapshot.input.unhealthyResources.includes('main')
      ? 'inspect after Main readiness; currently unavailable' : 'none')}`);
  console.log(`  Plan: ${snapshot.plan.steps.join(' -> ') || 'no changes'}`);
  for (const blocker of snapshot.plan.blockers) console.log(`  BLOCKED: ${blocker}`);
}

export async function refreshSharedStack(root: string, args: string[]): Promise<void> {
  if (args.length > 1 || args.some((arg) => !['--dry-run', '--wait', '--recover'].includes(arg))) {
    throw new Error('Usage: task dev:refresh -- [--dry-run | --wait | --recover]');
  }
  // With several Goals the heavy lock is rarely free and unqueued; --wait takes the next turn before ordinary waiters, without interrupting its holder.
  const wait = args.includes('--wait') || args.includes('--recover');
  const gitDir = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertRefreshCheckout(
    gitDir !== common,
    command(root, 'git', ['branch', '--show-current']),
    Boolean(command(root, 'git', ['status', '--porcelain', '--untracked-files=no'])),
  );
  const lock = join(resolve(common, '..'), '.temp/goal-orchestration/qa-slots/heavy');
  if (!wait && refreshHeavyLockHeld(lock))
    throw new Error(
      'Shared-stack refresh refused: the host-wide heavy QA lock is held; retry after that run finishes or pass --wait',
    );
  if (args.includes('--dry-run')) {
    if (existsSync(join(stackDirectory(root, { profile: 'dev' }), 'refresh-pending')))
      throw new Error(
        'An interrupted refresh must be recovered with task dev:refresh -- --recover',
      );
    const snapshot = await inspectRefresh(root);
    printRefreshPlan(snapshot);
    if (snapshot.plan.blockers.length)
      throw new Error('Dry-run found an AppHost restart requirement');
    console.log('Dry-run: no changes made');
    return;
  }
  let release: (() => void) | undefined;
  try {
    release = await acquireHeavy(['task', 'dev:refresh'], {
      lockDir: lock,
      coalesceRefresh: wait,
      deadline: wait ? Date.now() + 2 * 3_600_000 : Date.now() - 1,
    });
  } catch {
    throw new Error(
      `Shared-stack refresh refused: heavy QA is held or queued; ${wait ? 'it stayed held for two hours' : 'retry after it finishes or pass --wait'}`,
    );
  }
  if (!release) {
    console.log('A shared-stack refresh is already queued; it will include this merge when it starts.');
    return;
  }
  const onExit = release;
  process.once('exit', onExit);
  try {
    const dir = stackDirectory(root, { profile: 'dev' });
    if (args.includes('--recover')) {
      const recovery = join(dir, 'refresh-recovery');
      const gate = join(dir, 'refresh-pending');
      const manifest = join(recovery, 'snapshot.json');
      if (!existsSync(recovery) && !existsSync(gate))
        throw new Error('No interrupted refresh or retained snapshot exists');
      const current = existsSync(join(dir, 'refresh.json'))
        ? (JSON.parse(readFileSync(join(dir, 'refresh.json'), 'utf8')) as Checkpoint)
        : null;
      const pending = existsSync(gate)
        ? (JSON.parse(readFileSync(gate, 'utf8')) as {
            backend: string;
            storage: string;
            checkpoint: Checkpoint | null;
            refreshId: string;
            phase?: string;
            restartRequired?: boolean;
          })
        : undefined;
      const retained = existsSync(manifest)
        ? (JSON.parse(readFileSync(manifest, 'utf8')) as {
            previous: string;
            checkpoint: Checkpoint | null;
          })
        : undefined;
      if (
        pending?.phase === 'committed' ||
        pending?.phase === 'restored' ||
        refreshRecoveryCommitted(current, retained?.checkpoint ?? pending?.checkpoint ?? null)
      ) {
        // Publication already succeeded. Cleanup cannot rewind accepted writes,
        // even if it failed halfway through deleting the old snapshot directory.
        rmSync(recovery, { recursive: true, force: true });
        rmSync(gate, { force: true });
        if (pending?.restartRequired) command(root, 'task', ['dev'], process.env, 600_000);
        console.log('Cleaned completed refresh state; current backend revision and data retained');
        return;
      }
      command(root, 'task', ['dev:stop'], process.env, 60_000);
      if (retained) {
        const backup = new RefreshStorageBackup(retained.previous, root);
        const saved = backup.load();
        backup.restore();
        activateBackend(dir, saved.backend);
        activateBackend(dir, retained.previous, 'storage-backend');
        if (saved.checkpoint)
          writeFileSync(join(dir, 'refresh.json'), JSON.stringify(saved.checkpoint), {
            mode: 0o600,
          });
        else rmSync(join(dir, 'refresh.json'), { force: true });
        if (pending) {
          writeFileSync(
            `${gate}.tmp`,
            JSON.stringify({ ...pending, phase: 'restored', restartRequired: true }),
            { mode: 0o600 },
          );
          renameSync(`${gate}.tmp`, gate);
        }
        backup.discard();
      } else {
        // No complete snapshot marker means preparation never began (or this
        // was code-only); keep the current owner volumes and restore only code.
        if (pending) {
          const revisions = join(dir, 'backend-revisions');
          for (const path of [pending.backend, pending.storage]) {
            if (dirname(resolve(path)) !== revisions || !/^[a-f0-9]{40,64}$/.test(basename(path)))
              throw new Error('Interrupted refresh does not identify this stack backend revisions');
          }
          activateBackend(dir, pending.backend);
          activateBackend(dir, pending.storage, 'storage-backend');
          if (pending.checkpoint)
            writeFileSync(join(dir, 'refresh.json'), JSON.stringify(pending.checkpoint), {
              mode: 0o600,
            });
          else rmSync(join(dir, 'refresh.json'), { force: true });
        }
        rmSync(recovery, { recursive: true, force: true });
      }
      rmSync(gate, { force: true });
      command(root, 'task', ['dev'], process.env, 600_000);
      console.log('Recovered the previous shared backend revision and owner storage');
      return;
    }
    if (existsSync(join(dir, 'refresh-pending')))
      throw new Error(
        'Retained refresh state must be cleaned with task dev:refresh -- --recover before retrying',
      );
    if (existsSync(join(dir, 'refresh-recovery')))
      throw new Error(
        `Retained storage recovery snapshot at ${join(dir, 'refresh-recovery')}; recover it before another refresh`,
      );
    const previous = activeBackend(dir);
    if (!previous) throw new Error(`Shared backend is not pinned. ${appHostRestartInstruction}`);
    // The target is frozen here; a later merge waits for the next refresh.
    const revision = command(root, 'git', ['rev-parse', 'HEAD']);
    const candidate = stageBackend(root, dir, revision);
    const snapshot = await inspectRefresh(candidate, root);
    printRefreshPlan(snapshot);
    syncBackendInputs(root, candidate);
    const previousStorage = storageBackend(dir)!;
    const backup = new RefreshStorageBackup(previousStorage, root);
    const checkpointBefore = existsSync(snapshot.checkpointPath)
      ? readFileSync(snapshot.checkpointPath)
      : undefined;
    const token = randomBytes(32).toString('hex');
    const refreshId = randomBytes(16).toString('hex');
    const gate = join(dir, 'refresh-pending');
    const state = {
      token,
      pid: process.pid,
      refreshId,
      backend: previous,
      storage: previousStorage,
      checkpoint: checkpointBefore
        ? (JSON.parse(checkpointBefore.toString('utf8')) as Checkpoint)
        : null,
    };
    const complete = (phase: 'committed' | 'restored', restartRequired = false) => {
      writeFileSync(`${gate}.tmp`, JSON.stringify({ ...state, phase, restartRequired }), {
        mode: 0o600,
      });
      renameSync(`${gate}.tmp`, gate);
    };
    const clean = () => {
      try {
        backup.discard();
        rmSync(gate, { force: true });
      } catch {
        console.warn(
          'Refresh state is complete; run task dev:refresh -- --recover to clean its retained state without rewinding data',
        );
      }
    };
    const stopWriters = async () => {
      writeFileSync(gate, JSON.stringify({ ...state, phase: 'preparing' }), { mode: 0o600 });
      for (const name of [...refreshResources].reverse()) {
        assertRefreshResourcePresent(root, name);
        aspire(root, ['resource', name, 'stop']);
        aspire(root, ['wait', name, '--status', 'down', '--timeout', '60'], 65_000);
      }
    };
    const restartResources = async () => {
      for (const name of refreshResources) {
        aspire(root, ['resource', name, 'restart']);
        aspire(root, ['wait', name, '--timeout', '120'], 125_000);
        assertRefreshResourcePresent(root, name);
        console.log(`  Restarted: ${name}`);
      }
    };
    const waitReady = async () => {
      for (const name of refreshResources) assertRefreshResourcePresent(root, name);
      for (const name of ['account', 'main'] as const) {
        const endpoint = snapshot.resources[name].urls?.[0]?.url;
        if (!endpoint) throw new Error(`Aspire did not declare a readiness URL for ${name}`);
        const response = await fetch(new URL('/health/ready', endpoint), {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`${name} readiness failed (HTTP ${response.status})`);
      }
    };
    await executeRefresh(snapshot.plan, {
      buildImage: async () => {
        compose(candidate, ['build', 'fuseki'], 300_000, root);
        console.log(`  Built image: ${snapshot.image}`);
      },
      rehearseMigrations: async () => {
        const env = readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env'));
        await rehearseRefreshMigrations(candidate, env, snapshot.input.pendingMigrations);
        console.log('  Pending SQL migrations rehearsed and rolled back; writers still running');
      },
      stopWriters,
      snapshotStorage: async () => {
        backup.capture();
      },
      switchBackend: async () => {
        activateBackend(dir, candidate);
      },
      rollbackPrevious: async () => {
        await stopWriters();
        backup.restore();
        activateBackend(dir, previous);
        activateBackend(dir, previousStorage, 'storage-backend');
        if (checkpointBefore)
          writeFileSync(snapshot.checkpointPath, checkpointBefore, { mode: 0o600 });
        else rmSync(snapshot.checkpointPath, { force: true });
        await restartResources();
        await waitReady();
        const checked = await inspectRefresh(previous, root, token);
        if (
          !checked.input.modelCurrent ||
          checked.input.unhealthyResources.length ||
          checked.input.environmentChanges.length
        )
          throw new Error('Previous backend storage or model is not current after recovery');
        complete('restored');
        clean();
        console.log('  Refresh failed; previous revision and storage recovered');
      },
      prepareStorage: async () => {
        const before = readEnv(join(dir, 'dev.env'));
        backendCommand(candidate, 'task', ['dev:prepare']);
        activateBackend(dir, candidate, 'storage-backend');
        const changes = changedEnvironment(before, readEnv(join(dir, 'dev.env')));
        if (changes.length)
          throw new Error(
            `Prepared environment changed (${changes.join(', ')}). ${appHostRestartInstruction}`,
          );
        console.log('  Storage and owner data migrations ready; volumes retained');
      },
      alignModel: async () => {
        command(
          candidate,
          'task',
          ['dataset:bootstrap-model'],
          { ...process.env, REZICS_DATASET_STACK: dir },
          180_000,
        );
        backendCommand(candidate, 'task', [
          'dev:prepare',
          '--',
          '--seek-only',
          join(dir, 'dev.env'),
        ]);
        console.log(`  Model aligned from backend revision ${revision}`);
      },
      restartResources,
      waitReady,
      approveZones: async () => {
        const env = readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env'));
        const zones = await inspectOfficialZoneApprovals(
          (path) =>
            fetch(new URL(path, env.MAIN_ORIGIN!), {
              signal: AbortSignal.timeout(10_000),
              headers: { 'x-rezics-refresh': token },
            }),
          (slug) => officialSourceDigest(slug),
        );
        if (zones.length) {
          // Keep normal clients fenced while the authorized refresh seed writes.
          const facade = join(dir, 'refresh-seed.yml');
          writeFileSync(
            facade,
            `version: '3'\ntasks:\n  seed:\n    dir: ${JSON.stringify(root)}\n    cmds:\n      - bun --preload "$REZICS_REFRESH_GATE_FILE" scripts/dev/seed/cli.ts {{.CLI_ARGS}}\n`,
            { mode: 0o600 },
          );
          try {
            command(
              root,
              'task',
              [
                '--taskfile',
                facade,
                'seed',
                '--',
                '--themes-only',
                `--packages=${zones.map((zone) => zone.slug).join(',')}`,
              ],
              {
                ...process.env,
                REZICS_REFRESH_GATE_FILE: join(dir, 'backend-gate.ts'),
                REZICS_REFRESH_GATE_TOKEN: token,
              },
              600_000,
            );
          } finally {
            rmSync(facade, { force: true });
          }
        }
      },
      stopAppHost: async () => {
        command(root, 'task', ['dev:stop'], process.env, 60_000);
        backup.restore();
        activateBackend(dir, previous);
        activateBackend(dir, previousStorage, 'storage-backend');
        if (checkpointBefore)
          writeFileSync(snapshot.checkpointPath, checkpointBefore, { mode: 0o600 });
        else rmSync(snapshot.checkpointPath, { force: true });
        complete('restored', true);
        clean();
      },
      recordSuccess: async () => {
        const checked = await inspectRefresh(candidate, root, token);
        if (!refreshIsCurrent(checked.input)) {
          throw new Error(
            'Shared stack changed or is not current after refresh; no success checkpoint recorded',
          );
        }
        writeFileSync(
          `${snapshot.checkpointPath}.tmp`,
          `${JSON.stringify({ ...checked.checkpoint, refreshId })}\n`,
          {
            mode: 0o600,
          },
        );
        renameSync(`${snapshot.checkpointPath}.tmp`, snapshot.checkpointPath);
        // The atomic checkpoint is the commit boundary. Cleanup failures after
        // it must retain the new data/revision, never invoke snapshot rollback.
        try {
          complete('committed');
        } catch {
          console.warn(
            'Refresh committed; run task dev:refresh -- --recover to release the retained traffic fence',
          );
        }
      },
    });
    clean();
    try {
      pruneBackendRevisions(root, dir);
    } catch {
      console.warn('Refresh succeeded; an unused backend revision could not be removed');
    }
    console.log(
      snapshot.plan.steps.length
        ? 'Shared stack refresh complete'
        : 'Shared stack already current; no changes',
    );
  } finally {
    process.removeListener('exit', onExit);
    release();
  }
}
