import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createQaStackPool, destroyHeldQaStacks, qaStackFingerprint, qaStackPoolEnabled, qaStackPoolMaxParkedMs,
  trackHeldQaStackStartup, type QaStackPoolEntry, type QaStackPoolOptions,
} from './stack-pool.ts';
import { processAlive, processIdentity, type ProcessIdentity } from './process/identity.ts';
import { terminateProcessGroupSync } from './process/terminate.ts';

const temporary: string[] = [];
afterEach(() => {
  destroyHeldQaStacks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(slots = 2) {
  const base = resolve(import.meta.dir, '../../.temp/qa-stack-pool-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'pool-'));
  temporary.push(root);
  const slotDirectory = join(root, 'slots');
  const switchFile = join(root, 'qa-stack-pool');
  const state = join(root, 'qa-stack-pool-state');
  const destroyed: string[] = [];
  const live = new Set(['first', 'second']);
  const identity = (start: string): ProcessIdentity => ({ pid: 123, start, boot: 'boot', cgroup: '' });
  let time = 1_000;
  const options: QaStackPoolOptions = {
    root, slotDirectory, slots, holder: identity('first'), alive: holder => live.has(holder.start),
    now: () => time, janitor: false,
    destroy: async entry => { destroyed.push(entry.projectRunId); },
    destroySync: entry => { destroyed.push(entry.projectRunId); },
  };
  return {
    root, slotDirectory, switchFile, state, options, destroyed, live, identity,
    on() { writeFileSync(switchFile, 'on\n'); },
    advance(ms: number) { time += ms; },
    pool(overrides: Partial<QaStackPoolOptions> = {}) { return createQaStackPool({ ...options, ...overrides }); },
    saved(id: string) { return JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8')) as QaStackPoolEntry; },
  };
}

const apps = { POSTGRES_URL: 'postgres://qa', S3_BUCKET: 'qa', SMTP_HOST: 'localhost' };
const compose = { REZICS_S3_PASSWORD: 'secret', REZICS_FUSEKI_MEMORY_LIMIT: '7g' };

test('pool is off unless the host switch explicitly says on; no slots are a no-op', async () => {
  const f = fixture();
  expect(qaStackPoolEnabled(undefined)).toBe(false);
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(false);
  expect(await f.pool().register('first', 'ordinary')).toBeUndefined();
  expect(await f.pool().acquire('ordinary')).toBeUndefined();
  expect(existsSync(f.state)).toBe(false);
  writeFileSync(f.switchFile, 'true');
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(false);
  f.on();
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(true);
  const absent = f.pool({ slotDirectory: undefined });
  expect(await absent.register('first', 'ordinary')).toBeUndefined();
  expect(await absent.acquire('ordinary')).toBeUndefined();
  await absent.sweep();
});

test('a clean release has no holder and a matching lease carries independent endpoint snapshots and parked duration', async () => {
  const f = fixture();
  f.on();
  const original = await f.pool().register('origin-project', 'ordinary');
  expect(original?.entry.holder).toEqual(f.identity('first'));
  const appSnapshot = { ...apps };
  const composeSnapshot = { ...compose };
  expect(await original!.park(appSnapshot, composeSnapshot)).toBe(true);
  appSnapshot.POSTGRES_URL = 'changed';
  composeSnapshot.REZICS_S3_PASSWORD = 'changed';
  expect(f.saved('origin-project').holder).toBeUndefined();
  f.advance(2_345);
  const leased = await f.pool({ root: join(f.root, 'different-worktree'), holder: f.identity('second') }).acquire('ordinary');
  expect(leased?.parkedMs).toBe(2_345);
  expect(leased?.entry.projectRunId).toBe('origin-project');
  expect(leased?.entry.apps).toEqual(apps);
  expect(leased?.entry.compose).toEqual(compose);
  expect(leased?.entry.holder).toEqual(f.identity('second'));
  expect(f.saved('origin-project').parkedAt).toBeUndefined();
  expect(f.destroyed).toEqual([]);
});

test('pool capacity includes active holders and unowned parked stacks', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool().register('first', 'ordinary');
  const second = await f.pool().register('second', 'ordinary');
  await first!.park(apps, compose);
  expect(await f.pool().register('third', 'ordinary')).toBeUndefined();
  await second!.destroy();
  expect((await f.pool().register('third', 'ordinary'))?.entry.projectRunId).toBe('third');
  expect(readdirSync(f.state).filter(name => name.endsWith('.json'))).toHaveLength(2);
});

test('concurrent acquisitions give the parked stack to exactly one holder', async () => {
  const f = fixture(1);
  f.on();
  const original = await f.pool().register('original', 'ordinary');
  await original!.park(apps, compose);
  const results = await Promise.all([
    f.pool().acquire('ordinary'), f.pool({ holder: f.identity('second') }).acquire('ordinary'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(f.saved('original').holder?.start).toBe(results.find(Boolean)!.entry.holder?.start);
});

test('concurrent registrations cannot exceed the host slot count', async () => {
  const f = fixture(1);
  f.on();
  const results = await Promise.all([
    f.pool().register('first', 'ordinary'), f.pool().register('second', 'ordinary'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(readdirSync(f.state).filter(name => name.endsWith('.json'))).toHaveLength(1);
});

test('a dead holder is destroyed and never turned into a reusable stack', async () => {
  const f = fixture(1);
  f.on();
  await f.pool().register('crashed', 'ordinary');
  f.live.delete('first');
  const replacement = f.pool({ holder: f.identity('second') });
  expect(await replacement.acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['crashed']);
  expect((await replacement.register('fresh', 'ordinary'))?.entry.projectRunId).toBe('fresh');
});

test('a reused pid with a different start time does not own its old stack', async () => {
  const f = fixture();
  f.on();
  const identity = processIdentity(process.pid)!;
  await f.pool({ holder: { ...identity, start: `${identity.start}0` }, alive: undefined }).register('old-pid', 'ordinary');
  expect(await f.pool({ holder: identity, alive: undefined }).acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['old-pid']);
});

test('fingerprint mismatches destroy parked stacks while keeping live holders', async () => {
  const f = fixture();
  f.on();
  const parked = await f.pool().register('old-parked', 'old');
  await parked!.park(apps, compose);
  await f.pool().register('old-active', 'old');
  expect(await f.pool().acquire('new')).toBeUndefined();
  expect(f.destroyed).toEqual(['old-parked']);
  expect(existsSync(join(f.state, 'old-active.json'))).toBe(true);
});

test('parked stacks expire at fifteen minutes and a sweep frees their capacity', async () => {
  const f = fixture(1);
  f.on();
  const lease = await f.pool().register('old', 'ordinary');
  await lease!.park(apps, compose);
  f.advance(qaStackPoolMaxParkedMs - 1);
  await f.pool().sweep();
  expect(f.destroyed).toEqual([]);
  f.advance(1);
  await f.pool().sweep();
  expect(f.destroyed).toEqual(['old']);
  expect((await f.pool().register('fresh', 'ordinary'))?.entry.projectRunId).toBe('fresh');
});

test('switching off destroys parked stacks and destroys a holder on its clean release', async () => {
  const f = fixture();
  f.on();
  const parked = await f.pool().register('parked', 'ordinary');
  await parked!.park(apps, compose);
  const held = await f.pool().register('held', 'ordinary');
  writeFileSync(f.switchFile, 'off');
  expect(await f.pool().acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['parked']);
  expect(await held!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['parked', 'held']);
});

test('a former holder cannot release or destroy a newer lease', async () => {
  const f = fixture();
  f.on();
  const former = await f.pool().register('original', 'ordinary');
  await former!.park(apps, compose);
  const current = await f.pool({ holder: f.identity('second') }).acquire('ordinary');
  expect(await former!.park({ BAD: 'old data' }, {})).toBe(false);
  await former!.destroy();
  expect(f.saved('original').token).toBe(current!.entry.token);
  expect(f.saved('original').apps).toEqual(apps);
  expect(f.destroyed).toEqual([]);
  destroyHeldQaStacks();
  expect(f.destroyed).toEqual(['original']);
});

test('failed teardown preserves the ownership record and prevents reuse until retry succeeds', async () => {
  const f = fixture();
  f.on();
  const pool = f.pool({ destroy: async () => { throw new Error('Docker unavailable'); } });
  await pool.register('crashed', 'ordinary');
  f.live.delete('first');
  await expect(pool.acquire('ordinary')).rejects.toThrow('Docker unavailable');
  expect(existsSync(join(f.state, 'crashed.json'))).toBe(true);
  await f.pool().sweep();
  expect(f.destroyed).toEqual(['crashed']);
  expect(existsSync(join(f.state, 'crashed.json'))).toBe(false);
});

test('explicit failed-run destruction keeps its record when Docker fails', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool({ destroy: async () => { throw new Error('cannot remove'); } }).register('failed-run', 'ordinary');
  await expect(lease!.destroy()).rejects.toThrow('cannot remove');
  expect(f.saved('failed-run').holder).toEqual(f.identity('first'));
});

test('synchronous exit cleanup destroys held leases and leaves parked stacks alone', async () => {
  const f = fixture();
  f.on();
  const original = await f.pool().register('leased', 'ordinary');
  await original!.park(apps, compose);
  await f.pool({ holder: f.identity('second') }).acquire('ordinary');
  const parked = await f.pool().register('parked', 'ordinary');
  await parked!.park(apps, compose);
  destroyHeldQaStacks();
  expect(f.destroyed).toEqual(['leased']);
  expect(existsSync(join(f.state, 'leased.json'))).toBe(false);
  expect(f.saved('parked').holder).toBeUndefined();
});

test('synchronous cleanup failure remains registered for a later dead-holder sweep', async () => {
  const f = fixture();
  f.on();
  const messages: string[] = [];
  const originalError = console.error;
  console.error = value => { messages.push(String(value)); };
  try {
    await f.pool({ destroySync: () => { throw new Error('Docker stopped'); } }).register('held', 'ordinary');
    destroyHeldQaStacks();
    expect(messages.join('\n')).toContain('Docker stopped');
    expect(f.saved('held').holder).toEqual(f.identity('first'));
    f.live.delete('first');
    await f.pool().sweep();
    expect(f.destroyed).toEqual(['held']);
  } finally { console.error = originalError; }
});

test('malformed ownership data fails closed without deleting the record', async () => {
  const f = fixture();
  f.on();
  mkdirSync(f.state);
  writeFileSync(join(f.state, 'corrupt.json'), '{}');
  await expect(f.pool().acquire('ordinary')).rejects.toThrow('Invalid QA pool ownership record');
  expect(existsSync(join(f.state, 'corrupt.json'))).toBe(true);
});

test('infrastructure fingerprint is stable under ordering and changes with every infrastructure input', () => {
  const input = {
    files: [['infra/compose.yaml', 'compose'], ['migrations/0001.sql', 'migration']] as const,
    images: ['sha256:postgres', 'sha256:fuseki'], assembler: 'tdb2-assembler',
    environment: { MEMORY: '7g', HEAP: '1536m' },
  };
  const fingerprint = qaStackFingerprint(input);
  expect(qaStackFingerprint({ ...input, files: [...input.files].reverse(), images: [...input.images].reverse(),
    environment: { HEAP: '1536m', MEMORY: '7g' } })).toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, files: [['infra/compose.yaml', 'changed'], input.files[1]] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, files: [input.files[0], ['migrations/0001.sql', 'changed']] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, images: ['sha256:new'] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, assembler: 'changed' })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, environment: { ...input.environment, MEMORY: '8g' } })).not.toBe(fingerprint);
});

test('reducing the slot count trims parked stacks while preserving active holders', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool().register('first', 'ordinary');
  const second = await f.pool().register('second', 'ordinary');
  await first!.park(apps, compose);
  f.advance(1);
  await second!.park(apps, compose);
  await f.pool({ slots: 1 }).sweep();
  expect(f.destroyed).toEqual(['first']);
  expect(existsSync(join(f.state, 'second.json'))).toBe(true);
});

test('a holder releases excess capacity when the slot count falls during its run', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool({ slots: 1 }).register('first', 'ordinary');
  await f.pool().register('second', 'ordinary');
  await f.pool({ slots: 1 }).sweep();
  expect(f.destroyed).toEqual([]);
  expect(await first!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['first']);
});

function fakeDocker(root: string): NodeJS.ProcessEnv {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/commands"
case "$1:$2" in
  ps:*) kind=containers ;;
  volume:ls) kind=volumes ;;
  network:ls) kind=networks ;;
  rm:*) /bin/rm -f "$FAKE_DOCKER_STATE/containers"; exit 0 ;;
  volume:rm) /bin/rm -f "$FAKE_DOCKER_STATE/volumes"; exit 0 ;;
  network:rm) /bin/rm -f "$FAKE_DOCKER_STATE/networks"; exit 0 ;;
  *) exit 1 ;;
