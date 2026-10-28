import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerLocalContainerError } from '../../../scripts/stack-run.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108';
// src/events/effects.ts launches DBOS on this schema.
const DBOS_SCHEMA = 'dbos';
const container = 'rezics-kernel-dev';
const volume = 'rezics-kernel-dev';
const port = Number(process.env.KERNEL_DATABASE_PORT ?? '54329');

/** Refuse future or duplicate migration versions before they can be applied. */
export function validateMigrationVersions(migrationFiles: string[], now: Date): void {
  const latestAllowed = new Date(now.getTime() + 5 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const versions = new Map<string, string[]>();
  const futureFiles: string[] = [];

  for (const file of migrationFiles) {
    const name = file.split(/[\\/]/).at(-1) ?? file;
    const version = name.match(/^(\d+)_/)?.[1];
    if (!version) continue;

    const files = versions.get(version) ?? [];
    files.push(file);
    versions.set(version, files);

    if (/^\d{14}$/.test(version) && version > latestAllowed) futureFiles.push(file);
  }

  const problems = [
    ...futureFiles.map((file) => `${file}: migration version is later than the current UTC time plus five minutes`),
    ...Array.from(versions)
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `version ${version} is used by ${files.join(', ')}`),
  ];
  if (problems.length) {
    throw new Error(
      `Migration version check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n` +
        'Name migrations with `date -u +%Y%m%d%H%M%S`.',
    );
  }
}

