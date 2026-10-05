import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client } from 'pg';
import { acquireHeavy } from '../goal/goalctl.ts';
import { migrationDirectories, migrationRecords, type SchemaOwner } from '../ops/migrate.ts';
import { fusekiImageFromCompose } from '../load/image.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { readActiveModelGeneration } from '../../services/main/src/modules/semantic/generation-guard.ts';
import { mainSpec, relaySpec } from '../../services/main/src/config.ts';
import { accountSpec } from '../../services/account/src/config.ts';
import { appEnvironment, composeProcessEnvironment, readEnv, stackDirectory } from './config.ts';
import { assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  refreshResources, type RefreshResource } from './refresh.ts';

interface Resource {
  name: string; displayName?: string; state?: string; healthStatus?: string;
  dashboardUrl?: string; urls?: { url: string }[];
  environment?: Record<string, string | null>;
}
interface Checkpoint { revision: string; appHostHash: string; appHostSession: string }

function command(root: string, executable: string, args: string[], env = process.env, timeout = 30_000): string {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Describe and Compose output can contain secrets; never include it in errors.
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args[0]} failed (exit ${result.status ?? 'timeout/error'})`);
  return result.stdout.trim();
}

function aspire(root: string, args: string[], timeout = 30_000): string {
  return command(root, 'node', [join(root, 'node_modules/@microsoft/aspire-cli/bin/aspire.js'),
    ...args, '--apphost', join(root, 'apphost/apphost.mts'), '--non-interactive', '--nologo'],
  process.env, timeout);
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

/** Read the lock without reaping stale tickets: dry-run has no writes. */
export function refreshHeavyLockHeld(path: string, alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}): boolean {
  if (!existsSync(path)) return false;
  const pid = existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
  return alive(pid) || Date.now() - statSync(path).mtimeMs < 10_000;
}

export async function inspectRefresh(root: string) {
  const dir = stackDirectory(root, { profile: 'dev' });
  const env = readEnv(join(dir, 'dev.env'));
  const expected = expectedRefreshEnvironment(root);
  const environmentChanges = changedEnvironment(env, expected);
  const composeEnv = readEnv(join(dir, 'compose.env'));
  for (const key of ['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY', 'ACCOUNTS_PORT']) {
    if (!composeEnv[key] && !environmentChanges.includes(key)) environmentChanges.push(key);
  }
  const described = JSON.parse(aspire(root, ['describe', '--format', 'Json'])) as { resources?: Resource[] };
  const resources = Object.fromEntries(refreshResources.map(name => {
    const resource = described.resources?.find(item => item.displayName === name || item.name === name);
    if (!resource) throw new Error(`Shared AppHost resource ${name} is missing; restart the AppHost with task dev`);
    return [name, resource];
  })) as Record<RefreshResource, Resource>;
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
  const appHostSession = new URL(resources.account.dashboardUrl!).origin;
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
  const containerOutput = compose(root, ['ps', '--all', '--format', 'json']);
  const containers = (containerOutput.startsWith('[') ? JSON.parse(containerOutput)
    : containerOutput.split('\n').filter(Boolean).map(line => JSON.parse(line))) as
    Array<{ ID: string; Service: string; State: string; Health?: string }>;
  const hashes = compose(root, ['config', '--hash', '*']).split('\n').filter(Boolean).map(line => line.split(/\s+/));
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
  const input = { revision, previousRevision: checkpoint?.revision, imagePresent, storageChanged, pendingMigrations,
    modelCurrent: active.generation === targetGeneration,
    unhealthyResources: refreshResources.filter(name => resources[name].state !== 'Running'
      || resources[name].healthStatus !== 'Healthy'),
    environmentChanges: [...new Set(environmentChanges)].sort(),
    appHostChanged: checkpoint?.appHostSession === appHostSession && checkpoint.appHostHash !== appHostHash };
  return { input, plan: refreshPlan(input), image, active, targetGeneration, resources,
    checkpointPath, checkpoint: { revision, appHostHash, appHostSession } satisfies Checkpoint };
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
  console.log(`  Plan: ${snapshot.plan.steps.join(' -> ') || 'no changes'}`);
  for (const blocker of snapshot.plan.blockers) console.log(`  BLOCKED: ${blocker}`);
}

export async function refreshSharedStack(root: string, args: string[], preparation: RefreshPreparation): Promise<void> {
  if (args.length > 1 || args.some(arg => arg !== '--dry-run')) throw new Error('Usage: task dev:refresh -- [--dry-run]');
  const gitDir = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertRefreshCheckout(gitDir !== common, command(root, 'git', ['branch', '--show-current']),
    Boolean(command(root, 'git', ['status', '--porcelain', '--untracked-files=no'])));
  const lock = join(resolve(common, '..'), '.temp/goal-orchestration/qa-slots/heavy');
  if (refreshHeavyLockHeld(lock)) throw new Error('Shared-stack refresh refused: the host-wide heavy QA lock is held; retry after that run finishes');
  if (args.includes('--dry-run')) {
    const snapshot = await inspectRefresh(root);
    printRefreshPlan(snapshot);
    if (snapshot.plan.blockers.length) throw new Error('Dry-run found an AppHost restart requirement');
    console.log('Dry-run: no changes made');
    return;
  }
  let release: () => void;
  try { release = await acquireHeavy(['task', 'dev:refresh'], { lockDir: lock, deadline: Date.now() - 1 }); }
  catch { throw new Error('Shared-stack refresh refused: heavy QA is held or queued; retry after it finishes'); }
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
      stopWriters: async () => {
        for (const name of [...refreshResources].reverse()) {
          if (['Exited', 'Finished', 'FailedToStart'].includes(snapshot.resources[name].state ?? '')) continue;
          aspire(root, ['resource', name, 'stop']);
          aspire(root, ['wait', name, '--status', 'down', '--timeout', '60'], 65_000);
        }
      },
      prepareStorage: async () => {
        const prepared = await preparation.prepare(applied => console.log(`  SQL migrations applied: ${applied.join(', ') || 'none'}`));
        const changes = changedEnvironment(readEnv(join(stackDirectory(root, { profile: 'dev' }), 'dev.env')), prepared);
        if (changes.length) throw new Error(`Prepared environment changed (${changes.join(', ')}); restart the AppHost with task dev before retrying`);
        console.log('  Storage and owner data migrations ready; volumes retained');
      },
      alignModel: async () => {
        const { ensureLocalDatasetModelGeneration } = await import('../datasets/model-bootstrap.ts');
        const result = await ensureLocalDatasetModelGeneration(stackDirectory(root, { profile: 'dev' }));
        console.log(`  Model generation: ${result.generation} (${result.state})`);
      },
      restartResources: async () => {
        for (const name of refreshResources) {
          aspire(root, ['resource', name, 'restart']);
          aspire(root, ['wait', name, '--timeout', '120'], 125_000);
          console.log(`  Restarted: ${name}`);
        }
      },
      waitReady: async () => {
        for (const name of ['account', 'main'] as const) {
          const endpoint = snapshot.resources[name].urls?.[0]?.url;
          if (!endpoint) throw new Error(`Aspire did not declare a readiness URL for ${name}`);
          const response = await fetch(new URL('/health/ready', endpoint), { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error(`${name} readiness failed (HTTP ${response.status})`);
        }
      },
      recordSuccess: async () => {
        const checked = await inspectRefresh(root);
        if (command(root, 'git', ['status', '--porcelain', '--untracked-files=no'])
          || checked.input.revision !== snapshot.input.revision || checked.input.storageChanged
          || checked.input.pendingMigrations.length || !checked.input.modelCurrent
          || checked.input.unhealthyResources.length || checked.plan.blockers.length) {
          throw new Error('Shared stack changed or is not current after refresh; no success checkpoint recorded');
        }
        writeFileSync(`${snapshot.checkpointPath}.tmp`, `${JSON.stringify(checked.checkpoint)}\n`, { mode: 0o600 });
        renameSync(`${snapshot.checkpointPath}.tmp`, snapshot.checkpointPath);
      },
    });
    console.log(snapshot.plan.steps.length ? 'Shared stack refresh complete' : 'Shared stack already current; no changes');
  } finally { process.removeListener('exit', onExit); release(); }
}