esac
if [ -f "$FAKE_DOCKER_STATE/$kind" ]; then /bin/cat "$FAKE_DOCKER_STATE/$kind"; fi
`, { mode: 0o700 });
  for (const kind of ['containers', 'volumes', 'networks']) writeFileSync(join(root, kind), `${kind}-id\n`);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: root };
}

test('default teardown removes and verifies blank-snapshot resources by label without the origin worktree', async () => {
  const f = fixture();
  f.on();
  const pool = f.pool({ root: join(f.root, 'deleted-origin'), destroy: undefined, env: fakeDocker(f.root) });
  const lease = await pool.register('partial-startup', 'ordinary');
  await lease!.destroy();
  expect(existsSync(join(f.root, 'deleted-origin'))).toBe(false);
  expect(existsSync(join(f.state, 'partial-startup.json'))).toBe(false);
  const commands = readFileSync(join(f.root, 'commands'), 'utf8');
  expect(commands).toContain('label=com.docker.compose.project=rezics-qa-partial-startup');
  expect(commands).toContain('rm -f containers-id');
  expect(commands).toContain('volume rm -f volumes-id');
  expect(commands).toContain('network rm networks-id');
  expect(commands.split('\n').filter(line => line.startsWith('ps '))).toHaveLength(2);
});

test('tracked startup child identity is durable and default teardown stops it before removing resources', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool({ destroy: undefined, env: fakeDocker(f.root) }).register('startup', 'ordinary');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    const untrack = trackHeldQaStackStartup('startup', child.pid!);
    const identity = processIdentity(child.pid!)!;
    expect(untrack).toBeDefined();
    expect(f.saved('startup').startupChild).toEqual(identity);
    await lease!.destroy();
    expect(processAlive(identity)).toBe(false);
    expect(existsSync(join(f.state, 'startup.json'))).toBe(false);
    untrack!();
  } finally { terminateProcessGroupSync(child.pid!, 0); }
});

test('finishing startup clears only that child identity while retaining the stack holder', async () => {
  const f = fixture();
  f.on();
  await f.pool().register('startup', 'ordinary');
  const untrack = trackHeldQaStackStartup('startup', process.pid);
  expect(f.saved('startup').startupChild?.pid).toBe(process.pid);
  untrack!();
  expect(f.saved('startup').startupChild).toBeUndefined();
  expect(f.saved('startup').holder).toEqual(f.identity('first'));
});

test('the idle janitor destroys an expired parked stack without another pool operation', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool().register('idle', 'ordinary');
  await lease!.park(apps, compose);
  const saved = f.saved('idle');
  saved.parkedAt = Date.now() - qaStackPoolMaxParkedMs + 100;
  writeFileSync(join(f.state, 'idle.json'), JSON.stringify(saved));
  const child = spawn(process.execPath, [resolve(import.meta.dir, 'stack-pool.ts'), '--janitor',
    join(f.root, 'deleted-origin'), f.slotDirectory, '2'], { env: fakeDocker(f.root), stdio: 'ignore' });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Idle janitor did not finish')); }, 3_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`Janitor exited ${code}`)); });
  });
  expect(existsSync(join(f.state, 'idle.json'))).toBe(false);
  expect(existsSync(join(f.state, 'janitor'))).toBe(false);
  expect(existsSync(join(f.root, 'containers'))).toBe(false);
});
