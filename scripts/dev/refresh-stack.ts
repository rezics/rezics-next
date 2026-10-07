import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync,
  realpathSync,
  renameSync,
  rmSync, statSync, writeFileSync ,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client, Pool } from 'pg';
import { acquireSharedLifecycle, inheritedSharedLifecycleOwnership, markSharedLifecycleCommandStarted, sharedLifecycleEnvironment, transferSharedLifecycleOwnership } from '../goal/goalctl.ts';
import { migrationDirectories, migrationRecords, type SchemaOwner } from '../ops/migrate.ts';
import { sqlMigration } from '../lib/concurrent-index.ts';
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
  readPendingRefresh,
  type PendingRefresh,
  refreshResources, type RefreshResource } from './refresh.ts';
import { runHostAdmission } from '../qa/host-admission.ts';
import { inspectOfficialZoneApprovals } from './seed/official-zones-step.ts';
import { officialSourceDigest } from './seed/official-theme-step.ts';

interface Resource {
  name: string; displayName?: string; state?: string; healthStatus?: string;
  dashboardUrl?: string; urls?: { url: string }[];
  environment?: Record<string, string | null>;
  properties?: { 'executable.pid'?: number | null };
}
interface Checkpoint { revision: string; appHostHash: string; appHostSession: string; refreshId?: string ;
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

/** Compare non-secret loaded values with the generated stack. Listen ports are
 * fixed but are not the public proxy ports, and OTEL endpoints belong to the
 * dashboard. A resource that has never started in this AppHost reports no
 * environment; it cannot be stale, because it starts from the current
 * configuration. A stopped resource that did start still compares. */
export function refreshLoadedEnvironmentChanges(
  resources: Partial<Record<RefreshResource, { state?: string; environment?: Record<string, string | null | undefined> }>>,
  expected: Record<string, string | undefined>,
): string[] {
  const specs = { account: accountSpec, main: mainSpec, 'main-relay': relaySpec };
  const changes: string[] = [];
  for (const name of refreshResources) {
    if (resources[name]?.state === 'NotStarted') continue;
    for (const key of Object.keys(specs[name])) {
      if (expected[key] === undefined || ['ACCOUNT_PORT', 'MAIN_PORT'].includes(key) || key.startsWith('OTEL_')) continue;
      const actual = resources[name]?.environment?.[key];
      if (actual === undefined || (actual !== null && actual !== expected[key])) changes.push(`${name}.${key}`);
    }
  }
  return changes;
}

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
          // A rolled-back ordinary build validates the same columns and
          // predicate while preserving the online form for the real apply.
          const sql = sqlMigration(readFileSync(join(root, file.name), 'utf8'), file.name);
          // An interrupted build or a lost receipt may already have this name.
          // Rollback restores that entry; apply repairs it outside a transaction.
          if (sql.concurrentIndex) await client.query(`DROP INDEX IF EXISTS ${sql.concurrentIndex}`);
          await client.query(sql.rehearsalSql);
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
export function refreshLifecycleLockHeld(path: string, alive = (pid: number): boolean => {
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

/** Candidate-only operations cannot inspect an older serving native module.
 * Changed storage remains unproven until stopped-writer preparation installs
 * the candidate; a matching live module must supply its actual completion. */
export async function refreshMembershipCurrent(storageChanged: boolean, fusekiReady: boolean,
  fuseki: Pick<FusekiClient, 'membershipPreparationStatus'>): Promise<boolean> {
  return !storageChanged && fusekiReady && !await hasUnnormalizedMembership(fuseki);
}

export async function inspectRefresh(root: string, stackRoot = root) {
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
  environmentChanges.push(...refreshLoadedEnvironmentChanges(resources, expected));
  const dashboard = described.resources?.find(resource => resource.dashboardUrl)?.dashboardUrl;
  if (!dashboard) throw new Error(`Shared AppHost session is unavailable. ${appHostRestartInstruction}`);
  const appHostSession = new URL(dashboard).origin;
  const checkpointPath = join(dir, 'refresh.json');
  const checkpoint = existsSync(checkpointPath)
    ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint : undefined;
  const appHostHash = appHostSourceHash(stackRoot);
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
      path => fetch(new URL(path, env.MAIN_ORIGIN!), { signal: AbortSignal.timeout(10_000)}),
      slug => officialSourceDigest(slug, join(root, 'apps/web/zones/official')));
  const input : RefreshInputs = { revision, previousRevision: pinnedRevision ?? checkpoint?.revision,
    checkpointMissing: !checkpoint, imagePresent, storageChanged, pendingMigrations,
    modelCurrent: active.generation === targetGeneration, statementCurrent,
    membershipCurrent: await refreshMembershipCurrent(storageChanged, serviceReady('fuseki'),
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
  const plan = refreshPlan({ ...input, checkpointMissing: false , resumeStep: undefined });
  return !plan.steps.length && !plan.blockers.length;
}

function describeRefreshResources(root: string): Partial<Record<RefreshResource, Resource>> {
  const described = JSON.parse(aspire(root, ['describe', '--format', 'Json'])) as {
    resources?: Resource[];
  };
  return Object.fromEntries(
    refreshResources.map((name) => [
      name,
      described.resources?.find(
        (resource) => resource.displayName === name || resource.name === name,
      ),
    ]),
  );
}

async function stopRefreshWriters(root: string): Promise<void> {
  const resources = describeRefreshResources(root);
  for (const name of [...refreshResources].reverse()) {
    if (!resources[name]) throw new AppHostResourceLost(name, 'stop');
    if (
      ['Exited', 'Finished', 'FailedToStart', 'Stopped', 'NotStarted', 'Waiting'].includes(
        resources[name].state ?? '',
      )
    )
      continue;
    assertRefreshResourcePresent(root, name);
    aspire(root, ['resource', name, 'stop']);
    aspire(root, ['wait', name, '--status', 'down', '--timeout', '60'], 65_000);
  }
}

/** Restart can allocate endpoints that a stopped resource did not have during
 * preflight. Read the resource model after restart, never cache those URLs. */
export async function waitRefreshReady(
  describe: () => Partial<Record<RefreshResource, Resource>>,
  request: typeof fetch = fetch,
  alive = refreshProcessAlive,
): Promise<void> {
  const resources = describe();
  const lost = lostRefreshResources(resources, alive);
  if (lost.length) throw new AppHostResourceLost(lost[0]!, 'readiness inspection');
  for (const name of ['account', 'main'] as const) {
    const endpoint = resources[name]?.urls?.[0]?.url;
    if (!endpoint) throw new Error(`Aspire did not declare a readiness URL for ${name}`);
    const response = await request(new URL('/health/ready', endpoint), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`${name} readiness failed (HTTP ${response.status})`);
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

function refreshBuildTask(candidate: string, args: string[], env = process.env): void {
  command(candidate, 'bun', [join(candidate, 'scripts/qa/host-admission.ts'),
    '--gib', '4', '--', 'task', ...args,
  ], env, 600_000);
}

/** Storage up may build an absent image, including during maintenance retry
 * before inspection can select an explicit image-build step. */
export function prepareRefreshStorage(candidate: string): void {
  refreshBuildTask(candidate, ['dev:prepare']);
}

/** A staged revision is a Git worktree, so the seed CLI needs an explicit
 * shared-stack target. Theme approval may build the web app as well. */
export function seedRefreshZones(candidate: string, stack: string, packages: readonly string[]): void {
  refreshBuildTask(candidate, [
    'dev:seed', '--', '--themes-only', `--packages=${packages.join(',')}`,
  ], { ...process.env, REZICS_SEED_STACK_DIRECTORY: stack });
}

export async function refreshSharedStack(root: string, args: string[]): Promise<void> {
  if (args.length > 1 || args.some((arg) => !['--dry-run', '--wait'].includes(arg)))
    throw new Error('Usage: task dev:refresh -- [--dry-run | --wait]');
  const wait = args.includes('--wait');
  const gitDir = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertRefreshCheckout(
    gitDir !== common,
    command(root, 'git', ['branch', '--show-current']),
    Boolean(command(root, 'git', ['status', '--porcelain', '--untracked-files=no'])),
  );
  const lock = join(resolve(common, '..'), '.temp/goal-orchestration/shared-lifecycle');
  const inherited = inheritedSharedLifecycleOwnership(lock);
  if (!wait && !inherited && refreshLifecycleLockHeld(lock))
    throw new Error(
      'Shared-stack refresh refused: shared lifecycle is held; retry after it finishes or pass --wait',
    );
  const dir = stackDirectory(root, { profile: 'dev' });
  const checkpointPath = join(dir, 'refresh.json');
  const pendingTarget = () => {
    const pending = readPendingRefresh(dir);
    const checkpoint = existsSync(checkpointPath)
      ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint)
      : undefined;
    return pending && pending.refreshId !== checkpoint?.refreshId ? pending : undefined;
  };
  if (args.includes('--dry-run')) {
    const pending = pendingTarget();
    const target = pending?.mutatingStep ? join(dir, 'backend-revisions', pending.revision) : root;
    const snapshot = await inspectRefresh(target, root);
    snapshot.input.resumeStep = pending?.mutatingStep;
    snapshot.plan = refreshPlan(snapshot.input);
    printRefreshPlan(snapshot);
    if (snapshot.plan.blockers.length)
      throw new Error('Dry-run found an AppHost restart requirement');
    console.log('Dry-run: no changes made');
    return;
  }
  let release: (() => void) | undefined;
  try {
    release = inherited ? () => {} : await acquireSharedLifecycle(['task', 'dev:refresh'], {
      lockDir: lock,
      coalesceRefresh: wait,
      deadline: wait ? Date.now() + 2 * 3_600_000 : Date.now() - 1,
    });
  } catch {
    throw new Error(
      `Shared-stack refresh refused: shared lifecycle is held or queued; ${wait ? 'it stayed held for two hours' : 'retry after it finishes or pass --wait'}`,
    );
  }
  if (!release) {
    console.log('A shared-stack refresh is already queued; it will include this merge when it starts.');
    return;
  }
  markSharedLifecycleCommandStarted(lock);
  const onExit = release;
  process.once('exit', onExit);
  try {
    // Each invocation freezes current committed main, so a code fix can
    // advance unfinished forward-only maintenance while writers stay stopped.
    const revision = command(root, 'git', ['rev-parse', 'HEAD']);
    let candidate: string;
    try {
      candidate = stageBackend(root, dir, revision);
    } catch (error) {
      throw new Error(
        `Refresh failed at stage-backend: ${String(error)}. ${pendingTarget()?.mutatingStep ? 'Writers remain stopped' : 'Previous revision retained'}. Retry: task dev:refresh -- --wait`,
        { cause: error },
      );
    }
    // Imports in this process predate the wait. Only the detached checkout's
    // fresh process may inspect or maintain the frozen revision.
    const child = Bun.spawn([process.execPath, join(candidate, 'scripts/dev/refresh-stack.ts'),
      '--staged', root, revision, lock, String(inherited?.pid ?? process.pid)], {
      cwd: candidate, env: process.env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    });
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    try {
      const status = await child.exited;
      if (status !== 0) throw new Error(`Refresh failed in staged checkout (exit ${status}); see the step and retry command above`);
    } finally {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    }
  } finally {
    process.removeListener('exit', onExit);
    release();
  }
}

/** The fresh child takes lifecycle ownership, including if its launcher dies.
 * Validate the frozen checkout and lease before any maintenance. */
export async function refreshStagedStack(root: string, revision: string, lock: string, parentPid: number): Promise<void> {
  const dir = stackDirectory(root, { profile: 'dev' });
  const candidate = join(dir, 'backend-revisions', revision);
  if (!/^[a-f0-9]{40,64}$/.test(revision) || realpathSync(process.cwd()) !== realpathSync(candidate)
    || readFileSync(join(lock, 'pid'), 'utf8').trim() !== String(parentPid)
    || !refreshProcessAlive(parentPid)
    || command(candidate, 'git', ['rev-parse', 'HEAD']) !== revision
    || readFileSync(join(candidate, '.temp/backend-ready'), 'utf8') !== revision)
    throw new Error('Staged refresh requires its frozen checkout and a live lifecycle owner');
  const release = transferSharedLifecycleOwnership(lock, process.pid, parentPid);
  Object.assign(process.env, sharedLifecycleEnvironment(lock));
  process.once('exit', release);
  try {
    await maintainStagedStack(root, candidate, revision, dir);
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

async function maintainStagedStack(root: string, candidate: string, revision: string, dir: string): Promise<void> {
  const pendingPath = join(dir, 'refresh-pending');
  const checkpointPath = join(dir, 'refresh.json');
  const checkpoint = existsSync(checkpointPath)
    ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint) : undefined;
  const saved = readPendingRefresh(dir);
  const pending = saved && saved.refreshId !== checkpoint?.refreshId ? saved : undefined;
  if (pending && !pending.mutatingStep)
    throw new Error(`A refresh was interrupted before maintenance. ${appHostRestartInstruction}`);
  if (pending?.mutatingStep) {
    // A killed refresh may have left candidate writers running. Stop them
    // before inspecting the idempotent maintenance retry with fresh code.
    try {
      await stopRefreshWriters(root);
    } catch (error) {
      try { command(root, 'task', ['dev:stop'], process.env, 60_000); }
      catch {
        throw new Error(`Refresh failed at stop-writers: ${String(error)}. AppHost shutdown failed; task dev:stop must succeed. Retry: task dev:refresh -- --wait`, { cause: error });
      }
      throw new Error(`Refresh failed at stop-writers: ${String(error)}. Writers remain stopped. ${appHostRestartInstruction}. Retry: task dev:refresh -- --wait`, { cause: error });
    }
  }
  const previous = pending?.backend ?? activeBackend(dir);
  if (!previous) throw new Error(`Shared backend is not pinned. ${appHostRestartInstruction}`);
  const previousStorage = pending?.storage ?? storageBackend(dir)!;
  syncBackendInputs(root, candidate);
  if (pending?.mutatingStep === 'prepare-storage') {
    // Preparation may have retired an OAuth fixture before failing. Complete
    // its idempotent turn before inspection reads the generated private files.
    try {
      activateBackend(dir, candidate, 'storage-backend');
      prepareRefreshStorage(candidate);
      pending.mutatingStep = 'align-model';
      pending.revision = revision;
      pending.pid = process.pid;
      writeFileSync(`${pendingPath}.tmp`, JSON.stringify(pending), { mode: 0o600 });
      renameSync(`${pendingPath}.tmp`, pendingPath);
    } catch (error) {
      throw new Error(
        `Refresh failed at prepare-storage: ${String(error)}. Writers remain stopped. Retry: task dev:refresh -- --wait`,
        { cause: error },
      );
    }
  }
  let snapshot: Awaited<ReturnType<typeof inspectRefresh>>;
  try {
    snapshot = await inspectRefresh(candidate, root);
  } catch (error) {
    throw new Error(
      `Refresh failed at inspect: ${String(error)}. ${pending?.mutatingStep ? 'Writers remain stopped' : 'Previous revision retained'}. Retry: task dev:refresh -- --wait`,
      { cause: error },
    );
  }
  snapshot.input.resumeStep = pending?.mutatingStep;
  snapshot.plan = refreshPlan(snapshot.input);
  printRefreshPlan(snapshot);
  const state: PendingRefresh = {
    revision,
    backend: previous,
    storage: previousStorage,
    pid: process.pid,
    refreshId: randomBytes(16).toString('hex'),
    mutatingStep: pending?.mutatingStep,
  };
  const saveState = () => {
    writeFileSync(`${pendingPath}.tmp`, JSON.stringify(state), {
      mode: 0o600,
    });
    renameSync(`${pendingPath}.tmp`, pendingPath);
  };
  const stopWriters = async () => {
    saveState();
    await stopRefreshWriters(root);
  };
  const restartResources = async () => {
    for (const name of refreshResources) {
      aspire(root, ['resource', name, 'restart']);
      aspire(root, ['wait', name, '--timeout', '120'], 125_000);
      assertRefreshResourcePresent(root, name);
      console.log(`  Restarted: ${name}`);
    }
  };
  const waitReady = () => waitRefreshReady(() => describeRefreshResources(root));
  await executeRefresh(
    snapshot.plan,
    {
      buildImage: async () => {
        await runHostAdmission(4, ['docker', 'compose', 'build', 'fuseki'], {
          root: candidate, run: async () => {
            compose(candidate, ['build', 'fuseki'], 300_000, root);
            return 0;
          },
        });
      },
      rehearseMigrations: async () => {
        await rehearseRefreshMigrations(
          candidate,
          readEnv(join(dir, 'dev.env')),
          snapshot.input.pendingMigrations,
        );
      },
      stopWriters,
      beforeMutation: async (step) => {
        state.mutatingStep = step;
        saveState();
      },
      switchBackend: async () => {
        activateBackend(dir, candidate);
      },
      restartPrevious: async () => {
        await stopWriters();
        activateBackend(dir, previous);
        await restartResources();
        await waitReady();
        rmSync(pendingPath, { force: true });
        console.log('  Previous backend revision restarted; no storage/model maintenance began');
      },
      prepareStorage: async () => {
        const before = readEnv(join(dir, 'dev.env'));
        // Track the attempted storage topology before up/migration can partially
        // commit, so inspection and restart use those same Compose bind paths.
        activateBackend(dir, candidate, 'storage-backend');
        prepareRefreshStorage(candidate);
        const changes = changedEnvironment(before, readEnv(join(dir, 'dev.env')));
        if (changes.length)
          throw new Error(
            `Prepared environment changed (${changes.join(', ')}). ${appHostRestartInstruction}`,
          );
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
      },
      restartResources,
      waitReady,
      approveZones: async (beforeMutation) => {
        const env = readEnv(join(dir, 'dev.env'));
        const zones = await inspectOfficialZoneApprovals(
          (path) =>
            fetch(new URL(path, env.MAIN_ORIGIN!), {
              signal: AbortSignal.timeout(10_000),
            }),
          (slug) => officialSourceDigest(slug, join(candidate, 'apps/web/zones/official')),
        );
        if (zones.length) {
          await beforeMutation();
          seedRefreshZones(candidate, dir, zones.map((zone) => zone.slug));
        }
      },
      stopAppHost: async () => {
        command(root, 'task', ['dev:stop'], process.env, 60_000);
      },
      recordSuccess: async () => {
        const checked = await inspectRefresh(candidate, root);
        if (!refreshIsCurrent(checked.input))
          throw new Error(
            'Shared stack is not current after refresh; no success checkpoint recorded',
          );
        writeFileSync(
          `${checkpointPath}.tmp`,
          JSON.stringify({ ...checked.checkpoint, refreshId: state.refreshId }) + '\n',
          {
            mode: 0o600,
          },
        );
        renameSync(`${checkpointPath}.tmp`, checkpointPath);
        try {
          rmSync(pendingPath, { force: true });
        } catch {
          console.warn(
            'Refresh committed; completed maintenance marker will be ignored on the next refresh',
          );
        }
      },
    },
    Boolean(pending?.mutatingStep),
  );
  try {
    pruneBackendRevisions(root, dir);
  } catch {
    console.warn('An unused backend revision could not be removed');
  }
  console.log(
    snapshot.plan.steps.length
      ? 'Shared stack refresh complete'
      : 'Shared stack already current; no changes',
  );
 }

if (import.meta.main) {
  try {
    const [mode, root, revision, lock, parent] = process.argv.slice(2);
    if (mode !== '--staged' || process.argv.length !== 7 || !root || !revision || !lock || !parent)
      throw new Error('Refresh child requires --staged <root> <revision> <lock> <parent-pid>');
    await refreshStagedStack(root, revision, lock, Number(parent));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
