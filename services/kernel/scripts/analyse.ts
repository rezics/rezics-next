import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, startPostgresContainer } from './check.ts';
import { migrate } from './database.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIRECTORY = resolve(directory, 'dist/reylo');

type Outcome = { status: number | null; output: string };

function capture(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => done({ status, output }));
  });
}

/** The environment of a process that reads Reylo's analyses from `project` and has no database URL of its own. */
function projectEnvironment(project: string): NodeJS.ProcessEnv {
  const { DATABASE_URL: _database, ...rest } = process.env;
  return { ...rest, REYLO_CONFIG: project };
}

function writeProject(target: string, url: string): string {
  mkdirSync(target, { recursive: true });
  const file = resolve(target, '.reylo.yaml');
  writeFileSync(file, `direct_url: ${JSON.stringify(url)}\n`);
  return file;
}

/**
 * Analyses every `.sql` statement under `src` against the database at `databaseUrl` into `target`, then leaves a project
 * file there with no database URL, so a process that reads it never connects. Returns the number of statements analysed.
 */
export async function analyseStatements(databaseUrl: string, target: string): Promise<number> {
  const root = resolve(target);
  const project = writeProject(root, databaseUrl);
  const reylo = resolve(directory, 'node_modules/reylo/src/cli.js');
  const outcome = await capture(process.execPath, [reylo, 'generate', 'src'], projectEnvironment(project));
  if (outcome.status !== 0) throw new Error(`reylo generate failed:\n${outcome.output}`);
  writeProject(root, '');
  // The summary line reads "N queries typed", or "1 query typed".
  const typed = outcome.output.match(/(\d+) quer(?:y|ies) typed/);
  if (!typed) throw new Error(`reylo generate typed no statement:\n${outcome.output}`);
  return Number(typed[1]);
}

// Runs in a child process in this workspace, so bunfig.toml preloads Reylo and every .sql import compiles as at boot.
const IMPORT_EVERY_STATEMENT = `
const files = Array.from(new Bun.Glob('src/**/*.sql').scanSync({ cwd: process.cwd() })).sort();
const failed = [];
for (const file of files) {
  try {
    await import(process.cwd() + '/' + file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failed.push(file + ': ' + message.split('\\n')[0]);
  }
}
if (failed.length) {
  console.error('Statements without an analysis in the release:\\n' + failed.join('\\n'));
  process.exit(1);
}
console.log(files.length + ' statements served from the release analysis');
`;

/** Imports every `.sql` file under `src` with no database URL and Reylo reading `target`; fails naming each file it cannot serve. */
export async function releaseCheck(target: string): Promise<void> {
  const project = resolve(target, '.reylo.yaml');
  const outcome = await capture(process.execPath, ['-e', IMPORT_EVERY_STATEMENT], projectEnvironment(project));
  if (outcome.status !== 0) throw new Error(`Release check failed:\n${outcome.output}`);
  process.stdout.write(outcome.output);
}

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? DEFAULT_DIRECTORY);
  const started = performance.now();
  const container = startPostgresContainer();
  try {
    const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Could not determine the analysis database port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrate(url);
    rmSync(target, { recursive: true, force: true });
    const statements = await analyseStatements(url, target);
    await releaseCheck(target);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`Analysed ${statements} statements into ${target} in ${seconds} s`);
  } finally {
    docker(['rm', '-f', '-v', container]);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
