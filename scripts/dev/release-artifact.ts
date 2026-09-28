import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { parseOptions, type StackOptions } from './config.ts';
import { installRelease } from './install.ts';
import { assertReleasePins, releaseDigest, releaseManifest } from './release-manifest.ts';

const root = resolve(import.meta.dir, '../..');
const releaseHome = join(root, '.temp/releases');
const migrationDirectories = ['services/main/migrations/access',
  'services/main/migrations/relay', 'services/content/migrations'] as const;
const inputs = ['infra/dev/compose.yaml', 'infra/dev/compose.qa.yaml', 'package.json',
  '.yarnrc.yml', 'yarn.lock',
  // Main imports this adapter even when local fixture fetching is disabled.
  'scripts/dev/seed/open-library-fixtures.ts'] as const;

interface ArtifactManifest {
  schema: 'rezics-release-artifact-v1';
  releaseDigest: string;
  formatVersion: number;
  platform: string;
  arch: string;
  imageIds: Record<string, string>;
  files: Record<string, string>;
}

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(program: string, args: string[], timeout = 120_000,
  env: NodeJS.ProcessEnv = process.env, cwd = root): string {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-1500)}`);
  }
  return result.stdout.trim();
}

function filesUnder(base: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(base, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(base, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Release artifact contains non-file entry: ${path}`);
  }
  return result.sort();
}

