import { expect, test } from 'bun:test';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { temporaryDirectory, repository } from './test-support.ts';

const cli = join(import.meta.dir, 'cli.ts');
const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');

// Unix socket paths must fit sockaddr_un; use a short relative path under the repository's .temp.
function shortDirectory(absolute: string): string { return relative(process.cwd(), absolute); }

test('goal inbox wait blocks in a separate process and exits promptly on another process delivery', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, GOAL_RUNTIME: runtime, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path };
  const child = Bun.spawn([process.execPath, cli, 'inbox', 'wait', 'manager'], { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    let exited = false; const exit = child.exited.then(code => { exited = true; return code; });
    await new Promise(resolve => setTimeout(resolve, 80)); expect(exited).toBe(false);
    const before = Date.now(); inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Choose a direction' });
    expect(await exit).toBe(0); expect(Date.now() - before).toBeLessThan(1000);
    expect(JSON.parse(await new Response(child.stdout).text())[0].event.summary).toBe('Choose a direction');
    const ack = Bun.spawn([process.execPath, cli, 'inbox', 'ack', 'manager'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await ack.exited).toBe(0); expect(inbox.read('manager')).toHaveLength(0);
  } finally { child.kill(); db.close(); t.close(); }
});

test('registered CLI commands enqueue, train and start and stop a manager through a durable host', async () => {
  const repo = repository();
  const stateAbsolute = join(repo.path, 'state'); mkdirSync(stateAbsolute);
  const state = shortDirectory(stateAbsolute);
  const env = { ...process.env, GOAL_RUNTIME: runtime, FAKE_GOAL_STATE: state, FAKE_GOAL_MAIN: repo.main };
  const host = spawn(process.execPath, [cli, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostError = ''; host.stderr.on('data', chunk => { hostError += chunk.toString(); });
  const exited = new Promise<void>(resolve => host.once('exit', () => resolve()));
  const ready = new Promise<void>((resolveReady, reject) => {
    createInterface({ input: host.stdout }).once('line', line => line === 'ready' ? resolveReady() : reject(new Error(line)));
    host.once('exit', () => reject(new Error(hostError || 'Host exited before ready')));
  });
  const command = async (...argv: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...argv], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(''); return { code, stdout };
  };
  try {
    await ready;
    repo.branch('alpha', 'a'); repo.branch('beta', 'b');
    expect((await command('land', 'alpha')).code).toBe(0); expect((await command('land', 'beta')).code).toBe(0);
    expect((await command('train')).code).toBe(0);
    const start = await command('manager', 'start', 'manager', '--engine', 'codex', '--budget', '20000');
    expect(start.code).toBe(0); expect(JSON.parse(start.stdout).threadId).toBe('thread-1');
    expect((await command('manager', 'stop', 'manager')).code).toBe(0);
  } finally { host.kill('SIGTERM'); await exited; repo.close(); }
}, 10_000);

test('manager start creates its host and returns while the host stays alive', async () => {
  const t = temporaryDirectory();
  const state = shortDirectory(t.path);
  const env = { ...process.env, GOAL_RUNTIME: runtime, FAKE_GOAL_STATE: state, FAKE_GOAL_MAIN: t.path };
  const child = Bun.spawn([process.execPath, cli, 'manager', 'start', 'manager', '--engine', 'codex', '--budget', '20000'],
    { env, stdout: 'pipe', stderr: 'pipe' });
  let hostPid: number | undefined;
  try {
    const code = await child.exited;
    const error = await new Response(child.stderr).text(); expect(error).toBe(''); expect(code).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text()).status).toBe('running');
    const { readdirSync, readFileSync, watch } = await import('node:fs');
    const leasePath = join(t.path, 'manager.sock.lease');
    hostPid = JSON.parse(readFileSync(join(leasePath, readdirSync(leasePath)[0]!), 'utf8')).pid;
    process.kill(hostPid!, 0);
    // Observe lease removal instead of polling for daemon shutdown.
    const released = new Promise<void>(resolveReleased => {
      const watcher = watch(t.path, (_, name) => {
        if (name === 'manager.sock.lease') { watcher.close(); resolveReleased(); }
      });
    });
    process.kill(hostPid!, 'SIGTERM'); await released; hostPid = undefined;
  } finally { if (hostPid) process.kill(hostPid, 'SIGTERM'); child.kill(); t.close(); }
}, 10_000);