function command(
  program: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? directory,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function databaseUrl(databasePort: number): string {
  return `postgres://rezics:rezics@127.0.0.1:${databasePort}/rezics?sslmode=disable`;
}

/** Keep these secrets stable across restarts; a new route key would orphan receipts of retried creates. */
export function developmentEnv(existing: string, url: string): string {
  const lines = existing.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let hasDatabaseUrl = false;
  let hasRouteKey = false;
  let hasSessionKeys = false;
  let hasRatingCounterSecret = false;
  const updated = lines.map((line) => {
    if (line.startsWith('DATABASE_URL=')) {
      hasDatabaseUrl = true;
      return `DATABASE_URL=${url}`;
    }
    if (line.startsWith('KERNEL_ROUTE_KEY=')) hasRouteKey = true;
    if (line.startsWith('KERNEL_SESSION_KEYS=')) hasSessionKeys = true;
    if (line.startsWith('KERNEL_RATING_COUNTER_SECRET=')) hasRatingCounterSecret = true;
    return line;
  });
  if (!hasDatabaseUrl) updated.push(`DATABASE_URL=${url}`);
  if (!hasRouteKey) updated.push(`KERNEL_ROUTE_KEY=${randomBytes(32).toString('base64url')}`);
  if (!hasSessionKeys) updated.push(`KERNEL_SESSION_KEYS=1:${randomBytes(32).toString('base64url')}`);
  if (!hasRatingCounterSecret) updated.push(`KERNEL_RATING_COUNTER_SECRET=${randomBytes(32).toString('base64url')}`);
  return `${updated.join('\n')}\n`;
}

function modules(root: string): string[] {
  const db = resolve(root, 'db');
  return readdirSync(db, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const migrations = resolve(db, entry.name, 'migrations');
      try {
        return statSync(migrations).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => {
      if (!/^[a-z][a-z0-9_]*$/.test(entry.name) || entry.name === 'migrations') {
        throw new Error(`Invalid database module name: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
}

export function moduleExtensionFiles(root = directory): string[] {
  return modules(root).flatMap((name) => {
    const relativeDirectory = `db/${name}/migrations`;
    return readdirSync(resolve(root, relativeDirectory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .filter((entry) =>
        /\bcreate\s+extension\b/i.test(
          readFileSync(resolve(root, relativeDirectory, entry.name), 'utf8').replace(/--[^\r\n]*/g, ''),
        ),
      )
      .map((entry) => `${relativeDirectory}/${entry.name}`);
  });
}

export function migrate(url: string, root = directory): void {
  const migrationDirectories = ['db/migrations', ...modules(root).map((name) => `db/${name}/migrations`)];
  command(
    resolve(directory, 'node_modules/.bin/dbmate'),
    [
      '--url',
      url,
      ...migrationDirectories.flatMap((path) => ['--migrations-dir', path]),
      '--no-dump-schema',
      '--migration-lock',
      '--wait',
      'up',
    ],
    { cwd: root },
  );
  command(process.execPath, [resolve(directory, 'node_modules/.bin/dbos'), 'schema', url, '--schema', DBOS_SCHEMA], {
    cwd: root,
  });
}

function schemaDumpWith(url: string, options: string[] = [], root = directory): string {
  const container = process.env.KERNEL_DATABASE_CONTAINER;
  const dumpArgs = ['pg_dump', '--schema-only', '--no-owner', '--no-privileges', ...options];
  const database = new URL(url);
  database.hostname = '127.0.0.1';
  database.port = '5432';
  const dump = container
    ? command('docker', ['exec', '-e', 'PGPASSWORD=rezics', container, ...dumpArgs, database.href], { cwd: root })
    : command(
        'docker',
        ['run', '--rm', '--network', 'host', '-e', 'PGPASSWORD=rezics', POSTGRES_IMAGE, ...dumpArgs, url],
        { cwd: root },
      );
  return dump
    .split('\n')
    .filter((line) => !/^\\(?:un)?restrict\b/.test(line) && !/^-- Dumped (?:from|by)\b/.test(line))
    .join('\n');
}

export function schemaDumps(url: string, root = directory): Record<string, string> {
  const moduleNames = modules(root);
  const dumps: Record<string, string> = {};
  dumps['db/schema.sql'] = schemaDumpWith(
    url,
    [...moduleNames, DBOS_SCHEMA].map((name) => `--exclude-schema=${name}`),
    root,
  );
  for (const name of moduleNames) {
    dumps[`db/${name}/schema.sql`] = schemaDumpWith(url, [`--schema=${name}`], root);
  }
  return dumps;
}

export function schemaDump(url: string, root = directory): string {
  return schemaDumpWith(
    url,
    [...modules(root), DBOS_SCHEMA].map((name) => `--exclude-schema=${name}`),
    root,
  );
}

function docker(args: string[]): string {
  return command('docker', args);
}

async function up(): Promise<void> {
  const refusal = await workerLocalContainerError(process.env, process.cwd());
  if (refusal) throw new Error(refusal);
  const existing = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
  if (existing) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', container]).trim();
    if (running !== 'true') docker(['start', container]);
  } else {
    docker(['volume', 'create', volume]);
    docker([
      'run',
      '-d',
      '--name',
      container,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-v',
      `${volume}:/var/lib/postgresql`,
      '-e',
      'POSTGRES_USER=rezics',
      '-e',
      'POSTGRES_PASSWORD=rezics',
      '-e',
      'POSTGRES_DB=rezics',
      POSTGRES_IMAGE,
    ]);
  }
  const url = databaseUrl(port);
  migrate(url);
  const envFile = resolve(directory, '.env');
  const existingEnv = (await Bun.file(envFile).exists()) ? await Bun.file(envFile).text() : '';
  await Bun.write(envFile, developmentEnv(existingEnv, url));
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'up';
  if (action === 'up') await up();
  else if (action === 'down') {
    const found = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
    if (found) docker(['stop', container]);
  } else if (action === 'reset') {
    const found = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
    if (found) docker(['rm', '-f', '-v', container]);
    try {
      docker(['volume', 'rm', volume]);
    } catch {
      // A missing volume is already reset.
    }
    await up();
  } else if (action === 'dump') {
    const url = databaseUrl(port);
    process.env.KERNEL_DATABASE_CONTAINER ??= container;
    for (const [path, dump] of Object.entries(schemaDumps(url))) {
      await Bun.write(resolve(directory, path), dump);
    }
  } else throw new Error(`Unknown database action: ${action}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
