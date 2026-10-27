import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const gate = join(repository, 'scripts/gate.ts');

// A fake ssh answers each kind of remote script by what it contains; a fake rsync and a fake bun record what reaches
// them. Nothing here touches a network or installs packages.
const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const script = args.at(-1)!;
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address: args.at(-2), ...event }) + '\\n');
const address = args.at(-2)!;
const hostKey = address.replace(/[^a-z0-9]/gi, '_');
const config = JSON.parse(readFileSync(dir + '/config.json', 'utf8'))[address];
if (script.includes('/proc/loadavg')) {
  const maximum = config.memoryMax;
  const used = Array.from({ length: config.slots }, (_, index) => existsSync(dir + '/' + hostKey + '.slot.' + index)).filter(Boolean).length;
  const gateWaiting = existsSync(dir + '/' + hostKey + '.gate-marker');
  log({ kind: 'probe', script, slotsUsed: used, gateWaiting });
  console.log('MEMORY_CURRENT 0');
  console.log('MEMORY_MAX ' + maximum);
  console.log('MEMORY_HEADROOM ' + maximum);
  console.log('PROCESSORS 16');
  console.log('SLICE_PROCESSORS ' + config.cpuQuotaPercent / 100);
  console.log('LOAD 0');
  console.log('SLOTS_USED ' + used);
  console.log('GATE_WAITING ' + (gateWaiting ? 1 : 0));
} else if (script.includes('REMOTE_CHECK_GATE_MARKER')) {
  const marker = dir + '/' + hostKey + '.gate-marker';
  if (existsSync(marker)) process.exit(75);
  mkdirSync(marker);
  log({ kind: 'gate-marker' });
  console.log('GATE_MARKER');
  const release = () => {
    rmSync(marker, { recursive: true, force: true });
    log({ kind: 'gate-marker-release' });
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const requested = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const slotLimit = Number(script.match(/# REMOTE_CHECK_SLOT_LIMIT (\\d+)/)?.[1] ?? config.slots);
  const occupied = Array.from({ length: config.slots }, (_, index) => index).filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index));
  const available = Array.from({ length: config.slots }, (_, index) => index).filter((index) => !occupied.includes(index));
  if (occupied.length + requested > slotLimit || available.length < requested) process.exit(75);
  const selected = available.slice(0, requested);
  for (const slot of selected) mkdirSync(dir + '/' + hostKey + '.slot.' + slot);
  for (const slot of selected) log({ kind: 'slot', slot, requested });
  console.log('SLOTS ' + requested);
  const release = () => {
    for (const slot of selected) {
      rmSync(dir + '/' + hostKey + '.slot.' + slot, { recursive: true, force: true });
      log({ kind: 'release', slot });
    }
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_STATUS')) {
  log({ kind: 'status' });
  if (!existsSync(dir + '/status')) process.exit(1);
  console.log(readFileSync(dir + '/status', 'utf8'));
} else if (script.includes('systemd-run')) {
  const countFile = dir + '/run-count';
  const count = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
  writeFileSync(countFile, String(count));
  log({ kind: 'run', script, count });
  if (process.env.FAKE_DROP_FIRST_RUN === '1' && count === 1) process.exit(255);
  if (process.env.FAKE_HANG) {
    console.log('remote gate output');
    console.log('started');
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
  } else {
    const code = Number(process.env.FAKE_EXIT ?? 0);
    writeFileSync(dir + '/status', String(code));
    console.log('remote gate output');
    process.exit(code);
  }
} else {
  log({ kind: 'cleanup', script });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const input = await Bun.stdin.text();
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination: process.argv.at(-1),
  files: input.split('\\0').filter(Boolean).length,
}) + '\\n');
`;

// The gate's first local command is its install; this one records it and fails, which ends the gate there.
const fakeBun = `#!/bin/sh
echo "bun $*" >> "$FAKE_DIR/local.log"
exit 3
`;

const fakeWorkspaceBun = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const log = (event) => appendFileSync(dir + '/log.jsonl', JSON.stringify(event) + '\\n');
if (args[0] === 'install') {
  log({ kind: 'install' });
} else if (args[0] === 'run' && args[1] === 'check') {
  const workspace = process.cwd().split('/').at(-1);
  const events = readFileSync(dir + '/log.jsonl', 'utf8').trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
  const attempt = events.filter((event) => event.kind === 'check' && event.workspace === workspace).length + 1;
  log({ kind: 'check', workspace, attempt });
  if (workspace === 'a-plain' && attempt === 1) {
    console.log('(fail) only failure is a timeout [60000ms]');
    console.log('  ^ this test timed out after 60000ms.');
    console.log('1 tests failed:');
    process.exit(1);
  }
  console.log(workspace === 'a-plain' ? '(pass) timeout test passed alone [1ms]' : 'runner workspace complete');
} else if (args[0] === 'tools/goal/scripts/gate.ts') {
  log({ kind: 'control-gate' });
}
`;

