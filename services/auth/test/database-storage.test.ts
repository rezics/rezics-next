import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { POSTGRES_IMAGE } from '../scripts/database.ts';

async function databaseCommands(): Promise<{ commands: string[][]; pid: number }> {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(join(root, 'auth-storage-'));
  const log = join(temporary, 'docker.jsonl');
  const shim = join(temporary, 'docker');
  writeFileSync(log, '');
  writeFileSync(
    shim,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'run') console.log('postgres-container');
else if (!['ps', 'port', 'rm'].includes(args[0])) process.exit(74);
`,
  );
  chmodSync(shim, 0o755);
  const commands = (): string[][] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    const module = resolve(import.meta.dir, '../scripts/database.ts');
    const child = Bun.spawn(
      [process.execPath, '-e', `import { ownDatabase } from ${JSON.stringify(module)}; ownDatabase();`],
      { env: { ...process.env, PATH: `${temporary}:${process.env.PATH ?? ''}` }, stderr: 'pipe', stdout: 'ignore' },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain('Cannot determine Auth test database port');
    // Port discovery fails deliberately, exercising removal without starting PostgreSQL or running migrations.
    const deadline = Date.now() + 2_000;
    while (!commands().some((args) => args[0] === 'rm') && Date.now() < deadline) await Bun.sleep(10);
    return { commands: commands(), pid: child.pid };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('the auth check database keeps its data on a disk-backed volume, not a memory-capped tmpfs', async () => {
  const { commands, pid } = await databaseCommands();
  const run = commands.find((args) => args[0] === 'run')!;
  expect(run[run.indexOf('--mount') + 1]).toBe(
    `type=volume,destination=/var/lib/postgresql,volume-label=rezics.auth.check.pid=${pid}`,
  );
  expect(run).not.toContain('--tmpfs');
  expect(run).toContain(`rezics.auth.check.pid=${pid}`);
  expect(run).toContain('--rm');
  expect(run.slice(run.indexOf(POSTGRES_IMAGE))).toEqual([
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'max_wal_size=256MB',
    '-c',
    'max_connections=500',
  ]);
});

test('removing an auth check database container removes its volume', async () => {
  const { commands } = await databaseCommands();
  expect(commands.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'postgres-container']]);
});
