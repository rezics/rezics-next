import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client, Pool } from 'pg';
import { acquireHeavy } from '../goal/goalctl.ts';
import { migrationDirectories, migrationRecords, type SchemaOwner } from '../ops/migrate.ts';
import { fusekiImageFromCompose } from '../load/image.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { readActiveModelGeneration } from '../../services/main/src/modules/semantic/generation-guard.ts';
import { ensureStatementSeekCurrent, statementUpgradeCurrent } from '../../services/main/src/modules/statement/upgrade.ts';
import { hasUnnormalizedMembership } from '../../services/main/src/modules/structure/membership-normalize.ts';
import { mainSpec, relaySpec } from '../../services/main/src/config.ts';
import { accountSpec } from '../../services/account/src/config.ts';
import { appEnvironment, composeProcessEnvironment, readEnv, stackDirectory } from './config.ts';
import { AppHostResourceLost, appHostRestartInstruction, type RefreshInputs, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  refreshResources, type RefreshResource } from './refresh.ts';
import { inspectOfficialZoneApprovals } from './seed/official-zones-step.ts';
import { officialSourceDigest } from './seed/official-theme-step.ts';

interface Resource {
  name: string; displayName?: string; state?: string; healthStatus?: string;
  dashboardUrl?: string; urls?: { url: string }[];
  environment?: Record<string, string | null>;
  properties?: { 'executable.pid'?: number | null };
}
interface Checkpoint { revision: string; appHostHash: string; appHostSession: string }

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

function compose(root: string, args: string[], timeout = 180_000): string {
  const file = join(stackDirectory(root, { profile: 'dev' }), 'compose.env');
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
  const appHostHash = sha256(readFileSync(join(root, 'apphost/apphost.mts')));
  const image = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image;
  const inspected = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (inspected.error || (inspected.status !== 0 && !/No such image|No such object/i.test(inspected.stderr))) {
    throw new Error('Cannot inspect the pinned Fuseki image; check Docker availability');
  }
  const imagePresent = inspected.status === 0;
  const containerOutput = compose(stackRoot, ['ps', '--all', '--format', 'json']);
  const containers = (containerOutput.startsWith('[') ? JSON.parse(containerOutput)
    : containerOutput.split('\n').filter(Boolean).map(line => JSON.parse(line))) as
    Array<{ ID: string; Service: string; State: string; Health?: string }>;
  const hashes = compose(stackRoot, ['config', '--hash', '*']).split('\n').filter(Boolean).map(line => line.split(/\s+/));
  let storageChanged = !imagePresent;
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
      path => fetch(new URL(path, env.MAIN_ORIGIN!), { signal: AbortSignal.timeout(10_000) }),
      slug => officialSourceDigest(slug, join(root, 'apps/web/zones/official')));
  const input = { revision, previousRevision: checkpoint?.revision, imagePresent, storageChanged, pendingMigrations,
    modelCurrent: active.generation === targetGeneration, statementCurrent,
    membershipCurrent: serviceReady('fuseki') && !await hasUnnormalizedMembership(
      new FusekiClient(env.FUSEKI_URL!, env.FUSEKI_MAINTENANCE_TOKEN, env.FUSEKI_COMMAND_TOKEN)),
    unhealthyResources: refreshResources.filter(name => resources[name].state !== 'Running'
      || resources[name].healthStatus !== 'Healthy'),
    environmentChanges: [...new Set(environmentChanges)].sort(),
    appHostChanged: checkpoint?.appHostSession === appHostSession && checkpoint.appHostHash !== appHostHash,
    lostResources, zoneApprovals };
  return { input, plan: refreshPlan(input), image, active, targetGeneration, resources,
    checkpointPath, checkpoint: { revision, appHostHash, appHostSession } satisfies Checkpoint };
}

/** The stack is current when recording a checkpoint at the current HEAD would leave no step or blocker. The plan
 * is computed against that hypothetical checkpoint, because the stored one names an older revision whenever any
 * commit (a brief, an archive) landed meanwhile, and that alone would always plan a prepare and restart. */
export function refreshIsCurrent(input: RefreshInputs): boolean {
  const plan = refreshPlan({ ...input, previousRevision: input.revision });
  return !plan.steps.length && !plan.blockers.length;
}

