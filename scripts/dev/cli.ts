import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph, GRAPHS, DATASET, RV } from '../../services/main/src/modules/work/activate.ts';
import { appEnvironment, assertSavedStackRawUpdate, assertSavedStackStorage,
  composeProcessEnvironment, devPorts, ensureSecrets, parseOptions, projectName,
  readEnv, replacePrivate, savePrivate, stackDirectory, type StackOptions } from './config.ts';
import { bootstrapWebAuth } from './web-auth-bootstrap.ts';
import { compatibleLoadStorage, loadCompatibility,
  type LoadCompatibility } from '../load/compatibility.ts';
import { fusekiImageFromCompose } from '../load/image.ts';

const root = resolve(import.meta.dir, '../..');
const composeFile = join(root, 'infra/dev/compose.yaml');
const qaComposeFile = join(root, 'infra/dev/compose.qa.yaml');
const qaRawUpdateComposeFile = join(root, 'infra/dev/compose.qa-raw-update.yaml');
const childProcesses: ChildProcess[] = [];

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
    const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}`, 'podman/podman.sock');
    if (!existsSync(socket)) {
      try { run('systemctl', ['--user', 'start', 'podman.socket']); } catch { /* diagnostic below */ }
    }
    const env = { ...process.env, DOCKER_HOST: `unix://${socket}` };
    try {
      run('docker', ['info', '--format', '{{.ServerVersion}}'], env);
      return env;
    } catch {
      throw new Error('No Docker-compatible daemon is available. Start Docker, or enable the Podman user socket with `systemctl --user start podman.socket`, then retry.');
    }
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
  if (options.profile === 'qa' && !existsSync(join(dir, 'compose.env'))) {
    const selected = new Set<number>();
    for (const name of portNames) {
      let port: number;
      do { port = await availablePort(); } while (selected.has(port));
      selected.add(port);
      ports[name] = port;
    }
  }
  const composeEnv = ensureSecrets(root, options, ports);
  const appFile = join(dir, 'apps.env');
  if (!existsSync(appFile)) savePrivate(appFile, appEnvironment(composeEnv, dir));
  else {
    const existing = readEnv(appFile);
    if (existing.FUSEKI_MAINTENANCE_TOKEN !== composeEnv.FUSEKI_MAINTENANCE_TOKEN
      || existing.FUSEKI_COMMAND_TOKEN !== composeEnv.FUSEKI_COMMAND_TOKEN) {
      replacePrivate(appFile, { ...existing,
        FUSEKI_MAINTENANCE_TOKEN: composeEnv.FUSEKI_MAINTENANCE_TOKEN,
        FUSEKI_COMMAND_TOKEN: composeEnv.FUSEKI_COMMAND_TOKEN });
    }
  }
  const apps = readEnv(appFile);
  mkdirSync(apps.MAIN_OBJECT_DIRECTORY, { recursive: true, mode: 0o700 });
  mkdirSync(apps.MAIN_CANDIDATE_DIRECTORY, { recursive: true, mode: 0o700 });
  return { composeEnv, apps, dir };
}

function printEndpoints(options: StackOptions, env: Record<string, string>, dir: string): void {
  console.log(`${projectName(options)} ready`);
  console.log(`  Main:    http://127.0.0.1:${env.MAIN_PORT}/health/ready (after yarn dev)`);
  console.log(`  Account: http://127.0.0.1:${env.ACCOUNT_PORT}/health/ready (after yarn dev)`);
  console.log(`  Fuseki:  http://127.0.0.1:${env.FUSEKI_PORT}/rezics/`);
  console.log(`  RustFS:  http://127.0.0.1:${env.RUSTFS_PORT}/`);
  console.log(`  Mailpit: http://127.0.0.1:${env.MAILPIT_HTTP_PORT}/`);
  console.log(`  Private configuration: ${dir}`);
}