function imageIds(): Record<string, string> {
  return Object.fromEntries(Object.entries(releaseManifest.images).map(([name, image]) => {
    const id = run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], 10_000);
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid ${name} image identity`);
    return [name, id];
  }));
}

function copyInput(stage: string, path: string): void {
  const destination = join(stage, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, path), destination);
}

function seal(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) seal(path);
    else chmodSync(path, statSync(path).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(directory, 0o555);
}

/** Build once per byte-identical payload. Digest and per-file checks make a
 * local release immutable by identity even if someone changes its permissions. */
export function buildReleaseArtifact(): string {
  assertReleasePins();
  mkdirSync(releaseHome, { recursive: true });
  const stage = join(releaseHome, `.stage-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const path of inputs) copyInput(stage, path);
    for (const directory of migrationDirectories) {
      for (const name of readdirSync(join(root, directory)).filter(name => name.endsWith('.sql')).sort()) {
        copyInput(stage, join(directory, name));
      }
    }
    for (const directory of ['services', 'packages', 'generated', 'node_modules']) {
      cpSync(join(root, directory), join(stage, directory), { recursive: true,
        dereference: true, filter: path => !path.includes('/node_modules/.cache/') });
    }
    mkdirSync(join(stage, 'bin'), { recursive: true });
    copyFileSync(process.execPath, join(stage, 'bin/bun'));
    chmodSync(join(stage, 'bin/bun'), 0o755);
    const files = Object.fromEntries(filesUnder(stage).map(path =>
      [path, sha(readFileSync(join(stage, path)))]));
    const manifest: ArtifactManifest = { schema: 'rezics-release-artifact-v1',
      releaseDigest: releaseDigest(), formatVersion: releaseManifest.formatVersion,
      platform: process.platform, arch: process.arch, imageIds: imageIds(), files };
    const digest = sha(JSON.stringify(manifest));
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const destination = join(releaseHome, digest);
    if (existsSync(destination)) {
      verifyReleaseArtifact(destination);
      rmSync(stage, { recursive: true, force: true });
      return destination;
    }
    seal(stage);
    renameSync(stage, destination);
    verifyReleaseArtifact(destination);
    return destination;
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function verifyReleaseArtifact(path: string): { digest: string; manifest: ArtifactManifest } {
  const directory = resolve(path);
  if (!isAbsolute(path) || relative(releaseHome, directory).startsWith('..')) {
    throw new Error('Release artifact must be an absolute path under .temp/releases');
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ArtifactManifest;
  const digest = sha(JSON.stringify(manifest));
  if (manifest.schema !== 'rezics-release-artifact-v1' || directory !== join(releaseHome, digest)
    || manifest.releaseDigest !== releaseDigest()
    || manifest.formatVersion !== releaseManifest.formatVersion
    || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('Release artifact identity or platform differs');
  }
  const actual = filesUnder(directory).filter(file => file !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) {
    throw new Error('Release artifact file set differs from manifest');
  }
  for (const file of actual) {
    if (sha(readFileSync(join(directory, file))) !== manifest.files[file]) {
      throw new Error(`Release artifact file digest differs: ${file}`);
    }
  }
  for (const path of inputs) {
    if (manifest.files[path] !== sha(readFileSync(join(root, path)))) {
      throw new Error(`Release artifact input differs from checkout: ${path}`);
    }
  }
  const current = imageIds();
  if (JSON.stringify(current) !== JSON.stringify(manifest.imageIds)) {
    throw new Error('Release artifact image identities differ');
  }
  return { digest, manifest };
}

async function migrateTracked(url: string, artifact: string, directory: string): Promise<string[]> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const applied: string[] = [];
  try {
    for (const file of readdirSync(join(artifact, directory)).filter(name => name.endsWith('.sql')).sort()) {
      const key = `${directory}/${file}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
          name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = await client.query('SELECT 1 FROM public.rezics_local_migration WHERE name = $1', [key]);
        if (!done.rowCount) {
          await client.query(readFileSync(join(artifact, key), 'utf8'));
          await client.query('INSERT INTO public.rezics_local_migration (name) VALUES ($1)', [key]);
          applied.push(key);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  } finally { await pool.end(); }
  return applied;
}

async function migrateContentFromArtifact(url: string, artifact: string): Promise<string[]> {
  const directory = join(artifact, 'services/content/migrations');
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-content-schema', 0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS content');
    await client.query(`CREATE TABLE IF NOT EXISTS content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const history = (await client.query<{ version: number }>(
      'SELECT version FROM content.schema_migration ORDER BY version')).rows.map(row => row.version);
    const versions = files.map(file => Number(file.slice(0, 3)));
    if (files.some(file => !/^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      || versions.some((version, index) => version <= (versions[index - 1] ?? 0))
      || history.some((version, index) => version !== versions[index])) {
      throw new Error('Content artifact migration history differs');
    }
    for (const file of files.slice(history.length)) {
      const version = Number(file.slice(0, 3));
      await client.query(readFileSync(join(directory, file), 'utf8'));
      await client.query('INSERT INTO content.schema_migration(version) VALUES ($1)', [version]);
      applied.push(`content:${version}`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
  return applied;
}

async function migrateArtifactOwners(apps: Record<string, string>, artifact: string): Promise<string[]> {
  const applied = [
    ...await migrateTracked(apps.ACCESS_DATABASE_URL!, artifact, 'services/main/migrations/access'),
    ...await migrateTracked(apps.ACCOUNT_RELAY_DATABASE_URL!, artifact, 'services/main/migrations/relay'),
    ...await migrateContentFromArtifact(apps.CONTENT_DATABASE_URL!, artifact),
  ];
  run(join(artifact, 'bin/bun'), ['services/account/src/migrate.ts'], 120_000,
    { ...process.env, ...apps }, artifact);
  return applied;
}

export async function installReleaseArtifact(artifact: string, options: StackOptions) {
  assertReleasePins();
  const { digest } = verifyReleaseArtifact(artifact);
  return installRelease(options, { digest,
    migrate: apps => migrateArtifactOwners(apps, artifact) });
}

if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'build') console.log(buildReleaseArtifact());
  else if (action === 'install') {
    const index = args.indexOf('--artifact');
    const artifact = args[index + 1];
    if (index < 0 || !artifact) throw new Error('release:install requires --artifact <absolute release directory>');
    const options = parseOptions([...args.slice(0, index), ...args.slice(index + 2)]);
    console.log(JSON.stringify(await installReleaseArtifact(artifact, options), null, 2));
  } else throw new Error('Expected build or install');
}
