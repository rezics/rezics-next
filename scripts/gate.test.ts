import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_DURATIONS, loadDurationTable, runLocalGate, splitWorkspaces, type Workspace } from './gate.ts';

const repository = resolve(import.meta.dir, '..');
const gate = join(repository, 'scripts/gate.ts');

// A fake ssh answers each kind of remote script by what it contains; a fake rsync and fake bun record what reaches
// them. Nothing here touches a network or installs packages.
const fakeSsh = `#!${process.execPath}
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const control = args.includes('-O');
const address = args.at(control ? -1 : -2)!;
if (address !== 'ops@b.test' && address !== 'ops@c.test') throw new Error('Unexpected fixture host: ' + address);
if (control) process.exit(0);
let script = args.at(-1)!;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
if (script.startsWith('python3 -c ') && script.includes('truncated launch')) {
  const [size, digest] = script.split(/\\s+/).slice(-2);
  const bytes = Buffer.from(await Bun.stdin.arrayBuffer());
  if (bytes.length !== Number(size) || sha256(bytes) !== digest) throw new Error('Invalid launch payload');
  script = bytes.toString();
}
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, at: Date.now(), ...event }) + '\\n');
const runId = script.match(/runs\\/([a-z0-9-]+)/)?.[1] ?? 'none';
const returnsDir = dir + '/remote-returns/' + runId;
const hold = (release: () => void) => {
  process.stdin.on('data', () => {});
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
};
if (script.includes('REMOTE_CHECK_RETURNS')) {
  log({ kind: 'returns' });
  const inventory = [];
  for (const [, path] of script.matchAll(/^# PATH (.+)$/gm)) {
    const file = returnsDir + '/' + path;
    if (existsSync(file)) {
      const bytes = readFileSync(file);
      inventory.push({ kind: 'file', path, size: bytes.length, sha256: sha256(bytes) });
      console.log('PRESENT ' + path);
    } else {
      console.log('ABSENT ' + path);
    }
  }
  console.log('MANIFEST ' + Buffer.from(JSON.stringify(inventory)).toString('base64'));
  console.log('ZSTD 0');
} else if (script.includes('MemAvailable')) {
  log({ kind: 'probe' });
  console.log('MEMORY_CURRENT -');
  console.log('MEMORY_MAX -');
  console.log('MEMORY_HEADROOM 32000000000');
  console.log('MEMORY_RESERVED 0');
  console.log('MEMORY_RECLAIMABLE 0');
  console.log('PROCESSORS 32');
  console.log('SLICE_PROCESSORS 18');
  console.log('LOAD 0');
  console.log('PRESSURE_PAUSED 0');
  console.log('AVAILABLE 32000000000');
  console.log('TMP_BYTES 16000000000');
  console.log('TMP_INODES 1000000');
  console.log('DISK_FREE 512000000000');
  console.log('ORDINARY_SLOTS_USED 0');
  console.log('EXPRESS_SLOT_USED 0');
  console.log('GATE_WAITING 0');
  console.log('MULTI_SLOT_WAITING_SLOTS 0');
  console.log('MULTI_SLOT_WAITING_ID -');
  console.log('LANDING_WAITING_SLOTS 0');
  console.log('LANDING_WAITING_ID -');
  console.log('LANDING_WAITING_STARTED -');
  console.log('LANDING_WAITING_ESTIMATE_MS -1');
  console.log('LANDING_WAITING_MEMORY_BYTES 2684354560');
} else if (script.includes('REMOTE_CHECK_CONTROL_PROBE')) {
  console.log('REMOTE_CHECK_CONTROL_OK');
} else if (script.includes('REMOTE_CHECK_BASE_STATE')) {
  console.log('BASE -\\nAGE -\\nZSTD 0');
} else if (script.includes('REMOTE_CHECK_GATE_MARKER')) {
  log({ kind: 'gate-marker' });
  console.log('GATE_MARKER');
  hold(() => {
    log({ kind: 'gate-marker-release' });
    process.exit(0);
  });
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const count = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const slotLimit = Number(script.match(/# REMOTE_CHECK_SLOT_LIMIT (\\d+)/)?.[1] ?? count);
  for (let slot = 0; slot < count; slot += 1) log({ kind: 'slot', slot, requested: count, slotLimit });
  console.log('SLOTS ' + count);
  hold(() => {
    for (let slot = 0; slot < count; slot += 1) log({ kind: 'release', slot });
    process.exit(0);
  });
} else if (script.includes('REMOTE_CHECK_STATUS')) {
  log({ kind: 'status', runId });
  const status = dir + '/status-' + runId;
  console.log(existsSync(status) ? readFileSync(status, 'utf8') : 'NOT_STARTED');
} else if (script.startsWith('# REMOTE_CHECK_RUN_LIFETIME_MS ')) {
  const group = Number(script.match(/GATE_GROUP_INDEX=(\\d+)/)?.[1] ?? 0);
  const countFile = dir + '/run-count-' + group;
  const count = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
  writeFileSync(countFile, String(count));
  log({ kind: 'run', script, group, runId, count });
  if (process.env.FAKE_DROP_FIRST_RUN === '1' && count === 1 && group === Number(process.env.FAKE_DROP_GROUP ?? 0)) {
    // The launch disconnects and its status reply cannot establish whether the command started.
    writeFileSync(dir + '/status-' + runId, 'invalid status');
    process.exit(255);
  }
  if (process.env.FAKE_HANG) {
    writeFileSync(dir + '/status-' + runId, 'STARTED');
    process.on('SIGTERM', () => {
      log({ kind: 'run-stopped', runId });
      process.exit(143);
    });
    console.log('remote gate output');
    console.log('started');
    setInterval(() => {}, 1000);
  } else {
    await Bun.sleep(Number(process.env.FAKE_RUN_DELAY_MS ?? 0));
    const configured = process.env['FAKE_EXIT_GROUP_' + group];
    const code = Number(configured ?? process.env.FAKE_EXIT ?? 0);
    writeFileSync(dir + '/status-' + runId, String(code));
    log({ kind: 'finished', group, runId, code });
    const resultPath = script.match(/GATE_RESULT_FILE=([^\\s'\"]+)/)?.[1];
    if (resultPath) {
      const invocation = 'bun scripts/gate.ts --workspaces ';
      const invocationIndex = script.lastIndexOf(invocation);
      const requested = invocationIndex < 0
        ? []
        : script.slice(invocationIndex + invocation.length).split(/\\s+/).filter(Boolean).map((path) => path.replace(/^'|'$/g, ''));
      const requestedWorkspaces = requested.filter((path) => /^(apps|services|packages)\\//.test(path));
      const result = {
        workspaces: requestedWorkspaces.map((directory) => ({
          name: '@fixture/remote-' + group,
          directory: process.env.FAKE_RESULT_WORKSPACE ?? directory,
          host: address.includes('@b.') ? 'b' : 'c',
          passed: code === 0,
          durationSeconds: 1.25,
          failingFiles: code === 0 ? [] : ['test/remote-' + group + '.test.ts'],
          loadSensitiveTests: [],
        })),
        ...(requested.includes('tools/goal/scripts/gate.ts')
          ? { controlPlane: { passed: code === 0, durationSeconds: 0.5, host: address.includes('@b.') ? 'b' : 'c' } }
          : {}),
      };
      const resultFile = returnsDir + '/' + resultPath;
      mkdirSync(resultFile.slice(0, resultFile.lastIndexOf('/')), { recursive: true });
      writeFileSync(resultFile, JSON.stringify(result));
    }
    console.log((address.includes('@b.') ? 'b' : 'c') + ': remote gate output');
    process.exit(code);
  }
} else if (script.includes("printf 'STOPPED")) {
  log({ kind: 'stop', runId });
  console.log('STOPPED');
} else if (script.startsWith('run_id=') && script.includes("printf 'CLEANED %s")) {
  log({ kind: 'cleanup', runId });
  console.log('CLEANED ' + runId);
} else if (!script.includes('REMOTE_CHECK_PHYSICAL_RESOURCES')) {
  throw new Error('Unexpected fixture SSH request: ' + script.slice(0, 100));
}
`;

