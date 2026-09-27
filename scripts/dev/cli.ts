import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph, GRAPHS, DATASET, RV } from '../../services/main/src/modules/work/activate.ts';
import { appEnvironment, assertSavedStackRawUpdate, assertSavedStackStorage,
  composeProcessEnvironment, devPorts, ensureSecrets, hostsAccountsApp, parseOptions, projectName,
  readEnv, replacePrivate, savePrivate, stackDirectory, type StackOptions } from './config.ts';
import { bootstrapWebAuth, upgradeWebClient } from './web-auth-bootstrap.ts';
import { compatibleLoadStorage, loadCompatibility,
  type LoadCompatibility } from '../load/compatibility.ts';
import { fusekiImageFromCompose } from '../load/image.ts';

const root = resolve(import.meta.dir, '../..');
const composeFile = join(root, 'infra/dev/compose.yaml');
const qaComposeFile = join(root, 'infra/dev/compose.qa.yaml');
const qaRawUpdateComposeFile = join(root, 'infra/dev/compose.qa-raw-update.yaml');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env,
  timeout?: number): string {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'], timeout });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function runtimeEnv(): NodeJS.ProcessEnv {
  try {
    run('docker', ['info', '--format', '{{.ServerVersion}}']);
    return process.env;
  } catch {
    throw new Error('Docker is unavailable. Start Docker Desktop with `systemctl --user start docker-desktop`, then retry.');
  }
}

function composeArgs(options: StackOptions, envFile: string, command: string[]): string[] {
  return ['compose', '--env-file', envFile, '-f', composeFile,
    ...(options.profile === 'qa' && !options.persistent ? ['-f', qaComposeFile] : []),
    ...(options.rawUpdate ? ['-f', qaRawUpdateComposeFile] : []),
    '--project-name', projectName(options), ...command];
}

function compose(options: StackOptions, command: string[], env: NodeJS.ProcessEnv,
  timeout?: number): string {
  const envFile = join(stackDirectory(root, options), 'compose.env');
  const saved = readEnv(envFile);
  assertSavedStackStorage(options, saved);
  assertSavedStackRawUpdate(options, saved);
  return run('docker', composeArgs(options, envFile, command),
    composeProcessEnvironment(env, saved), timeout);
}

/** Clone only a stopped, verified practical-load stack. Both database volumes
 * and the object store are copied as whole units; there is no live TDB2 copy. */
