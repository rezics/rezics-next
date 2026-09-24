import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph, GRAPHS, DATASET, RV } from '../../services/main/src/modules/work/activate.ts';
import { appEnvironment, devPorts, ensureSecrets, parseOptions, projectName,
  readEnv, savePrivate, stackDirectory, type StackOptions } from './config.ts';

const root = resolve(import.meta.dir, '../..');
const composeFile = join(root, 'infra/dev/compose.yaml');
const qaComposeFile = join(root, 'infra/dev/compose.qa.yaml');
const childProcesses: ChildProcess[] = [];

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
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
    ...(options.profile === 'qa' ? ['-f', qaComposeFile] : []),
    '--project-name', projectName(options), ...command];
}

function compose(options: StackOptions, command: string[], env: NodeJS.ProcessEnv): string {
  const envFile = join(stackDirectory(root, options), 'compose.env');
  return run('docker', composeArgs(options, envFile, command), env);
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
  if (options.profile === 'qa' && !existsSync(qaComposeFile)) throw new Error(`QA Compose topology is missing: ${qaComposeFile}`);
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
  run('corepack', ['yarn', 'install', '--immutable']);
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
  const fuseki = new FusekiClient(apps.FUSEKI_URL);
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

async function dev(): Promise<void> {
  // P0.2 removes the per-request host validator. Until then, do not pretend the
  // root command can satisfy the clean-clone/no-host-path acceptance criterion.
  for (const name of ['REZICS_JENA_HOME', 'REZICS_JAVA_HOME']) {
    if (!process.env[name]) throw new Error(`${name} is required by Main's current validator. P0.2 removes this host dependency; yarn dev cannot yet meet clean-clone acceptance.`);
  }
  const { apps } = await stackUp({ profile: 'dev' });
  await migrateApps(apps);
  await initializeGraph(apps);
  const processEnv = { ...apps, REZICS_JENA_HOME: process.env.REZICS_JENA_HOME!,
    REZICS_JAVA_HOME: process.env.REZICS_JAVA_HOME!,
    REZICS_PYTHON: process.env.REZICS_PYTHON ?? 'python3' };
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
    const stop = () => { for (const child of childProcesses) child.kill('SIGTERM'); resolveWait(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'toolchain:install') { if (args.length) throw new Error('Unexpected arguments'); await install(); return; }
  if (command === 'dev') { if (args.length) throw new Error('Unexpected arguments'); await dev(); return; }
  if (command === 'stack:up') { await stackUp(parseOptions(args)); return; }
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