type Event = { kind: string; address?: string; [key: string]: unknown };
let root: string;
let counter = 0;

beforeAll(() => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  root = mkdtempSync(join(repository, '.temp/gate-test-'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'gate-bin'));
  mkdirSync(join(root, 'local'));
  for (const [directory, name, source] of [
    ['bin', 'ssh', fakeSsh],
    ['bin', 'rsync', fakeRsync],
    ['gate-bin', 'bun', fakeWorkspaceBun],
    ['local', 'bun', fakeBun],
  ] as const) {
    const file = join(root, directory, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function scenario(slots = 6): { env: Record<string, string>; events: () => Event[]; local: () => string } {
  const dir = join(root, `scenario-${counter++}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ 'ops@b.test': { slots, memoryMax: 48 * 2 ** 30, cpuQuotaPercent: 1400 } }),
  );
  writeFileSync(
    join(dir, 'hosts.json'),
    JSON.stringify({
      hosts: [
        { name: 'b', address: 'ops@b.test', identity: '/keys/b', memoryMaxGiB: 48, cpuQuotaPercent: 1400, slots },
      ],
    }),
  );
  const env = { ...(process.env as Record<string, string>) };
  delete env.GATE_CONCURRENCY;
  delete env.GATE_REMOTE_SLOTS;
  delete env.KERNEL_CHECK_ON_REMOTE;
  return {
    env: {
      ...env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      KERNEL_CHECK_REMOTE: join(dir, 'hosts.json'),
      REMOTE_CHECK_POLL_MS: '20',
    },
    events: () => {
      const file = join(dir, 'log.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event)
        : [];
    },
    local: () => (existsSync(join(dir, 'local.log')) ? readFileSync(join(dir, 'local.log'), 'utf8') : ''),
  };
}

async function runGate(
  env: Record<string, string>,
  cwd = repository,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, gate], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('with KERNEL_CHECK_REMOTE set the root gate runs whole on one check host and exits with its code', async () => {
  const { env, events, local } = scenario();
  const result = await runGate({ ...env, FAKE_EXIT: '7', GATE_CONCURRENCY: '4', GATE_REMOTE_SLOTS: '3' });

  expect(result.code).toBe(7);
  expect(result.stdout).toContain('remote gate output');
  // Nothing is installed or checked here.
  expect(local()).toBe('');
  expect(result.stdout).not.toContain('$ bun install');

  const seen = events();
  const sync = seen.find((event) => event.kind === 'rsync')!;
  expect(sync.destination).toStartWith('ops@b.test:/srv/rezics-check/runs/');
  expect(sync.files as number).toBeGreaterThan(1000);
  const runs = seen.filter((event) => event.kind === 'run');
  expect(runs).toHaveLength(1);
  const script = runs[0].script as string;
  expect(script).toContain('KERNEL_CHECK_ON_REMOTE=1');
  expect(script).toContain('env GATE_CONCURRENCY=4 bun scripts/gate.ts');
  // The requested number of slots is held on that one host and all are released after the run directory is removed.
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(3);
  expect(seen.map((event) => event.kind).slice(-4)).toEqual(['cleanup', 'release', 'release', 'release']);
});

test('the gate is not capped at half capacity and leaves one slot of its host free', async () => {
  const { env, events } = scenario(6);
  const result = await runGate({ ...env, GATE_REMOTE_SLOTS: '6' });

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('gate requested 6 slots; using 5 to leave one slot of the host free');
  const seen = events();
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(5);
  const probe = seen.find((event) => event.kind === 'probe')!.script as string;
  expect(probe).toContain('GATE_WAITING');
  const take = (seen.find((event) => event.kind === 'slot')!);
  expect(take.requested).toBe(5);
});

test("the gate retries its remote run once after a transport failure and exits with the second run's code", async () => {
  const { env, events } = scenario(2);
  const result = await runGate({ ...env, FAKE_DROP_FIRST_RUN: '1', FAKE_EXIT: '7', GATE_REMOTE_SLOTS: '1' });

  expect(result.code).toBe(7);
  expect(result.stderr).toContain('transport failure; retrying once');
  const seen = events();
  expect(seen.filter((event) => event.kind === 'run')).toHaveLength(2);
  expect(seen.filter((event) => event.kind === 'status')).toHaveLength(1);
  expect(seen.filter((event) => event.kind === 'rsync')).toHaveLength(2);
});

test('the gate asks for six slots and forwards no concurrency unless set', async () => {
  const { env, events } = scenario(6);
  const result = await runGate(env);
  expect(result.code).toBe(0);
  const seen = events();
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(5);
  expect(result.stderr).toContain('using 5 to leave one slot');
  const script = seen.find((event) => event.kind === 'run')!.script as string;
  expect(script).toContain('bun scripts/gate.ts');
  expect(script).not.toContain('GATE_CONCURRENCY');
});

test('a signal sent to the gate reaches the remote run, which is cleaned up before the gate exits', async () => {
  const { env, events } = scenario(2);
  const child = Bun.spawn([process.execPath, gate], {
    cwd: repository,
    env: { ...env, FAKE_HANG: '1', GATE_REMOTE_SLOTS: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('started')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  expect(text).toContain('started');
  child.kill('SIGTERM');
  expect(await child.exited).toBe(143);
  expect(
    events()
      .map((event) => event.kind)
      .slice(-2),
  ).toEqual(['cleanup', 'release']);
});

test('without KERNEL_CHECK_REMOTE, or on the check host, the gate runs locally as before', async () => {
  const localPath = (env: Record<string, string>) => ({ ...env, PATH: `${join(root, 'local')}:${env.PATH}` });

  const unset = scenario();
  const withoutRemote = { ...unset.env };
  delete withoutRemote.KERNEL_CHECK_REMOTE;
  const first = await runGate(localPath(withoutRemote));
  expect(first.code).toBe(3);
  expect(first.stdout).toContain('$ bun install --frozen-lockfile');
  expect(unset.local()).toBe('bun install --frozen-lockfile\n');
  expect(unset.events()).toEqual([]);

  const onHost = scenario();
  const second = await runGate(localPath({ ...onHost.env, KERNEL_CHECK_ON_REMOTE: '1' }));
  expect(second.code).toBe(3);
  expect(onHost.local()).toBe('bun install --frozen-lockfile\n');
  expect(onHost.events()).toEqual([]);

  // A hosts file that cannot be read does not hand off either.
  const unreadable = scenario();
  const third = await runGate(localPath({ ...unreadable.env, KERNEL_CHECK_REMOTE: join(root, 'no-such-hosts.json') }));
  expect(third.code).toBe(3);
  expect(unreadable.local()).toBe('bun install --frozen-lockfile\n');
  expect(unreadable.events()).toEqual([]);
});

test('the gate reruns a plain workspace whose only test failures are load-induced after the other workspaces finish', async () => {
  const { env, events } = scenario();
  delete env.KERNEL_CHECK_REMOTE;
  env.PATH = `${join(root, 'gate-bin')}:${env.PATH}`;
  env.GATE_CONCURRENCY = '1';
  const plain = join(env.FAKE_DIR, 'apps/a-plain');
  const runner = join(env.FAKE_DIR, 'packages/b-runner');
  mkdirSync(plain, { recursive: true });
  mkdirSync(runner, { recursive: true });
  writeFileSync(
    join(plain, 'package.json'),
    JSON.stringify({ name: '@fixture/plain', scripts: { check: 'bun test && bun run after-tests' } }),
  );
  writeFileSync(
    join(runner, 'package.json'),
    JSON.stringify({ name: '@fixture/runner', scripts: { check: 'bun scripts/check.ts && bun test' } }),
  );

  const result = await runGate(env, env.FAKE_DIR);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Load-sensitive workspaces (passed on retry): 1');
  expect(result.stdout).toContain('@fixture/plain (apps/a-plain)');
  expect(
    events()
      .filter((event) => event.kind === 'install' || event.kind === 'check' || event.kind === 'control-gate')
      .map((event) => `${event.kind}${event.workspace ? ` ${event.workspace}` : ''}`),
  ).toEqual(['install', 'check a-plain', 'check b-runner', 'check a-plain', 'control-gate']);
});
