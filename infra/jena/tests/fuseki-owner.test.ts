import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../fuseki-owner.sh');
const bases: string[] = [];
const running: ChildProcess[] = [];

function state(): { base: string; dir: string } {
  const base = mkdtempSync(join(tmpdir(), 'fuseki-owner-'));
  bases.push(base);
  return { base, dir: join(base, 'databases/rezics') };
}

/** Starts the entrypoint with a stand-in JVM that records its start and honours SIGTERM. */
async function start(base: string, child = 'touch "$FUSEKI_BASE/child-started"; exec sleep 30'): Promise<ChildProcess> {
  const owner = spawn('sh', [script, 'sh', '-c', child], { env: { ...process.env, FUSEKI_BASE: base },
    detached: true, stdio: 'ignore' });
  running.push(owner);
  for (let i = 0; i < 100 && !existsSync(join(base, 'child-started')); i++) await Bun.sleep(20);
  expect(existsSync(join(base, 'child-started'))).toBe(true);
  rmSync(join(base, 'child-started'));
  return owner;
}

function exit(owner: ChildProcess): Promise<number | null> {
  return owner.exitCode !== null ? Promise.resolve(owner.exitCode)
    : new Promise(done => owner.once('exit', code => done(code)));
}

afterEach(() => {
  for (const owner of running.splice(0)) {
    try { process.kill(-owner.pid!, 'SIGKILL'); } catch { /* already exited */ }
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('OPS13: a second owner on the same state directory exits 75 without touching it', async () => {
  const { base, dir } = state();
  const first = await start(base);
  writeFileSync(join(dir, 'tdb2', 'Data-0001'), 'x');
  const second = spawnSync('sh', [script, 'sh', '-c', 'touch "$FUSEKI_BASE/second-ran"'],
    { env: { ...process.env, FUSEKI_BASE: base }, encoding: 'utf8', timeout: 10_000 });
  expect(second.status).toBe(75);
  expect(second.stderr).toContain('another process owns');
  expect(existsSync(join(base, 'second-ran'))).toBe(false);
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(false);
  expect(first.exitCode).toBeNull();
  process.kill(first.pid!, 'SIGTERM');
  expect(await exit(first)).toBe(143);
});

test('OPS15: only an orderly SIGTERM exit leaves a clean stop; a killed owner makes text uncertain', async () => {
  const { base, dir } = state();
  // A fresh empty state has nothing to doubt.
  let owner = await start(base);
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(false);
  writeFileSync(join(dir, 'lucene', 'segments_1'), 'x');
  process.kill(owner.pid!, 'SIGTERM');
  expect(await exit(owner)).toBe(143);
  expect(existsSync(join(dir, 'clean-stop'))).toBe(true);

  owner = await start(base);
  expect(existsSync(join(dir, 'clean-stop'))).toBe(false);
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(false);
  process.kill(-owner.pid!, 'SIGKILL');
  await exit(owner);
  expect(existsSync(join(dir, 'clean-stop'))).toBe(false);

  owner = await start(base);
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(true);
  // A later orderly restart keeps the doubt until an empty-index rebuild clears it.
  process.kill(owner.pid!, 'SIGTERM');
  expect(await exit(owner)).toBe(143);
  owner = await start(base);
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(true);
  process.kill(owner.pid!, 'SIGTERM');
  expect(await exit(owner)).toBe(143);
});

test('OPS15: a JVM that fails its own shutdown leaves no clean stop', async () => {
  const { base, dir } = state();
  mkdirSync(join(dir, 'tdb2'), { recursive: true });
  writeFileSync(join(dir, 'tdb2', 'Data-0001'), 'x');
  writeFileSync(join(dir, 'clean-stop'), '');
  const owner = await start(base, 'trap "exit 1" TERM; touch "$FUSEKI_BASE/child-started"; sleep 30 & wait');
  expect(existsSync(join(dir, 'lucene.uncertain'))).toBe(false);
  process.kill(owner.pid!, 'SIGTERM');
  expect(await exit(owner)).toBe(1);
  expect(existsSync(join(dir, 'clean-stop'))).toBe(false);
});