export interface RefreshPreparation {
  prepare(onMigrations: (applied: string[]) => void): Promise<Record<string, string>>;
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

export async function refreshSharedStack(root: string, args: string[], preparation: RefreshPreparation): Promise<void> {
  if (args.length > 1 || args.some(arg => !['--dry-run', '--wait'].includes(arg))) {
    throw new Error('Usage: task dev:refresh -- [--dry-run | --wait]');
  }
  // With several Goals the heavy lock is rarely free and unqueued; --wait takes the next turn before ordinary waiters, without interrupting its holder.
  const wait = args.includes('--wait');
  const gitDir = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertRefreshCheckout(gitDir !== common, command(root, 'git', ['branch', '--show-current']),
    Boolean(command(root, 'git', ['status', '--porcelain', '--untracked-files=no'])));
  const lock = join(resolve(common, '..'), '.temp/goal-orchestration/qa-slots/heavy');
  if (!wait && refreshHeavyLockHeld(lock)) throw new Error('Shared-stack refresh refused: the host-wide heavy QA lock is held; retry after that run finishes or pass --wait');
  if (args.includes('--dry-run')) {
    const snapshot = await inspectRefresh(root);
    printRefreshPlan(snapshot);
    if (snapshot.plan.blockers.length) throw new Error('Dry-run found an AppHost restart requirement');
    console.log('Dry-run: no changes made');
    return;
  }
  let release: () => void;
  try { release = await acquireHeavy(['task', 'dev:refresh'], { lockDir: lock, deadline: wait ? Date.now() + 2 * 3_600_000 : Date.now() - 1 }); }
  catch { throw new Error(`Shared-stack refresh refused: heavy QA is held or queued; ${wait ? 'it stayed held for two hours' : 'retry after it finishes or pass --wait'}`); }
  const onExit = () => release();
  process.once('exit', onExit);
  try {
    const snapshot = await inspectRefresh(root);
    printRefreshPlan(snapshot);
    await executeRefresh(snapshot.plan, {
      buildImage: async () => {
        compose(root, ['build', 'fuseki'], 300_000);
        console.log(`  Built image: ${snapshot.image}`);
      },
      rehearseMigrations: async () => {
        const env = readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env'));
        await rehearseRefreshMigrations(root, env, snapshot.input.pendingMigrations);
        console.log('  Pending SQL migrations rehearsed and rolled back; writers still running');
      },
      stopWriters: async () => {
        for (const name of [...refreshResources].reverse()) {
          if (['Exited', 'Finished', 'FailedToStart'].includes(snapshot.resources[name].state ?? '')) continue;
          assertRefreshResourcePresent(root, name);
          aspire(root, ['resource', name, 'stop']);
          aspire(root, ['wait', name, '--status', 'down', '--timeout', '60'], 65_000);
        }
      },
      prepareStorage: async () => {
        const prepared = await preparation.prepare(applied => console.log(`  SQL migrations applied: ${applied.join(', ') || 'none'}`));
        const changes = changedEnvironment(readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env')), prepared);
        if (changes.length) throw new Error(`Prepared environment changed (${changes.join(', ')}). ${appHostRestartInstruction}`);
        console.log('  Storage and owner data migrations ready; volumes retained');
      },
      alignModel: async () => {
        const { ensureLocalDatasetModelGeneration } = await import('../datasets/model-bootstrap.ts');
        const result = await ensureLocalDatasetModelGeneration(stackDirectory(root, { profile: 'dev' }));
        console.log(`  Model generation: ${result.generation} (${result.state})`);
      },
      restartResources: async () => {
        const env = readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env'));
        const pool = new Pool({connectionString: env.ACCESS_DATABASE_URL,max: 2,connectionTimeoutMillis: 5_000});
        try { await ensureStatementSeekCurrent({fuseki: new FusekiClient(env.FUSEKI_URL!,
          env.FUSEKI_MAINTENANCE_TOKEN,env.FUSEKI_COMMAND_TOKEN),lineage: {
          dataEpoch: env.MAIN_DATA_EPOCH!,routingEpoch: env.MAIN_ROUTING_EPOCH!},objectDirectory: env.MAIN_OBJECT_DIRECTORY!},pool); }
        finally { await pool.end(); }
        for (const name of refreshResources) {
          aspire(root, ['resource', name, 'restart']);
          aspire(root, ['wait', name, '--timeout', '120'], 125_000);
          assertRefreshResourcePresent(root, name);
          console.log(`  Restarted: ${name}`);
        }
      },
      waitReady: async () => {
        for (const name of refreshResources) assertRefreshResourcePresent(root, name);
        for (const name of ['account', 'main'] as const) {
          const endpoint = snapshot.resources[name].urls?.[0]?.url;
          if (!endpoint) throw new Error(`Aspire did not declare a readiness URL for ${name}`);
          const response = await fetch(new URL('/health/ready', endpoint), { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error(`${name} readiness failed (HTTP ${response.status})`);
        }
      },
      approveZones: async () => {
        const env = readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env'));
        const zones = await inspectOfficialZoneApprovals(
          path => fetch(new URL(path, env.MAIN_ORIGIN!), { signal: AbortSignal.timeout(10_000) }),
          slug => officialSourceDigest(slug));
        if (zones.length) command(root, 'task', ['dev:seed', '--', '--themes-only',
          `--packages=${zones.map(zone => zone.slug).join(',')}`], process.env, 600_000);
      },
      stopAppHost: async () => {
        command(root, 'task', ['dev:stop'], process.env, 60_000);
      },
      recordSuccess: async () => {
        const checked = await inspectRefresh(root);
        if (command(root, 'git', ['status', '--porcelain', '--untracked-files=no']) || !refreshIsCurrent(checked.input)) {
          throw new Error('Shared stack changed or is not current after refresh; no success checkpoint recorded');
        }
        writeFileSync(`${snapshot.checkpointPath}.tmp`, `${JSON.stringify(checked.checkpoint)}\n`, { mode: 0o600 });
        renameSync(`${snapshot.checkpointPath}.tmp`, snapshot.checkpointPath);
      },
    });
    console.log(snapshot.plan.steps.length ? 'Shared stack refresh complete' : 'Shared stack already current; no changes');
  } finally { process.removeListener('exit', onExit); release(); }
}
