import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNativeAuthPageApp } from './native/auth-page-app.ts';
import {
  NativeTestLifecycle,
  inspectNativeProcess,
  nativeProcessGroupIsGone,
  type NativeProcessIdentity,
} from './native/lifecycle.ts';

type Generation = { pid: number; pgid: number; persistence: string; priorGroupGone: boolean };
type Event = Generation & { event: 'started' | 'stopped' };

async function groupExited(identity: NativeProcessIdentity): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (!nativeProcessGroupIsGone(identity) && Date.now() < deadline) await Bun.sleep(10);
  return nativeProcessGroupIsGone(identity);
}

const program = `
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const eventsPath = process.env.AUTH_PAGE_APP_EVENTS;
const previous = readFileSync(eventsPath, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
const first = previous.length === 0;
if (first && process.env.AUTH_PAGE_APP_HOLD_STOP === '1') {
  // The dev command can lose an intermediate parent before group shutdown.
  // Its orphan stays in the group and must be reaped before the next generation.
  const fork = Bun.spawnSync(['python3', '-c', 'import os, signal\\nif os.fork() == 0: signal.pause()'], {
    stdout: 'ignore', stderr: 'ignore',
  });
  if (fork.exitCode !== 0) throw new Error('Could not create orphaned Auth child');
}
const persistence = await mkdtemp(join(tmpdir(), 'rezics-auth-worker-resource-test-'));
await mkdir(join(persistence, 'state'));
const stat = readFileSync('/proc/self/stat', 'utf8');
const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
let priorGroupGone = true;
const prior = previous.findLast(event => event.event === 'started');
if (prior) {
  try { process.kill(-prior.pgid, 0); priorGroupGone = false; }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const generation = { pid: process.pid, pgid, persistence, priorGroupGone };
const event = name => appendFileSync(eventsPath, JSON.stringify({ event: name, ...generation }) + '\\n');
const startup = Promise.withResolvers();
const stopStarted = Promise.withResolvers();
const stopReleased = Promise.withResolvers();
if (process.env.AUTH_PAGE_APP_HOLD_STARTUP !== '1') startup.resolve();
if (process.env.AUTH_PAGE_APP_HOLD_STOP !== '1' || !first) stopReleased.resolve();
console.info('[worker-persistence] app=auth effective=' + join(persistence, 'state'));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/release-startup') startup.resolve();
    else if (path === '/release-stop') stopReleased.resolve();
    else if (path === '/stop-started') await stopStarted.promise;
    else if (path === '/login') await startup.promise;
    return Response.json(generation);
  },
});
event('started');
let stopping = false;
process.on('SIGTERM', async () => {
  if (stopping) return;
  stopping = true;
  stopStarted.resolve();
  await stopReleased.promise;
  await server.stop(true);
  await rm(persistence, { recursive: true, force: true });
  event('stopped');
  process.exit(0);
});
`;

async function fixture(hold: 'stop' | 'startup') {
  const temporary = resolve(import.meta.dir, '../../../.temp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, 'auth-page-app-test-'));
  const eventsPath = resolve(root, 'events.jsonl');
  await writeFile(eventsPath, '');
  await writeFile(resolve(root, 'fixture.ts'), program);
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ scripts: { dev: 'bun fixture.ts' } }));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const origin = reservation.url.origin;
  reservation.stop(true);
  const lifecycle = new NativeTestLifecycle('Auth page app process control');
  const app = createNativeAuthPageApp(lifecycle, root, origin, {
    ...process.env,
    AUTH_PAGE_APP_EVENTS: eventsPath,
    AUTH_PAGE_APP_HOLD_STOP: hold === 'stop' ? '1' : '0',
    AUTH_PAGE_APP_HOLD_STARTUP: hold === 'startup' ? '1' : '0',
  });
  const events = async (): Promise<Event[]> =>
    (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const control = async (path: string): Promise<Generation> => {
    const deadline = Date.now() + 5_000;
    let failure: unknown;
    while (Date.now() < deadline) {
      try {
        return (await (await fetch(origin + path, { signal: AbortSignal.timeout(1_000) })).json()) as Generation;
      } catch (error) {
        failure = error;
        await Bun.sleep(10);
      }
    }
    throw failure;
  };
  const close = async () => {
    await Promise.allSettled(
      ['/release-startup', '/release-stop'].map((path) => fetch(origin + path, { signal: AbortSignal.timeout(1_000) })),
    );
    try {
      await app.stop();
    } finally {
      try {
        await lifecycle.close();
      } finally {
        for (const event of await events()) {
          if (event.event === 'started') await rm(event.persistence, { recursive: true, force: true });
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  return { app, origin, events, control, close };
}

test('Auth UI process coalesces startup and replaces an eligible generation only after its group exits', async () => {
  const f = await fixture('stop');
  try {
    await Promise.all([f.app.ensure(), f.app.ensure()]);
    const first = f.app.process()!;
    expect(first).toBeDefined();
    expect((await f.events()).filter(({ event }) => event === 'started')).toHaveLength(1);
    const firstPage = await f.control('/login');
    expect(firstPage.pgid).toBe(first.pgid);
    await f.app.retire(() => false);
    expect(f.app.process()).toEqual(first);
    expect(existsSync(firstPage.persistence)).toBe(true);

    const stopStarted = f.control('/stop-started');
    const retirement = f.app.retire(() => true);
    await stopStarted;
    let ensured = false;
    const next = f.app.ensure().then(() => {
      ensured = true;
    });
    expect(f.app.process()).toBeUndefined();
    expect(ensured).toBe(false);
    await f.control('/release-stop');
    await Promise.all([retirement, next]);
    expect(nativeProcessGroupIsGone(first)).toBe(true);
    expect(existsSync(firstPage.persistence)).toBe(false);
    const second = f.app.process()!;
    expect(second.pgid).not.toBe(first.pgid);
    const secondPage = await f.control('/login');
    expect(secondPage.priorGroupGone).toBe(true);
    expect((await f.events()).map(({ event }) => event)).toEqual(['started', 'stopped', 'started']);
    await f.app.stop();
    expect(await groupExited(second)).toBe(true);
    expect(existsSync(secondPage.persistence)).toBe(false);
    await expect(f.app.ensure()).rejects.toThrow('closing');
  } finally {
    await f.close();
  }
}, 20_000);

test('Auth UI stop fences an opening generation and cleans its actual process and persistence', async () => {
  const f = await fixture('startup');
  try {
    const starting = f.app.ensure().then(
      () => undefined,
      (error) => error,
    );
    const generation = await f.control('/started');
    const openingGroup = inspectNativeProcess(generation.pgid)!;
    expect(openingGroup).toBeDefined();
    const stopped = f.app.stop();
    expect(await starting).toBeInstanceOf(Error);
    await stopped;
    expect(await groupExited(openingGroup)).toBe(true);
    expect(f.app.process()).toBeUndefined();
    expect(existsSync(generation.persistence)).toBe(false);
    expect((await f.events()).map(({ event }) => event)).toEqual(['started', 'stopped']);
    await expect(f.app.ensure()).rejects.toThrow('closing');
  } finally {
    await f.close();
  }
}, 20_000);