async function stackClone(args: string[]): Promise<void> {
  const marker = args.indexOf('--to-run-id');
  const targetId = args[marker + 1];
  if (marker < 0 || !targetId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(targetId)) {
    throw new Error('stack:clone requires --to-run-id <new QA id>');
  }
  const source = parseOptions([...args.slice(0, marker), ...args.slice(marker + 2)]);
  if (source.profile !== 'qa' || !source.persistent || source.rawUpdate
    || !source.runId?.startsWith('load-') || source.runId === targetId) {
    throw new Error('stack:clone requires a persistent load QA source and a distinct target');
  }
  const target: StackOptions = { profile: 'qa', runId: targetId, persistent: true };
  const sourceDir = stackDirectory(root, source);
  const targetDir = stackDirectory(root, target);
  if (existsSync(targetDir)) throw new Error('stack:clone target already exists');
  const sourceEnvPath = join(sourceDir, 'compose.env');
  const sourceAppsPath = join(sourceDir, 'apps.env');
  const runPath = join(root, '.artifacts', 'load', source.runId, 'run.json');
  if (!existsSync(sourceEnvPath) || !existsSync(sourceAppsPath) || !existsSync(runPath)) {
    throw new Error('stack:clone source lacks retained configuration or load evidence');
  }
  const runEvidence = JSON.parse(readFileSync(runPath, 'utf8')) as {
    mode?: string; baselineDigest?: string; sourceStable?: boolean;
    failure?: string; compatibility?: LoadCompatibility;
    fusekiImageId?: string };
  if (runEvidence.mode !== 'prepare' || runEvidence.failure || runEvidence.sourceStable !== true
    || !/^[0-9a-f]{64}$/.test(runEvidence.baselineDigest ?? '')
    || !compatibleLoadStorage(runEvidence.compatibility, loadCompatibility(root))) {
    throw new Error('stack:clone source failed or its schema/model/analyzer/engine fingerprint differs');
  }
  const env = runtimeEnv();
  const image = fusekiImageFromCompose(readFileSync(composeFile, 'utf8')).image;
  const imageId = run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], env, 10_000);
  if (!/^sha256:[0-9a-f]{64}$/.test(runEvidence.fusekiImageId ?? '')
    || imageId !== runEvidence.fusekiImageId) {
    throw new Error('stack:clone Fuseki image identity differs from the retained source');
  }
  const sourceProject = projectName(source);
  const targetProject = projectName(target);
  const running = run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${sourceProject}`], env);
  if (running) throw new Error('stack:clone source must be stopped');
  const volumeKinds = ['postgres_data', 'fuseki_data', 'rustfs_data'] as const;
  for (const kind of volumeKinds) {
    run('docker', ['volume', 'inspect', `${sourceProject}_${kind}`], env, 10_000);
    const absent = spawnSync('docker', ['volume', 'inspect', `${targetProject}_${kind}`],
      { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    if (absent.status === 0) throw new Error(`stack:clone target volume already exists: ${kind}`);
  }
  const sourceEnv = readEnv(sourceEnvPath);
  const sourceObjects = readEnv(sourceAppsPath).MAIN_OBJECT_DIRECTORY;
  if (!sourceObjects || !existsSync(sourceObjects)) throw new Error('stack:clone source objects are missing');
  const postgresImage = readFileSync(composeFile, 'utf8')
    .match(/^  postgres:\n    image: (postgres:18\.6-trixie@sha256:[0-9a-f]{64})$/m)?.[1];
  if (!postgresImage) throw new Error('pinned PostgreSQL copy image is unavailable');
  const created: string[] = [];
  try {
    const initial = await stackConfig(target);
    const ports = Object.fromEntries(Object.keys(devPorts())
      .map(key => [key, initial.composeEnv[key]!])) as Record<string, string>;
    const targetEnv = { ...sourceEnv, ...ports };
    replacePrivate(join(targetDir, 'compose.env'), targetEnv);
    const targetApps = appEnvironment(targetEnv, targetDir);
    replacePrivate(join(targetDir, 'apps.env'), targetApps);
    for (const kind of volumeKinds) {
      const from = `${sourceProject}_${kind}`;
      const to = `${targetProject}_${kind}`;
      run('docker', ['volume', 'create', to], env, 15_000);
      created.push(to);
      run('docker', ['run', '--rm', '--network', 'none', '--user', '0:0',
        '--volume', `${from}:/from:ro`, '--volume', `${to}:/to`,
        '--entrypoint', 'sh', postgresImage, '-ec', 'cp -a /from/. /to/'], env, 120_000);
    }
    cpSync(sourceObjects, targetApps.MAIN_OBJECT_DIRECTORY, { recursive: true, force: false });
    await stackUp(target);
    const container = run('docker', ['ps', '-q',
      '--filter', `label=com.docker.compose.project=${targetProject}`,
      '--filter', 'label=com.docker.compose.service=fuseki'], env, 10_000);
    if (!container || run('docker', ['inspect', container, '--format', '{{.Image}}'], env, 10_000)
      !== runEvidence.fusekiImageId) {
      throw new Error('Cloned Fuseki container differs from the retained engine image');
    }
    const access = new Client({ connectionString: targetApps.ACCESS_DATABASE_URL });
    await access.connect();
    try { await access.query('SELECT 1'); } finally { await access.end(); }
    await initializeGraph(targetApps);
    console.log(`Cloned ${sourceProject} into ${targetProject}; verify cold queries and a fresh command cohort`);
  } catch (error) {
    try { compose(target, ['down', '--volumes', '--remove-orphans'], env, 60_000); }
    catch { /* remove volumes individually below */ }
    for (const volume of created) {
      try { run('docker', ['volume', 'rm', volume], env, 15_000); } catch { /* retain original error */ }
    }
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }
}

/** Physical QA backup runs beside its source container, avoiding host-bridge
 * replication HBA assumptions. Only the named coordinated-cut fixture may call it. */
async function stackBackup(options: StackOptions): Promise<void> {
  if (options.profile !== 'qa' || !/^owner-cut-[0-9a-f]{12}$/.test(options.runId ?? '')
    || options.persistent || options.rawUpdate) {
    throw new Error('stack:backup requires a disposable owner-cut QA run-id');
  }
  const dir = stackDirectory(root, options);
  if (!existsSync(join(dir, 'compose.env')) || !existsSync(join(dir, 'apps.env'))) {
    throw new Error(`${projectName(options)} has no saved stack`);
  }
  const apps = readEnv(join(dir, 'apps.env'));
  const access = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
  await access.connect();
  try {
    const fence = await access.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true');
    if (fence.rows[0]?.open !== false) throw new Error('Access must be held for backup');
  } finally { await access.end(); }
  const fuseki = new FusekiClient(apps.FUSEKI_URL, apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN);
  const held = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
    <${DATASET}> rv:restoreHold true . } }`);
  if (held.boolean !== true) throw new Error('graph must be held for backup');
  const env = runtimeEnv();
  const id = randomUUID();
  const remote = `/tmp/rezics-owner-cut-${id}`;
  const local = join(dir, 'recovery-backups', id);
  mkdirSync(join(dir, 'recovery-backups'), { recursive: true, mode: 0o700 });
  try {
    compose(options, ['exec', '-T', '-u', 'postgres', 'postgres', 'sh', '-ec',
      `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`],
    env, 65_000);
    const container = compose(options, ['ps', '-q', 'postgres'], env, 10_000);
    if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('QA PostgreSQL container is unavailable');
    run('docker', ['cp', `${container}:${remote}`, local], env, 20_000);
    if (!existsSync(join(local, 'PG_VERSION'))) throw new Error('copied PostgreSQL backup is incomplete');
    console.log(local);
  } catch (error) {
    rmSync(local, { recursive: true, force: true });
    throw error;
  } finally {
    try { compose(options, ['exec', '-T', '-u', 'postgres', 'postgres',
      'rm', '-rf', remote], env, 10_000); }
    catch (error) { console.error('Could not remove disposable container backup:', error); }
  }
}