const fakeRsync = `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const input = await Bun.stdin.text();
const args = process.argv.slice(2);
const source = args.at(-2) ?? '';
const destination = args.at(-1) ?? '';
const remoteRun = /^ops@[bc]\\.test:\\/srv\\/rezics-check\\/runs\\/([a-z0-9-]+)\\/$/;
const returned = source.match(remoteRun);
if (!returned && !remoteRun.test(destination)) throw new Error('Unexpected fixture rsync endpoints');
const files = input.split('\\0').filter(Boolean);
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination,
  files: files.length,
}) + '\\n');
if (returned) {
  const runId = returned[1]!;
  for (const path of files) {
    const from = join(process.env.FAKE_DIR, 'remote-returns', runId, path);
    const to = join(destination, path);
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}
`;

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
  if (workspace === 'auth') {
    const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
    await write(process.stdout, 'Auth checks started\\n');
    await write(process.stderr, '(fail) Auth readiness\\n  ^ this test timed out after 60000ms.\\n');
    const noise = 'x'.repeat(64 * 1024);
    for (const stream of [process.stdout, process.stderr]) {
      for (let i = 0; i < 64; i++) await write(stream, noise);
      await write(stream, '\\n');
    }
    await write(process.stderr, 'Database cleanup failed: fixture\\ntests/middle.test.ts:\\nLoad-sensitive tests (passed alone): 1\\nprevious read\\n');
    for (let i = 0; i < 64; i++) await write(process.stderr, noise);
    await write(process.stderr, '\\nAuth checks finished\\n');
    process.exit(1);
  }
  if (workspace === 'a-plain' && attempt === 1) {
    console.log('test/a-plain.test.ts:');
    console.log('(fail) only failure is a timeout [60000ms]');
    console.log('  ^ this test timed out after 60000ms.');
    console.log('1 tests failed:');
    console.log('Load-sensitive tests (passed alone): 1');
    console.log('load-sensitive test: test/a-plain.test.ts :: timeout :: retry passed');
    process.exit(1);
  }
  if (workspace === 'b-lane') {
    console.log('Kernel tests failed for 1 file(s):');
    console.log('test/b-lane.test.ts');
    process.exit(1);
  }
  console.log(workspace === 'a-plain' ? '(pass) timeout test passed alone [1ms]' : 'runner workspace complete');
} else if (args[0] === 'tools/goal/scripts/gate.ts') {
  log({ kind: 'control-gate' });
}
`;

type Event = { kind: string; address?: string; at?: number; [key: string]: unknown };
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

function scenario(): { env: Record<string, string>; events: () => Event[]; local: () => string; dir: string } {
  const dir = join(root, `scenario-${counter++}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'hosts.json'),
    JSON.stringify({
      hosts: [
        {
          name: 'b',
          performance: true,
          address: 'ops@b.test',
          identity: '/keys/b',
          memoryMaxGiB: 54,
          cpuQuotaPercent: 1800,
          slots: 9,
        },
        {
          name: 'c',
          performance: true,
          address: 'ops@c.test',
          identity: '/keys/c',
          memoryMaxGiB: 54,
          cpuQuotaPercent: 1800,
          slots: 9,
        },
      ],
    }),
  );
  const env = { ...(process.env as Record<string, string>) };
  delete env.GATE_CONCURRENCY;
  delete env.GATE_REMOTE_SLOTS;
  delete env.GATE_DURATIONS_FILE;
  delete env.KERNEL_CHECK_ON_REMOTE;
  return {
    dir,
    env: {
      ...env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      GIT_ALLOW_PROTOCOL: '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GATE_RESULT_FILE: join(dir, 'result.json'),
      KERNEL_CHECK_REMOTE: join(dir, 'hosts.json'),
      REMOTE_CHECK_POLL_MS: '20',
      REMOTE_CHECK_SSH_CONTROL_DIR: join(root, 'ssh'),
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

function spawnGate(
  env: Record<string, string>,
  cwd = candidateCheckout(env.FAKE_DIR!),
  args: string[] = [],
) {
  return Bun.spawn([process.execPath, gate, ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function runGate(
  env: Record<string, string>,
  cwd?: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnGate(env, cwd, args);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function fixtureWorkspace(cwd: string, directory: string, name: string, check = 'bun test'): void {
  const target = join(cwd, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, scripts: { check } }));
}

function candidateCheckout(dir: string): string {
  const cwd = join(dir, 'checkout');
  // Equal default durations give the full gate one workspace per group and put the control plane in group zero.
  fixtureWorkspace(cwd, 'apps/a-plain', '@fixture/plain');
  fixtureWorkspace(cwd, 'packages/b-runner', '@fixture/runner');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git(['init', '--quiet', '--template=']);
  git(['add', '--all']);
  git(['-c', 'user.name=Gate Fixture', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'Candidate']);

  const bunPackage = join(cwd, 'node_modules/bun');
  mkdirSync(join(bunPackage, 'bin'), { recursive: true });
  writeFileSync(join(bunPackage, 'package.json'), JSON.stringify({ version: Bun.version }));
  symlinkSync(process.execPath, join(bunPackage, 'bin/bun.exe'));
  mkdirSync(join(cwd, 'node_modules/.bin'));
  symlinkSync(join(root, 'local/bun'), join(cwd, 'node_modules/.bin/bun'));
  return cwd;
}

function selectedWorkspaceDirectories(script: string): string[] {
  const invocation = 'bun scripts/gate.ts --workspaces ';
  const invocationIndex = script.lastIndexOf(invocation);
  if (invocationIndex < 0) return [];
  return script
    .slice(invocationIndex + invocation.length)
    .split(/\s+/)
    .map((path) => path.replace(/^'|'$/g, ''))
    .filter((path) => /^(apps|services|packages)\//.test(path));
}

test('with KERNEL_CHECK_REMOTE the gate runs two workspace groups on check hosts in parallel and fails if either fails', async () => {
  const { env, events } = scenario();
  const result = await runGate({
    ...env,
    FAKE_EXIT_GROUP_1: '7',
    FAKE_RUN_DELAY_MS: '700',
    GATE_REMOTE_SLOTS: '4',
    GATE_CONCURRENCY: '3',
  });
  expect(result.code, result.stderr).toBe(7);
  expect(result.stdout).toContain('Failed workspaces:');
  expect(result.stdout).toContain('b: remote gate output');
  expect(result.stdout).toContain('c: remote gate output');
  expect(result.stdout).toContain('Gate result:');
  expect(result.stdout.trimEnd().endsWith('Gate result: ' + env.GATE_RESULT_FILE)).toBe(true);
  expect(result.stdout).not.toContain('$ bun install');

  const seen = events();
  const runs = seen.filter((event) => event.kind === 'run');
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map((event) => event.group))).toEqual(new Set([0, 1]));
  expect(new Set(runs.map((event) => event.address))).toEqual(new Set(['ops@b.test', 'ops@c.test']));
  const starts = runs.map((event) => event.at as number);
  const finishes = seen.filter((event) => event.kind === 'finished').map((event) => event.at as number);
  expect(Math.max(...starts)).toBeLessThan(Math.min(...finishes));
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(8);
  expect(seen.filter((event) => event.kind === 'slot').every((event) => event.slotLimit === 7)).toBe(true);
  expect(seen.filter((event) => event.kind === 'rsync')).toHaveLength(4);
  const scripts = runs.map((event) => event.script as string);
  const failedGroupScript = scripts.find((script) => script.includes('GATE_GROUP_INDEX=1'))!;
  const failedGroupWorkspaces = selectedWorkspaceDirectories(failedGroupScript).sort();
  expect(failedGroupWorkspaces.length).toBeGreaterThan(0);
  expect(result.stdout).toContain(`Failed workspaces: ${failedGroupWorkspaces.join(' ')}`);
  expect(scripts.every((script) => script.includes('KERNEL_CHECK_ON_REMOTE=1'))).toBe(true);
  expect(scripts.every((script) => script.includes('GATE_CONCURRENCY=3'))).toBe(true);
  expect(scripts.every((script) => script.includes('--workspaces'))).toBe(true);
  expect(scripts.some((script) => script.includes('tools/goal/scripts/gate.ts'))).toBe(true);
  expect(scripts.find((script) => script.includes('tools/goal/scripts/gate.ts'))).toContain('GATE_GROUP_INDEX=0');
  const merged = JSON.parse(readFileSync(env.GATE_RESULT_FILE!, 'utf8')) as {
    workspaces: Array<{ directory: string; host: string; passed: boolean }>;
    controlPlane: { passed: boolean; host: string };
  };
  const expectedWorkspaces = scripts.flatMap(selectedWorkspaceDirectories).sort();
  expect(merged.workspaces.map((workspace) => workspace.directory)).toEqual(expectedWorkspaces);
  const failedOutcomes = merged.workspaces.filter((workspace) => failedGroupWorkspaces.includes(workspace.directory));
  expect(failedOutcomes.map((workspace) => workspace.directory)).toEqual(failedGroupWorkspaces);
  expect(failedOutcomes.every((workspace) => !workspace.passed)).toBe(true);
  expect(merged.controlPlane).toEqual({ passed: true, durationSeconds: 0.5, host: 'b' });
});

test('workspaces are grouped by measured duration, longest first', () => {
  const workspaces: Workspace[] = ['a', 'b', 'c', 'd', 'e'].map((directory) => ({
    name: directory,
    directory,
    checkScript: 'bun run check',
  }));
  const timingFile = join(root, `durations-${counter++}.json`);
  writeFileSync(
    timingFile,
    JSON.stringify({
      workspaces: [9, 8, 7, 6, 5].map((durationSeconds, index) => ({
        directory: String.fromCharCode(97 + index),
        durationSeconds,
      })),
    }),
  );
  const groups = splitWorkspaces(workspaces, loadDurationTable(workspaces, timingFile));
  expect(groups.map((group) => group.map((workspace) => workspace.directory))).toEqual([
    ['a', 'd', 'e'],
    ['b', 'c'],
  ]);
  expect(loadDurationTable(workspaces, join(root, 'missing-duration-file')).get('a')).toBe(20);
  expect(DEFAULT_DURATIONS['apps/web']).toBe(2882);
  const defaultWorkspaces = Object.keys(DEFAULT_DURATIONS).map((directory) => ({
    name: directory,
    directory,
    checkScript: 'bun run check',
  }));
  const defaultGroups = splitWorkspaces(defaultWorkspaces, new Map(Object.entries(DEFAULT_DURATIONS)));
  expect(defaultGroups.map((group) => group[0]?.directory)).toEqual(['apps/web', 'services/kernel']);
  expect(
    defaultGroups
      .flat()
      .map(({ directory }) => directory)
      .sort(),
  ).toEqual(defaultWorkspaces.map(({ directory }) => directory).sort());
});

test("the gate writes a JSON result with each workspace's outcome, failing files, load-sensitive tests, duration and host", async () => {
  const { env, dir } = scenario();
  delete env.KERNEL_CHECK_REMOTE;
  env.PATH = `${join(root, 'gate-bin')}:${process.env.PATH}`;
  env.REMOTE_CHECK_HOST = 'check-fixture';
  const fixture = join(dir, 'checkout');
  mkdirSync(fixture);
  fixtureWorkspace(fixture, 'apps/a-plain', '@fixture/plain', 'bun test && bun run after-tests');
  fixtureWorkspace(fixture, 'services/b-lane', '@fixture/lane', 'bun scripts/check.ts');
  delete env.GATE_RESULT_FILE;

  const code = await runLocalGate([], fixture, env);
  expect(code).toBe(1);
  const file = JSON.parse(readFileSync(join(fixture, '.temp/gate/result.json'), 'utf8')) as {
    workspaces: Array<{
      name: string;
      directory: string;
      host: string;
      passed: boolean;
      durationSeconds: number;
      failingFiles: string[];
      loadSensitiveTests: string[];
    }>;
  };
  expect(file.workspaces).toHaveLength(2);
  expect(file.workspaces[0]).toMatchObject({
    name: '@fixture/plain',
    directory: 'apps/a-plain',
    host: 'check-fixture',
    passed: true,
    failingFiles: ['test/a-plain.test.ts'],
    loadSensitiveTests: ['load-sensitive test: test/a-plain.test.ts :: timeout :: retry passed'],
  });
  expect(file.workspaces[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  expect(file.workspaces[1]).toMatchObject({
    name: '@fixture/lane',
    directory: 'services/b-lane',
    host: 'check-fixture',
    passed: false,
    failingFiles: ['test/b-lane.test.ts'],
  });
});

test('a noisy Auth Pages check retains its native failure and middle report entries within a bounded log', async () => {
  const { env, dir, events } = scenario();
  env.PATH = `${join(root, 'gate-bin')}:${process.env.PATH}`;
  const fixture = join(dir, 'checkout');
  fixtureWorkspace(fixture, 'apps/auth', '@rezics/auth-pages');
  let log = '';
  const output = spyOn(process.stdout, 'write').mockImplementation((text) => {
    log += String(text);
    return true;
  });
  try {
    expect(await runLocalGate(['--workspaces', 'apps/auth'], fixture, env)).toBe(1);
  } finally {
    output.mockRestore();
  }
  expect(events().filter((event) => event.kind === 'check')).toHaveLength(1);
  expect(log).toContain('Auth checks started');
  expect(log).toContain('Auth checks finished');
  expect(log).toContain('diagnostic bytes]');
  expect(log.length).toBeLessThan(300_000);
  expect(JSON.parse(readFileSync(env.GATE_RESULT_FILE!, 'utf8')).workspaces).toMatchObject([
    {
      directory: 'apps/auth',
      passed: false,
      failingFiles: ['tests/middle.test.ts'],
      loadSensitiveTests: ['previous read'],
    },
  ]);
});

test('a transport failure is not replayed, and local load-induced reruns keep their reports', async () => {
  const { env, events } = scenario();
  const result = await runGate({ ...env, FAKE_DROP_FIRST_RUN: '1', FAKE_DROP_GROUP: '0', GATE_REMOTE_SLOTS: '4' });
  expect(result.code, result.stderr).toBe(75);
  expect(result.stderr).not.toContain('retrying once');
  const runs = events().filter((event) => event.kind === 'run');
  expect(runs.filter((event) => event.group === 0)).toHaveLength(1);
  expect(runs.filter((event) => event.group === 1)).toHaveLength(1);

  const local = scenario();
  local.env.PATH = `${join(root, 'gate-bin')}:${process.env.PATH}`;
  local.env.GATE_CONCURRENCY = '1';
  const fixture = join(local.dir, 'checkout');
  mkdirSync(fixture);
  fixtureWorkspace(fixture, 'apps/a-plain', '@fixture/plain', 'bun test && bun run after-tests');
  fixtureWorkspace(fixture, 'packages/b-runner', '@fixture/runner', 'bun scripts/check.ts && bun test');
  const selected = await runLocalGate(['--workspaces', 'apps/a-plain'], fixture, local.env);
  expect(selected).toBe(0);
  expect(
    local
      .events()
      .filter((event) => event.kind === 'check')
      .map((event) => event.workspace),
  ).toEqual(['a-plain', 'a-plain']);
  const resultFile = JSON.parse(readFileSync(local.env.GATE_RESULT_FILE!, 'utf8')) as {
    workspaces: Array<{ directory: string; host: string }>;
  };
  expect(resultFile.workspaces).toHaveLength(1);
  expect(resultFile.workspaces[0]).toMatchObject({ directory: 'apps/a-plain', host: 'local' });
});

test('selected workspaces and control-plane inclusion are preserved on remote handoff despite local markers', async () => {
  const { env, events, dir } = scenario();
  const fixture = candidateCheckout(dir);

  const result = await runGate(
    {
      ...env,
      FAKE_RESULT_WORKSPACE: 'apps/a-plain',
      GATE_REMOTE_SLOTS: '4',
      KERNEL_CHECK_ON_REMOTE: '1',
      REZICS_STACK_REMOTE: 'off',
      REZICS_CHECK_LOCAL_ONLY: '1',
      REZICS_CHECK_MEMORY_LEASE: 'already-held',
      REZICS_STACK_SLOT: 'already-held',
    },
    fixture,
    ['--workspaces', 'apps/a-plain', 'tools/goal/scripts/gate.ts'],
  );

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).not.toContain('$ bun install');
  expect(events().filter((event) => event.kind === 'install' || event.kind === 'check')).toEqual([]);
  const scripts = events()
    .filter((event) => event.kind === 'run')
    .map((event) => event.script as string);
  expect(scripts).toHaveLength(2);
  const selectedScript = scripts.find((script) => script.includes('apps/a-plain'))!;
  const controlScript = scripts.find((script) => script.includes('tools/goal/scripts/gate.ts'))!;
  expect(selectedScript).toContain('--workspaces');
  expect(selectedScript).not.toContain('packages/b-runner');
  expect(selectedScript).not.toContain('tools/goal/scripts/gate.ts');
  expect(controlScript).toContain('tools/goal/scripts/gate.ts');
  expect(controlScript).not.toContain('packages/b-runner');
  const resultFile = JSON.parse(readFileSync(env.GATE_RESULT_FILE!, 'utf8')) as {
    workspaces: Array<{ directory: string }>;
    controlPlane?: { passed: boolean };
  };
  expect(resultFile.workspaces).toEqual([
    {
      name: '@fixture/remote-0',
      directory: 'apps/a-plain',
      host: 'b',
      passed: true,
      durationSeconds: 1.25,
      failingFiles: [],
      loadSensitiveTests: [],
    },
  ]);
  expect(resultFile.controlPlane).toMatchObject({ passed: true });
});

test('a selected remote workspace does not gain the full gate or control plane', async () => {
  const { env, events, dir } = scenario();
  const fixture = candidateCheckout(dir);

  const result = await runGate({ ...env, FAKE_RESULT_WORKSPACE: 'apps/a-plain' }, fixture, [
    '--workspaces',
    'apps/a-plain',
  ]);

  expect(result.code, result.stderr).toBe(0);
  const scripts = events()
    .filter((event) => event.kind === 'run')
    .map((event) => event.script as string);
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain('apps/a-plain');
  expect(scripts[0]).not.toContain('packages/b-runner');
  expect(scripts[0]).not.toContain('tools/goal/scripts/gate.ts');
  const resultFile = JSON.parse(readFileSync(env.GATE_RESULT_FILE!, 'utf8')) as {
    workspaces: Array<{ directory: string }>;
    controlPlane?: { passed: boolean };
  };
  expect(resultFile.workspaces.map((workspace) => workspace.directory)).toEqual(['apps/a-plain']);
  expect(resultFile).not.toHaveProperty('controlPlane');
});

test('the gate asks for four slots per group and forwards concurrency only when set', async () => {
  const { env, events } = scenario();
  const result = await runGate(env);
  expect(result.code, result.stderr).toBe(0);
  const seen = events();
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(8);
  const scripts = seen.filter((event) => event.kind === 'run').map((event) => event.script as string);
  expect(scripts).toHaveLength(2);
  expect(scripts.every((script) => script.includes('GATE_RESULT_FILE=.temp/gate/parts/'))).toBe(true);
  expect(scripts.every((script) => !script.includes('GATE_CONCURRENCY'))).toBe(true);

  const configured = scenario();
  const second = await runGate({ ...configured.env, GATE_CONCURRENCY: '2', GATE_REMOTE_SLOTS: '2' });
  expect(second.code, second.stderr).toBe(0);
  const forwarded = configured
    .events()
    .filter((event) => event.kind === 'run')
    .map((event) => event.script as string);
  expect(configured.events().filter((event) => event.kind === 'slot')).toHaveLength(4);
  expect(forwarded.every((script) => script.includes('GATE_CONCURRENCY=2'))).toBe(true);
});

test('a signal sent to the gate reaches the remote runs, which are cleaned up before the gate exits', async () => {
  const { env, events } = scenario();
  const child = spawnGate({ ...env, FAKE_HANG: '1', GATE_REMOTE_SLOTS: '4' });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let text = '';
  try {
    while (!text.includes('started')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } finally {
    child.kill('SIGTERM');
  }
  const [code, diagnostic] = await Promise.all([child.exited, stderr]);
  expect(text, diagnostic).toContain('started');
  expect(code, diagnostic).toBe(143);
  const seen = events();
  const stopped = seen.find((event) => event.kind === 'run-stopped');
  expect(stopped).toBeDefined();
  expect(seen.some((event) => event.kind === 'cleanup' && event.runId === stopped?.runId)).toBe(true);
});

test('missing, unreadable and empty host configuration fail closed before local installation', async () => {
  const localPath = (env: Record<string, string>) => ({ ...env, PATH: `${join(root, 'local')}:${env.PATH}` });

  const unset = scenario();
  const withoutRemote = { ...unset.env };
  delete withoutRemote.KERNEL_CHECK_REMOTE;
  const emptyCheckout = join(unset.dir, 'empty-checkout');
  mkdirSync(emptyCheckout);
  expect(Bun.spawnSync(['git', 'init', '--quiet', emptyCheckout]).exitCode).toBe(0);
  const first = await runGate(localPath(withoutRemote), emptyCheckout);
  expect(first.code).toBe(1);
  expect(first.stderr).toContain('no check host is configured');
  expect(unset.local()).toBe('');
  expect(unset.events()).toEqual([]);

  const forged = scenario();
  delete forged.env.KERNEL_CHECK_REMOTE;
  const forgedCheckout = join(forged.dir, 'empty-checkout');
  mkdirSync(forgedCheckout);
  expect(Bun.spawnSync(['git', 'init', '--quiet', forgedCheckout]).exitCode).toBe(0);
  const selected = await runGate(
    localPath({ ...forged.env, KERNEL_CHECK_ON_REMOTE: '1', REZICS_STACK_REMOTE: 'off' }),
    forgedCheckout,
    ['--workspaces', 'apps/web'],
  );
  expect(selected.code).toBe(1);
  expect(selected.stderr).toContain('no check host is configured');
  expect(forged.local()).toBe('');
  expect(forged.events()).toEqual([]);

  const unreadable = scenario();
  const third = await runGate(localPath({ ...unreadable.env, KERNEL_CHECK_REMOTE: join(root, 'no-such-hosts.json') }));
  expect(third.code).toBe(1);
  expect(third.stderr).toContain('is not readable');
  expect(unreadable.local()).toBe('');
  expect(unreadable.events()).toEqual([]);

  const empty = scenario();
  writeFileSync(empty.env.KERNEL_CHECK_REMOTE, JSON.stringify({ hosts: [] }));
  const fourth = await runGate(localPath(empty.env));
  expect(fourth.code).toBe(1);
  expect(fourth.stderr).toContain('lists no hosts');
  expect(empty.local()).toBe('');
  expect(empty.events()).toEqual([]);
});