async function stackUp(options: StackOptions): Promise<{ apps: Record<string, string>; dir: string }> {
  if (!existsSync(composeFile)) throw new Error(`Compose topology is missing: ${composeFile}`);
  if (options.profile === 'qa' && !options.persistent && !existsSync(qaComposeFile)) throw new Error(`QA Compose topology is missing: ${qaComposeFile}`);
  if (options.rawUpdate && !existsSync(qaRawUpdateComposeFile)) {
    throw new Error(`QA raw-update Compose topology is missing: ${qaRawUpdateComposeFile}`);
  }
  const env = runtimeEnv();
  const config = await stackConfig(options);
  compose(options, ['up', '-d', '--wait'], env);
  printEndpoints(options, config.composeEnv, config.dir);
  return config;
}

async function install(): Promise<void> {
  if (process.versions.bun !== '1.4.2') throw new Error('Bun 1.4.2 is required');
  if (run('node', ['--version']) !== 'v26.8.2') throw new Error('Node 26.8.2 is required');
  if (run('corepack', ['yarn', '--version']) !== '4.18.0') throw new Error('Yarn 4.18.0 is required');
  const env = runtimeEnv();
  if (!existsSync(composeFile)) throw new Error(`Compose topology is missing: ${composeFile}`);
  const options: StackOptions = { profile: 'dev' };
  await stackConfig(options);
  compose(options, ['pull', '--ignore-buildable'], env);
  compose(options, ['build', 'fuseki'], env);
  run('corepack', ['yarn', 'exec', 'playwright', 'install', 'chromium']);
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

async function waitHealth(url: string, name: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited before becoming ready (code ${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* service is starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

function launch(name: string, file: string, apps: Record<string, string>): ChildProcess {
  const child = spawn('bun', ['--watch', file], { cwd: root, env: { ...process.env, ...apps }, stdio: 'inherit' });
  childProcesses.push(child);
  child.on('exit', code => console.log(`${name} exited (${code})`));
  return child;
}

async function dev(options: StackOptions): Promise<void> {
  let stop: (() => void) | undefined;
  try {
    const { apps } = await stackUp(options);
    await migrateApps(apps);
    await initializeGraph(apps);
    let processEnv = { ...apps };
    if (options.profile === 'qa') {
      const authDir = join(stackDirectory(root, options), 'web-auth');
      const runtimePath = join(authDir, 'runtime.env');
      const publicPath = join(authDir, 'public.json');
      if (!existsSync(runtimePath) || !existsSync(publicPath)) {
        await bootstrapWebAuth({ runId: options.runId!, redirectUris: [
          'http://localhost:3000/auth/callback',
          'http://127.0.0.1:3003/auth/callback',
        ] });
      }
      const publicConfig = JSON.parse(readFileSync(publicPath, 'utf8')) as { clientId: string };
      processEnv = { ...readEnv(runtimePath), WEB_OAUTH_CLIENT_ID: publicConfig.clientId };
    }
    const account = launch('Account', 'services/account/src/index.ts', processEnv);
    await waitHealth(`http://127.0.0.1:${apps.ACCOUNT_PORT}/health/ready`, 'Account', account);
    const main = launch('Main', 'services/main/src/index.ts', processEnv);
    await waitHealth(`http://127.0.0.1:${apps.MAIN_PORT}/health/ready`, 'Main', main);
    if (existsSync(join(root, 'apps/web/package.json'))) {
      const web = spawn('corepack', ['yarn', 'workspace', '@rezics/web', 'dev'],
        { cwd: root, env: { ...process.env, ...processEnv }, stdio: 'inherit' });
      childProcesses.push(web);
    }
    console.log('Main and Account are ready');
    await new Promise<void>(resolveWait => {
      stop = resolveWait;
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally {
    if (stop) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    for (const child of childProcesses) child.kill('SIGTERM');
    if (options.profile === 'qa') {
      try { compose(options, ['down', '--volumes', '--remove-orphans'], runtimeEnv()); }
      catch (error) { console.error('Could not clean up isolated QA stack:', error); }
    }
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stack:clone') { await stackClone(args); return; }
  if (command === 'toolchain:install') { if (args.length) throw new Error('Unexpected arguments'); await install(); return; }
  if (command === 'dev') {
    const options = parseOptions(args);
    if (options.rawUpdate) throw new Error('--raw-update cannot run with yarn dev');
    await dev(options);
    return;
  }
  if (command === 'stack:up') { await stackUp(parseOptions(args)); return; }
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
  for (const child of childProcesses) child.kill('SIGTERM');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