async function availablePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return rej(new Error('Could not allocate port'));
      server.close(() => res(address.port));
    });
  });
}

async function stackConfig(options: StackOptions): Promise<{ composeEnv: Record<string, string>; apps: Record<string, string>; dir: string }> {
  const dir = stackDirectory(root, options);
  const portNames = Object.keys(devPorts());
  const ports: Record<string, number> = options.profile === 'dev' ? devPorts() : {};
  const saved = existsSync(join(dir, 'compose.env')) ? readEnv(join(dir, 'compose.env')) : undefined;
  // A worktree backend also serves the Accounts app on a port of its own.
  const needed = options.profile === 'qa' ? [...saved ? [] : portNames,
    ...hostsAccountsApp(options) && !saved?.ACCOUNTS_PORT ? ['ACCOUNTS_PORT'] : []] : [];
  const selected = new Set<number>();
  for (const name of needed) {
    let port: number;
    do { port = await availablePort(); } while (selected.has(port));
    selected.add(port);
    ports[name] = port;
  }
  const composeEnv = ensureSecrets(root, options, ports);
  // apps.env is derived from compose.env; regenerate it when an older layout
  // lacks variables that newer services require.
  const appFile = join(dir, 'apps.env');
  const derived = appEnvironment(composeEnv, dir);
  if (!existsSync(appFile)) savePrivate(appFile, derived);
  else if (JSON.stringify(readEnv(appFile)) !== JSON.stringify(derived)) replacePrivate(appFile, derived);
  const apps = readEnv(appFile);
  mkdirSync(apps.MAIN_OBJECT_DIRECTORY, { recursive: true, mode: 0o700 });
  mkdirSync(apps.MAIN_CANDIDATE_DIRECTORY, { recursive: true, mode: 0o700 });
  return { composeEnv, apps, dir };
}

function printEndpoints(options: StackOptions, env: Record<string, string>, dir: string): void {
  console.log(`${projectName(options)} ready`);
  console.log(`  Main:    http://127.0.0.1:${env.MAIN_PORT}/health/ready (after task dev)`);
  console.log(`  Account: http://127.0.0.1:${env.ACCOUNT_PORT}/health/ready (after task dev)`);
  if (env.ACCOUNTS_PORT) console.log(`  Accounts app: http://127.0.0.1:${env.ACCOUNTS_PORT}/ (after task dev)`);
  console.log(`  Fuseki:  http://127.0.0.1:${env.FUSEKI_PORT}/rezics/`);
  console.log(`  RustFS:  http://127.0.0.1:${env.RUSTFS_PORT}/`);
  console.log(`  Mailpit: http://127.0.0.1:${env.MAILPIT_HTTP_PORT}/`);
  console.log(`  Private configuration: ${dir}`);
}

async function stackUp(options: StackOptions): Promise<{ apps: Record<string, string>; dir: string }> {
  const releaseMarker = join(stackDirectory(root, options), 'release-format.json');
  if (existsSync(releaseMarker)) {
    const saved = JSON.parse(readFileSync(releaseMarker, 'utf8')) as { state?: string };
    if (saved.state !== 'ready') {
      throw new Error('Saved release format is pending; restore a compatible recovery set');
    }
  }
  if (!existsSync(composeFile)) throw new Error(`Compose topology is missing: ${composeFile}`);
  if (options.profile === 'qa' && !options.persistent && !existsSync(qaComposeFile)) throw new Error(`QA Compose topology is missing: ${qaComposeFile}`);
  if (options.rawUpdate && !existsSync(qaRawUpdateComposeFile)) {
    throw new Error(`QA raw-update Compose topology is missing: ${qaRawUpdateComposeFile}`);
  }
  const env = runtimeEnv();
  const freshQa = options.profile === 'qa' && !existsSync(join(stackDirectory(root, options), 'compose.env'));
  for (let attempt = 0; ; attempt++) {
    const config = await stackConfig(options);
    try {
      compose(options, ['up', '-d', '--wait'], env);
      printEndpoints(options, config.composeEnv, config.dir);
      return config;
    } catch (error) {
      if (!freshQa || attempt > 0 || !/port is already allocated|address already in use/i.test(String(error))) {
        throw error;
      }
      // A concurrent QA project can take a released ephemeral port before
      // Compose binds it. This project has no data yet: remove its partial
      // containers and configuration, then allocate a new set of ports once.
      compose(options, ['down', '--volumes', '--remove-orphans'], env);
      rmSync(config.dir, { recursive: true, force: true });
    }
  }
}

async function install(): Promise<void> {
  if (process.versions.bun !== '1.4.2') throw new Error('Bun 1.4.2 is required');
  if (run('node', ['--version']) !== 'v26.8.2') throw new Error('Node 26.8.2 is required');
  if (run('corepack', ['yarn', '--version']) !== '4.18.0') throw new Error('Yarn 4.18.0 is required');
  if (run('task', ['--version']) !== '3.53.1') throw new Error('Task 3.53.1 is required; see the toolchain lock');
  if (!run('node', [aspire, '--version']).startsWith('13.5.4+')) throw new Error('Aspire CLI 13.5.4 is required');
  const env = runtimeEnv();
  if (!existsSync(composeFile)) throw new Error(`Compose topology is missing: ${composeFile}`);
  const options: StackOptions = { profile: 'dev' };
  await stackConfig(options);
  compose(options, ['pull', '--ignore-buildable'], env);
  compose(options, ['build', 'fuseki'], env);
  run('node_modules/.bin/playwright', ['install', 'chromium']);
  console.log('Toolchain installed');
}

async function migrateSql(url: string, path: string, key: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query('SELECT 1 FROM public.rezics_local_migration WHERE name = $1', [key]);
    if (!applied.rowCount) {
      await client.query(readFileSync(path, 'utf8'));
      await client.query('INSERT INTO public.rezics_local_migration(name) VALUES ($1)', [key]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  finally { await client.end(); }
}

async function migrateApps(apps: Record<string, string>): Promise<void> {
  for (const [database, directory] of [
    ['ACCESS_DATABASE_URL', 'services/main/migrations/access'],
    ['ACCOUNT_RELAY_DATABASE_URL', 'services/main/migrations/relay'],
  ] as const) {
    const base = join(root, directory);
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: base })].sort()) {
      await migrateSql(apps[database], join(base, file), `${directory}/${file}`);
    }
  }
  run('bun', ['services/account/src/migrate.ts'], { ...process.env, ...apps });
}

async function initializeGraph(apps: Record<string, string>): Promise<void> {
  const fuseki = new FusekiClient(apps.FUSEKI_URL, apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN);
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> { <${DATASET}> rv:dataEpoch ?epoch } }`);
  if (result.boolean !== true) {
    await initializeFreshGraph(fuseki, {
      dataEpoch: apps.MAIN_DATA_EPOCH, routingEpoch: apps.MAIN_ROUTING_EPOCH,
    });
  }
  const health = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
    <${DATASET}> rv:dataEpoch ${JSON.stringify(apps.MAIN_DATA_EPOCH)} ;
      rv:routingEpoch ${JSON.stringify(apps.MAIN_ROUTING_EPOCH)} . } }`);
  if (health.boolean !== true) throw new Error('Existing graph lineage does not match this stack; use stack:reset only if its data may be discarded');
}

/** A web auth fixture serves a stack only while it names the stack's issuer
 * (Access grants are bound to it, and it moves to the Accounts app) and its
 * client still exists (a worktree backend's dev:stop discards its data). */
async function webAuthFixtureCurrent(apps: Record<string, string>, publicPath: string): Promise<boolean> {
  const saved = JSON.parse(readFileSync(publicPath, 'utf8')) as { issuer?: string; clientId?: string };
  if (saved.issuer !== `${apps.ACCOUNT_BASE_URL}/api/auth` || !saved.clientId) return false;
  const account = new Client({ connectionString: apps.ACCOUNT_DATABASE_URL });
  await account.connect();
  try {
    return Boolean((await account.query('SELECT 1 FROM public."oauthClient" WHERE "clientId" = $1',
      [saved.clientId])).rowCount);
  } finally { await account.end(); }
}

const overridesFile = join(root, '.env.dev');
/** Variable names whose values are masked in output and passed to Aspire as secrets. */
const secretName = /SECRET|TOKEN|KEY|PASSWORD|_DATABASE_URL$/;

/** Start storage, apply migrations, check graph lineage and register the local
 * web OAuth client. Returns the application environment: the stack's derived
 * variables, the values the web auth fixture issued and personal overrides from
 * the repository-root .env.dev. */
async function prepareDev(options: StackOptions): Promise<Record<string, string>> {
  const { apps } = await stackUp(options);
  await migrateApps(apps);
  await initializeGraph(apps);
  const search = new FusekiClient(apps.FUSEKI_URL);
  const health = await search.commandHealth() as { textIndexUncertain?: boolean };
  if (health.textIndexUncertain === true) {
    if (options.profile !== 'dev' && !options.persistent) {
      throw new Error(`Fuseki search index is uncertain. This disposable stack cannot run search:rebuild. Recover it with \`task stack:reset -- --profile qa --run-id ${options.runId}\`, then \`task dev -- --backend\`.`);
    }
    const stackArgs = options.profile === 'dev' ? []
      : ['--profile', 'qa', '--run-id', options.runId!, '--persistent'];
    try { run('bun', ['scripts/operations/rebuild-content-search.ts', ...stackArgs], process.env, 420_000); }
    catch (error) {
      throw new Error(`Fuseki search index is uncertain. Run \`task search:rebuild${stackArgs.length ? ` -- ${stackArgs.join(' ')}` : ''}\` while Main is stopped. Automatic rebuild failed: ${String(error)}`);
    }
  }
  run('bun', ['services/main/src/relay-init.ts'], { ...process.env, ...apps }, 30_000);
  const authDir = join(stackDirectory(root, options), 'web-auth');
  const runtimePath = join(authDir, 'runtime.env');
  const publicPath = join(authDir, 'public.json');
  if (existsSync(publicPath) && !await webAuthFixtureCurrent(apps, publicPath)) {
    renameSync(authDir, `${authDir}.retired-${Date.now()}`);
  }
  if (!existsSync(runtimePath) || !existsSync(publicPath)) {
    // Account matches loopback callbacks without their port (RFC 8252), so these
    // two cover the web app on any localhost or 127.0.0.1 port.
    await bootstrapWebAuth({ profile: options.profile, runId: options.runId ?? 'dev',
      redirectUris: options.profile === 'dev'
        ? ['http://localhost:3000/auth/callback', 'http://127.0.0.1:3000/auth/callback']
        : ['http://localhost:3000/auth/callback', 'http://127.0.0.1:3003/auth/callback'] });
  } else await upgradeWebClient({ profile: options.profile, runId: options.runId ?? 'dev' });
  const issued = readEnv(runtimePath);
  const publicConfig = JSON.parse(readFileSync(publicPath, 'utf8')) as { clientId: string };
  const overrides = existsSync(overridesFile) ? parseEnv(readFileSync(overridesFile, 'utf8')) : {};
  return { ...apps,
    ACCOUNT_OPERATOR_USER_IDS: issued.ACCOUNT_OPERATOR_USER_IDS ?? '',
    ACCOUNT_MAIN_CLIENT_ID: issued.ACCOUNT_MAIN_CLIENT_ID ?? apps.ACCOUNT_MAIN_CLIENT_ID!,
    ACCOUNT_MAIN_CLIENT_SECRET: issued.ACCOUNT_MAIN_CLIENT_SECRET ?? apps.ACCOUNT_MAIN_CLIENT_SECRET!,
    WEB_OAUTH_CLIENT_ID: publicConfig.clientId,
    ...Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string')) };
}

/** Prepare the stack for an external process orchestrator and write the
 * application environment next to the stack's other private files. */
async function devPrepare(options: StackOptions): Promise<void> {
  const file = join(stackDirectory(root, options), 'dev.env');
  replacePrivate(file, await prepareDev(options));
  console.log(file);
}

// The package's bin shim has a CRLF shebang, so run its launcher through Node.
const aspire = join(root, 'node_modules/@microsoft/aspire-cli/bin/aspire.js');
const appHost = join(root, 'apphost/apphost.mts');
type DevMode = 'main' | 'frontend' | 'backend';

function checkout(): { worktree: boolean; mainRoot: string } {
  const gitDir = run('git', ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { worktree: gitDir !== common, mainRoot: resolve(common, '..') };
}

/** The main checkout serves the shared backend on fixed ports. A linked worktree
 * runs only the web app and Storybook against it, or with --backend its own
 * isolated QA stack and services; both use random ports. */
function devTarget(args: string[]): { mode: DevMode; options?: StackOptions } {
  const backend = args.includes('--backend');
  const rest = args.filter(arg => arg !== '--backend');
  if (!checkout().worktree) {
    if (backend) throw new Error('--backend is for worktrees; the main checkout always runs the shared backend');
    const options = { ...parseOptions(rest), accountsApp: true };
    return { mode: options.profile === 'qa' ? 'backend' : 'main', options };
  }
  if (!backend) {
    if (rest.length) throw new Error('A worktree frontend takes no stack options; add --backend for its own stack');
    return { mode: 'frontend' };
  }
  const runId = `wt-${basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 31);
  const options = { ...parseOptions(rest.length ? rest : ['--profile', 'qa', '--run-id', runId]),
    accountsApp: true };
  if (options.profile !== 'qa') throw new Error('A worktree backend runs an isolated QA stack');
  return { mode: 'backend', options };
}

function aspireCli(args: string[], env: NodeJS.ProcessEnv = process.env, capture = false) {
  const result = spawnSync('node', [aspire, ...args, '--apphost', appHost, '--non-interactive', '--nologo'],
    { cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`aspire ${args[0]} failed${capture ? `: ${result.stderr || result.stdout}` : ''}`);
  }
  return result.stdout ?? '';
}

/** Print each running resource with its URL, state and health. */
function devUrls(): void {
  const described = JSON.parse(aspireCli(['describe', '--format', 'Json'], process.env, true)) as
    { resources?: Array<{ name: string; displayName?: string; resourceType?: string; state?: string;
      healthStatus?: string; urls?: Array<{ url: string }> }> };
  for (const resource of described.resources ?? []) {
    if (resource.resourceType === 'Parameter') continue;
    const name = resource.displayName ?? resource.name.replace(/-[a-z0-9]{8}$/, '');
    const urls = (resource.urls ?? []).map(item => item.url).join(' ') || '-';
    console.log(`  ${name.padEnd(12)} ${urls.padEnd(28)} ${resource.state ?? ''} ${resource.healthStatus ?? ''}`.trimEnd());
  }
}

async function devStart(args: string[]): Promise<void> {
  const { mode, options } = devTarget(args);
  let envFile: string;
  if (mode === 'frontend') {
    const { mainRoot } = checkout();
    envFile = join(mainRoot, '.temp', 'stack', 'rezics-dev', 'dev.env');
    const shared = existsSync(envFile) ? readEnv(envFile) : undefined;
    const ready = shared && await fetch(`http://127.0.0.1:${shared.MAIN_PORT}/health/ready`,
      { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
    if (!ready) throw new Error(`The shared backend is not running; start it with \`task dev\` in ${mainRoot}`);
  } else {
    if (options!.rawUpdate) throw new Error('--raw-update cannot run with task dev');
    envFile = join(stackDirectory(root, options!), 'dev.env');
    replacePrivate(envFile, await prepareDev(options!));
  }
  aspireCli(['start', '--format', 'Json', ...(mode === 'main' ? [] : ['--isolated'])],
    { ...process.env, REZICS_DEV_ENV: envFile, REZICS_DEV_MODE: mode });
  console.log(`${mode === 'main' ? 'Shared backend and frontend' : mode === 'frontend'
    ? 'Frontend against the shared backend' : 'Isolated backend and frontend'}:`);
  for (const resource of ['account', 'main', 'main-relay', 'accounts', 'web', 'storybook']) {
    try { aspireCli(['wait', resource, '--timeout', '180'], process.env, true); }
    catch { /* frontend mode has no account/main executables; a failure shows in the table */ }
  }
  devUrls();
  console.log('Details: `task aspire -- describe`, `task aspire -- logs <resource>`, the dashboard above, '
    + 'or `task aspire -- agent mcp` for agents. Stop with `task dev:stop`.');
}

function devStop(args: string[]): void {
  const { mode, options } = devTarget(args);
  aspireCli(['stop']);
  if (mode === 'backend' && !options!.persistent) {
    compose(options!, ['down', '--volumes', '--remove-orphans'], runtimeEnv());
  }
}

/** Show where this checkout's application environment comes from, secrets masked. */
function devEnv(args: string[]): void {
  const { mode, options } = devTarget(args);
  const file = mode === 'frontend'
    ? join(checkout().mainRoot, '.temp', 'stack', 'rezics-dev', 'dev.env')
    : join(stackDirectory(root, options!), 'dev.env');
  if (!existsSync(file)) throw new Error(`${file} does not exist yet; run task dev or task dev:prepare`);
  console.log(`# ${file}${existsSync(overridesFile) ? ` (includes overrides from ${overridesFile})` : ''}`);
  for (const [name, value] of Object.entries(readEnv(file))) {
    console.log(`${name}=${secretName.test(name) ? '********' : value}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stack:clone') { await stackClone(args); return; }
  if (command === 'toolchain:install') { if (args.length) throw new Error('Unexpected arguments'); await install(); return; }
  if (command === 'dev') { await devStart(args); return; }
  if (command === 'dev:stop') { devStop(args); return; }
  if (command === 'dev:urls') { devUrls(); return; }
  if (command === 'dev:env') { devEnv(args); return; }
  if (command === 'stack:up') { await stackUp(parseOptions(args)); return; }
  if (command === 'dev:prepare') { await devPrepare(parseOptions(args)); return; }
  if (command === 'stack:backup') { await stackBackup(parseOptions(args)); return; }
  if (command === 'stack:logs') {
    const options = parseOptions(args);
    const dir = stackDirectory(root, options);
    if (!existsSync(join(dir, 'compose.env'))) throw new Error(`${projectName(options)} has no saved stack`);
    console.log(compose(options, ['logs', '--no-color', '--tail', '80'], runtimeEnv()));
    return;
  }
  if (command === 'stack:status') {
    const options = parseOptions(args);
    const dir = stackDirectory(root, options);
    if (!existsSync(join(dir, 'compose.env'))) throw new Error(`${projectName(options)} has no saved stack`);
    console.log(compose(options, ['ps', '--all'], runtimeEnv()));
    return;
  }
  if (command === 'stack:down' || command === 'stack:reset') {
    const options = parseOptions(args);
    const dir = stackDirectory(root, options);
    if (!existsSync(join(dir, 'compose.env'))) { console.log(`${projectName(options)} has no saved stack`); return; }
    compose(options, command === 'stack:reset' ? ['down', '--volumes', '--remove-orphans'] : ['down'], runtimeEnv());
    if (command === 'stack:reset') {
      const apps = readEnv(join(dir, 'apps.env'));
      rmSync(apps.MAIN_OBJECT_DIRECTORY, { recursive: true, force: true });
      rmSync(apps.MAIN_CANDIDATE_DIRECTORY, { recursive: true, force: true });
      rmSync(join(dir, 'content-rebuild.json'), { force: true });
      rmSync(join(dir, 'recovery-backups'), { recursive: true, force: true });
      // Retaining the lineage prevents a routine restart from silently changing it.
      console.log(`Volumes removed. Configuration retained at ${dir}`);
    }
    return;
  }
  throw new Error(`Unknown root command: ${command ?? ''}`);
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
