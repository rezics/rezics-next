import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgresContainer } from '../services/kernel/scripts/check.ts';
import {
  CHECK_SLOT_MEMORY_BYTES,
  CHECK_SLOT_PROCESSORS,
  controlSocketDirectoryPath,
  selectSlotClass,
} from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const kernel = join(repository, 'services/kernel');
const remoteCheck = join(repository, 'scripts/remote-check.ts');
const checkHost = join(repository, 'scripts/check-host');
const kernelFiles = ['test/access-hook.test.ts', 'test/admission.test.ts'];

// A fake ssh answers each kind of remote script by what it contains, so the tests see which host was chosen, what ran
// there and what was released, without a network.
const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const script = args.at(-1)!;
const address = args.at(-2)!;
const options = args.slice(0, -2);
const hostConfigs = JSON.parse(readFileSync(dir + '/config.json', 'utf8'));
const knownHost = Object.hasOwn(hostConfigs, address);
const config = hostConfigs[address] ?? {};
const controlPath = options.find((option) => option.startsWith('ControlPath='));
const updateConfig = (updates: Record<string, unknown>) => {
  const file = dir + '/config.json';
  const all = JSON.parse(readFileSync(file, 'utf8'));
  all[address] = { ...all[address], ...updates };
  writeFileSync(file, JSON.stringify(all));
};
const hostKey = address.replace(/[^a-z0-9]/gi, '_');
const count = (name: string) => {
  const file = dir + '/' + hostKey + '.' + name;
  const seen = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(seen + 1));
  return seen;
};
const connectionNumber = count('connection');
const refusedControlSession = Boolean(config.refuseControlSession && controlPath && connectionNumber > 0);
// OpenSSH 10.2 retries a refused multiplexed session over a new connection in the same ssh process.
const transport = refusedControlSession ? 'standalone-fallback' : controlPath ? 'control-master' : 'standalone';
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, options, transport, ...event }) + '\\n');
if (refusedControlSession) {
  log({ kind: 'master-session-refused' });
  log({ kind: 'standalone-fallback' });
}
if (script.includes('/proc/loadavg')) {
  if (!knownHost || config.down) process.exit(255);
  const configuredMaximum = config.memoryMax ?? Math.max(16 * 2 ** 30, config.available ?? 16 * 2 ** 30);
  const memoryMaximum = config.memoryUnreadable ? '-' : configuredMaximum;
  const memoryCurrent = config.memoryUnreadable
    ? '-'
    : (config.memoryCurrent ?? configuredMaximum - (config.memoryHeadroom ?? config.available ?? configuredMaximum));
  const memoryHeadroom = config.memoryUnreadable
    ? (config.available ?? 0)
    : configuredMaximum - Number(memoryCurrent);
  const processors = config.processors ?? 16;
  const sliceProcessors = config.cpuMaxUnreadable || config.cpuMaxIsMax
    ? (config.cpuQuotaPercent ?? 800) / 100
    : (config.sliceProcessors ?? (config.cpuQuotaPercent ?? 800) / 100);
  const load = config.load ?? 0;
  const slots = config.slots ?? 2;
  const ordinaryCapacity = Math.max(0, slots - 1);
  const ordinarySlotsUsed = Array.from({ length: ordinaryCapacity }, (_, index) => existsSync(dir + '/' + hostKey + '.slot.' + index)).filter(Boolean).length;
  const expressSlotUsed = existsSync(dir + '/' + hostKey + '.slot.express');
  const gateWaiting = existsSync(dir + '/' + hostKey + '.gate-marker');
  log({ kind: 'probe', script, processors, sliceProcessors, load, memoryCurrent, memoryMaximum, memoryHeadroom, ordinarySlotsUsed, expressSlotUsed, gateWaiting });
  console.log('MEMORY_CURRENT ' + memoryCurrent);
  console.log('MEMORY_MAX ' + memoryMaximum);
  console.log('MEMORY_HEADROOM ' + memoryHeadroom);
  console.log('PROCESSORS ' + processors);
  console.log('SLICE_PROCESSORS ' + sliceProcessors);
  console.log('LOAD ' + load);
  console.log('ORDINARY_SLOTS_USED ' + ordinarySlotsUsed);
  console.log('EXPRESS_SLOT_USED ' + (expressSlotUsed ? 1 : 0));
  console.log('GATE_WAITING ' + (gateWaiting ? 1 : 0));
} else if (script.includes('REMOTE_CHECK_GATE_MARKER')) {
  const lock = dir + '/' + hostKey + '.gate-marker';
  if (existsSync(lock)) process.exit(75);
  mkdirSync(lock);
  log({ kind: 'gate-marker', fakeStartedAt: Number(readFileSync(dir + '/clock', 'utf8')) });
  console.log('GATE_MARKER');
  const release = () => {
    rmSync(lock, { recursive: true, force: true });
    log({ kind: 'gate-marker-release' });
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const requested = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const slotClass = script.match(/# REMOTE_CHECK_SLOT_CLASS (ordinary|short)/)?.[1] ?? 'ordinary';
  const call = count('slot');
  if (call < (config.busy ?? 0)) {
    log({ kind: 'slot', granted: false, reason: 'busy', requested, call, slotClass, script });
    process.exit(75);
  }
  const grants = existsSync(dir + '/' + hostKey + '.granted')
    ? Number(readFileSync(dir + '/' + hostKey + '.granted', 'utf8'))
    : 0;
  if (config.grantOnly !== undefined && grants >= config.grantOnly) {
    log({ kind: 'slot', granted: false, reason: 'grant-limit', requested, call, slotClass, script });
    process.exit(75);
  }
  const capacity = config.slots ?? 2;
  const ordinaryCapacity = Number(
    script.match(/# REMOTE_CHECK_ORDINARY_COUNT (\\d+)/)?.[1] ?? Math.max(0, capacity - 1),
  );
  const ordinaryAdmissionLimit = Number(
    script.match(/# REMOTE_CHECK_ORDINARY_ADMISSION_LIMIT (\\d+)/)?.[1] ?? ordinaryCapacity,
  );
  const slotLimit = Number(script.match(/# REMOTE_CHECK_SLOT_LIMIT (\\d+)/)?.[1] ?? ordinaryCapacity);
  const occupied = Array.from({ length: ordinaryCapacity }, (_, index) => index).filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index));
  const expressOccupied = existsSync(dir + '/' + hostKey + '.slot.express');
  const taking = dir + '/' + hostKey + '.taking';
  if (existsSync(taking)) {
    log({ kind: 'slot', granted: false, reason: 'reserved', requested, call, slotClass, script });
    process.exit(75);
  }
  mkdirSync(taking);
  const hasBusyCountPass = script.includes('# REMOTE_CHECK_ORDINARY_BUSY_COUNT_PASS');
  const selected: Array<number | 'express'> = [];
  let occupiedCount = hasBusyCountPass ? occupied.length : 0;
  let ordinaryUsed = hasBusyCountPass ? occupied.length : 0;
  for (let index = 0; index < ordinaryCapacity; index += 1) {
    if (occupied.includes(index)) {
      if (!hasBusyCountPass) {
        occupiedCount += 1;
        ordinaryUsed += 1;
      }
    } else if (
      selected.length < requested &&
      (hasBusyCountPass ? ordinaryUsed + selected.length : ordinaryUsed) < ordinaryAdmissionLimit
    ) {
      selected.push(index);
      if (!hasBusyCountPass) ordinaryUsed += 1;
    }
  }
  if (slotClass === 'short' && selected.length < requested) {
    if (expressOccupied) occupiedCount += 1;
    else selected.push('express');
  }
  if (occupiedCount + selected.length > slotLimit || selected.length < requested) {
    rmSync(taking, { recursive: true, force: true });
    log({ kind: 'slot', granted: false, reason: 'capacity', requested, slotClass, script, occupied: occupiedCount, slotLimit, call });
    process.exit(75);
  }
  for (const slot of selected) mkdirSync(dir + '/' + hostKey + '.slot.' + slot);
  writeFileSync(dir + '/' + hostKey + '.granted', String(grants + selected.length));
  rmSync(taking, { recursive: true, force: true });
  for (const slot of selected) log({ kind: 'slot', granted: true, requested, slotClass, script, call, slot });
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
  const statusFile = dir + '/' + hostKey + '.status';
  if (!existsSync(statusFile)) process.exit(1);
  console.log(readFileSync(statusFile, 'utf8'));
} else if (script.includes('REMOTE_CHECK_RETURNS')) {
  const paths = [...script.matchAll(/^# PATH (.*)$/gm)].map((match) => match[1]);
  log({ kind: 'returns', paths });
  const present = new Set(config.present ?? []);
  for (const path of paths) console.log((present.has(path) ? 'PRESENT ' : 'ABSENT ') + path);
} else if (script.includes('systemd-run')) {
  const runNumber = count('run');
  const hang = Boolean(config.hang && runNumber < (config.hangRuns ?? Number.POSITIVE_INFINITY));
  if (hang && config.loadOnHang !== undefined) updateConfig({ load: config.loadOnHang });
  const fakeStartedAt = config.runDurationMs === undefined ? undefined : Number(readFileSync(dir + '/clock', 'utf8'));
  log({ kind: 'run', script, identity: args[args.indexOf('-i') + 1], fakeStartedAt });
  const host = address.slice(address.indexOf('@') + 1).replace(/\\.test$/, '');
  const statusFile = dir + '/' + hostKey + '.status';
  if (runNumber < (config.transportFailures ?? 0)) {
    rmSync(statusFile, { force: true });
    process.exit(255);
  }
  const result = config.exit ?? 0;
  writeFileSync(statusFile, String(result));
  if (script.includes('remote-check: bun install') && script.includes('remote-check: command')) {
    console.error('remote-check: bun install 0.125 s on ' + host);
    console.error('remote-check: command 0.250 s on ' + host);
  }
  if (config.stdout) console.log(config.stdout);
  if (config.stderr) console.error(config.stderr);
  if (hang) {
    console.log('started');
    process.on('SIGTERM', () => {
      if (config.loadAfterHang !== undefined) updateConfig({ load: config.loadAfterHang });
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  } else if (config.runDurationMs !== undefined) {
    const clock = dir + '/clock';
    const finishAt = fakeStartedAt! + config.runDurationMs;
    while (Number(readFileSync(clock, 'utf8')) < finishAt) await Bun.sleep(2);
    process.exit(result);
  } else process.exit(result);
} else {
  log({ kind: 'cleanup', script });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
const remote = args.find((argument) => /ops@[^:]+\\.test:/.test(argument));
const address = remote?.slice(0, remote.indexOf(':'));
const config = address ? JSON.parse(readFileSync(process.env.FAKE_DIR + '/config.json', 'utf8'))[address] ?? {} : {};
const rshIndex = args.indexOf('-e');
const code = config.rsyncExit ?? 0;
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination: args.at(-1),
  rsh: rshIndex >= 0 ? args[rshIndex + 1] : undefined,
  files: input.split('\\0').filter(Boolean),
  code,
}) + '\\n');
process.exit(code);
`;

const fakeDocker = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({ kind: 'docker', args: process.argv.slice(2) }) + '\\n');
process.exit(99);
`;

type Event = { kind: string; address?: string; [key: string]: unknown };
type HostConfig = {
  available?: number;
  memoryCurrent?: number;
  memoryMax?: number;
  memoryHeadroom?: number;
  memoryUnreadable?: boolean;
  processors?: number;
  sliceProcessors?: number;
  cpuMaxUnreadable?: boolean;
  cpuMaxIsMax?: boolean;
  loadOnHang?: number;
  loadAfterHang?: number;
  load?: number;
  cpuQuotaPercent?: number;
  memoryMaxGiB?: number;
  busy?: number;
  grantOnly?: number;
  slots?: number;
  ordinaryBusy?: number;
  expressBusy?: boolean;
  down?: boolean;
  exit?: number;
  transportFailures?: number;
  rsyncExit?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  hangRuns?: number;
  runDurationMs?: number;
  present?: string[];
  ordinaryBusySlots?: number[];
};

let root: string;
let counter = 0;

beforeAll(() => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  root = mkdtempSync(join(repository, '.temp/remote-check-test-'));
  mkdirSync(join(root, 'bin'));
  for (const [name, source] of [
    ['ssh', fakeSsh],
    ['rsync', fakeRsync],
    ['docker', fakeDocker],
  ] as const) {
    const file = join(root, 'bin', name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function scenario(hosts: Record<string, HostConfig>): { env: Record<string, string>; events: () => Event[] } {
  const dir = join(root, `scenario-${counter++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'clock'), '0');
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(Object.fromEntries(Object.entries(hosts).map(([name, config]) => [`ops@${name}.test`, config]))),
  );
  writeFileSync(
    join(dir, 'hosts.json'),
    JSON.stringify({
      hosts: Object.keys(hosts).map((name) => ({
        name,
        address: `ops@${name}.test`,
        identity: `/keys/${name}`,
        memoryMaxGiB: hosts[name].memoryMaxGiB ?? 16,
        cpuQuotaPercent: hosts[name].cpuQuotaPercent ?? 800,
        slots: hosts[name].slots ?? 2,
      })),
    }),
  );
  for (const [name, config] of Object.entries(hosts)) {
    const hostKey = `ops@${name}.test`.replace(/[^a-z0-9]/gi, '_');
    const occupiedSlots = config.ordinaryBusySlots ?? Array.from({ length: config.ordinaryBusy ?? 0 }, (_, index) => index);
    for (const index of occupiedSlots) mkdirSync(join(dir, `${hostKey}.slot.${index}`));
    if (config.expressBusy) mkdirSync(join(dir, `${hostKey}.slot.express`));
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    FAKE_DIR: dir,
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
    KERNEL_CHECK_REMOTE: join(dir, 'hosts.json'),
    REMOTE_CHECK_POLL_MS: '20',
  };
  delete env.GOAL_CHECK_WAIT_FILE;
  return {
    env,
    events: () => {
      const file = join(dir, 'log.jsonl');
      if (!existsSync(file)) return [];
      const contents = readFileSync(file, 'utf8');
      const completeContents = contents.endsWith('\n') ? contents : contents.slice(0, contents.lastIndexOf('\n') + 1);
      return completeContents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
    },
  };
}

function workspace(): string {
  const directory = mkdtempSync(join(root, 'workspace-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'node_modules/x'), { recursive: true });
  mkdirSync(join(directory, '.temp'));
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(directory, 'src/tracked.ts'), 'export {};\n');
  writeFileSync(join(directory, 'src/gone.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  rmSync(join(directory, 'src/gone.ts'));
  writeFileSync(join(directory, 'src/untracked.ts'), 'export {};\n');
  writeFileSync(join(directory, 'ignored.txt'), 'x');
  writeFileSync(join(directory, 'node_modules/x/index.js'), 'x');
  writeFileSync(join(directory, '.temp/scratch'), 'x');
  return directory;
}

async function remote(
  environment: Record<string, string>,
  directory: string,
  command: string[] = ['bun', 'test'],
  options: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = startRemote(environment, directory, command, options);
  const [code, stdout, stderr] = await Promise.all([run.child.exited, run.stdout, run.stderr]);
  return { code, stdout, stderr };
}

function startRemote(
  environment: Record<string, string>,
  directory: string,
  command: string[] = ['bun', 'test'],
  options: string[] = [],
): { child: ReturnType<typeof Bun.spawn>; stdout: Promise<string>; stderr: Promise<string> } {
  const child = Bun.spawn(['bun', remoteCheck, ...options, directory, '--', ...command], {
    cwd: repository,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

async function kernelCheck(
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'scripts/check.ts', ...kernelFiles], {
    cwd: kernel,
    env: environment,
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

test('a queue of long runs never delays a short run beyond one short run', () => {
  const shortDurationMs = 120_000;
  for (const queueLength of [1, 10, 100]) {
    const host = { ordinaryCapacity: 2, ordinaryUsed: 2, expressBusyUntil: shortDurationMs, now: 0 };
    const waitingLongRuns = Array.from({ length: queueLength }, () => ({
      slots: 1,
      estimateMs: undefined as number | undefined,
    }));

    for (const run of waitingLongRuns) {
      expect(selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, true, run.slots, run.estimateMs)).toBeNull();
    }

    const shortStartedAt = host.now;
    expect(
      selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, host.now >= host.expressBusyUntil, 1, shortDurationMs),
    ).toBeNull();
    host.now = host.expressBusyUntil;
    for (const run of waitingLongRuns) {
      expect(selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, true, run.slots, run.estimateMs)).toBeNull();
    }
    expect(
      selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, host.now >= host.expressBusyUntil, 1, shortDurationMs),
    ).toBe('express');
    expect(host.now - shortStartedAt).toBeLessThanOrEqual(shortDurationMs);
  }
});

test('a long or unestimated run never takes the express slot', async () => {
  for (const options of [[], ['--estimate-ms', '120001']]) {
    const ordinary = scenario({ a: { available: 20e9, slots: 2 } });
    expect((await remote(ordinary.env, workspace(), ['true'], options)).code).toBe(0);
    const admitted = ordinary.events().find((event) => event.kind === 'slot' && event.granted)!;
    expect(admitted.slotClass).toBe('ordinary');
    expect(admitted.script).not.toContain('/slots/express.lock');

    const { env, events } = scenario({ a: { available: 20e9, slots: 2, ordinaryBusy: 1 } });
    const pending = startRemote(env, workspace(), ['true'], options);
    try {
      await waitFor(() => events().some((event) => event.kind === 'probe'));
      await Bun.sleep(50);
      expect(events().filter((event) => event.kind === 'slot' && event.granted)).toEqual([]);
      expect(events().filter((event) => event.kind === 'run')).toEqual([]);
    } finally {
      pending.child.kill('SIGTERM');
      await pending.child.exited;
      await Promise.all([pending.stdout, pending.stderr]);
    }
  }
});

test('the gate never takes the express slot', async () => {
  const { env, events } = scenario({ a: { available: 20e9, slots: 4 } });
  const result = await remote(env, workspace(), ['true'], ['--gate', '--slots', '2']);
  expect(result.code).toBe(0);
  const takes = events().filter((event) => event.kind === 'slot' && event.granted);
  expect(takes).toHaveLength(2);
  expect(takes.every((event) => event.slotClass === 'ordinary')).toBe(true);
  expect(takes.every((event) => event.slot !== 'express')).toBe(true);
  expect(takes.every((event) => !String(event.script).includes('/slots/express.lock'))).toBe(true);
  expect(takes[0]?.script).toContain('# REMOTE_CHECK_SLOT_LIMIT 2');
});

test('a short run takes an ordinary free slot before the express slot', async () => {
  const ordinary = scenario({ a: { available: 20e9, slots: 2 } });
  expect((await remote(ordinary.env, workspace(), ['true'], ['--estimate-ms', '40'])).code).toBe(0);
  expect(ordinary.events().find((event) => event.kind === 'slot' && event.granted)).toMatchObject({
    slotClass: 'short',
    slot: 0,
  });
  expect(String(ordinary.events().find((event) => event.kind === 'probe')?.script)).toContain('ORDINARY_SLOTS_USED');
  expect(String(ordinary.events().find((event) => event.kind === 'probe')?.script)).toContain('EXPRESS_SLOT_USED');

  const express = scenario({ a: { available: 20e9, slots: 2, ordinaryBusy: 1 } });
  expect((await remote(express.env, workspace(), ['true'], ['--estimate-ms', '40'])).code).toBe(0);
  expect(express.events().find((event) => event.kind === 'slot' && event.granted)).toMatchObject({
    slotClass: 'short',
    slot: 'express',
  });
  expect(String(express.events().find((event) => event.kind === 'slot' && event.granted)?.script)).toContain(
    '/slots/express.lock',
  );
});

test('--estimate-ms is a non-negative integer of milliseconds', async () => {
  const valid = scenario({ a: { available: 20e9 } });
  const completed = await remote(valid.env, workspace(), ['true'], ['--estimate-ms', '0']);
  expect(completed.code).toBe(0);
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS 0',
  );

  for (const estimate of ['-1', '1.5', '9007199254740992', 'Infinity']) {
    const invalid = scenario({ a: { available: 20e9 } });
    const refused = await remote(invalid.env, workspace(), ['true'], ['--estimate-ms', estimate]);
    expect(refused.code, estimate).not.toBe(0);
    expect(refused.stderr, estimate).toContain('--estimate-ms');
    expect(invalid.events(), estimate).toEqual([]);
  }

  const missing = scenario({ a: { available: 20e9 } });
  const refused = await remote(missing.env, workspace(), ['true'], ['--estimate-ms']);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('--estimate-ms');
  expect(missing.events()).toEqual([]);
});

test("each remote run keeps Bun's transpiler cache inside its own run directory", async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  const work = workspace();

  expect((await remote(env, work, ['true'])).code).toBe(0);
  expect((await remote(env, work, ['true'])).code).toBe(0);

  const seen = events();
  const runDirectories = seen
    .filter((event) => event.kind === 'rsync')
    .map((event) => String(event.destination).match(/:(\/srv\/rezics-check\/runs\/[^/]+)\/$/)?.[1]);
  const scripts = seen.filter((event) => event.kind === 'run').map((event) => String(event.script));
  expect(runDirectories).toHaveLength(2);
  expect(runDirectories[0]).not.toBe(runDirectories[1]);
  expect(scripts).toHaveLength(2);

  for (const [index, script] of scripts.entries()) {
    const cachePath = script.match(/(?:^|\s)BUN_RUNTIME_TRANSPILER_CACHE_PATH=([^\s]+)/)?.[1];
    expect(cachePath).toBe(`${runDirectories[index]}/bun-runtime-transpiler-cache`);
  }
});

test('with KERNEL_CHECK_REMOTE set the kernel check selects its files locally and runs them on the host with the most free capacity', async () => {
  const { env, events } = scenario({ a: { available: 4e9 }, b: { available: 30e9 } });
  const result = await kernelCheck(env);

  expect(result.code).toBe(0);
  const seen = events();
  expect(seen.filter((event) => event.kind === 'docker')).toEqual([]);
  const sync = seen.find((event) => event.kind === 'rsync')!;
  expect(sync.destination).toStartWith('ops@b.test:/srv/rezics-check/runs/');
  const run = seen.find((event) => event.kind === 'run')!;
  expect(run.address).toBe('ops@b.test');
  expect(run.identity).toBe('/keys/b');
  const script = run.script as string;
  expect(script).toContain('systemd-run --scope');
  expect(script).toContain('--slice=rezics-check.slice');
  expect(script).toContain('KERNEL_CHECK_ON_REMOTE=1');
  expect(script).toContain('bun install --frozen-lockfile');
  expect(script).toContain(`bun scripts/check.ts ${kernelFiles.join(' ')}`);
  expect(script).toContain('services/kernel');
  expect(script.indexOf('bun install --frozen-lockfile')).toBeLessThan(script.indexOf('scripts/check.ts'));
  // The slot is released and the run directory removed.
  const kinds = seen.filter((event) => event.address === 'ops@b.test').map((event) => event.kind);
  expect(kinds.slice(-2)).toEqual(['cleanup', 'release']);
});

test('a host admits a slot only while its check slice has the memory and its processors the load for one more', async () => {
  const { env, events } = scenario({
    memory: {
      available: 64 * 2 ** 30,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: CHECK_SLOT_MEMORY_BYTES - 1,
      cpuQuotaPercent: 200,
      processors: 16,
      load: 0,
      slots: 4,
    },
    cpu: {
      available: 64 * 2 ** 30,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 2 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 8 - CHECK_SLOT_PROCESSORS + 0.01,
      slots: 4,
    },
    ready: {
      available: 1,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 400,
      processors: 16,
      load: 2 - CHECK_SLOT_PROCESSORS,
      slots: 4,
    },
  });
  const result = await remote(env, workspace());

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@ready.test:');
  const probe = events().find((event) => event.kind === 'probe')!.script as string;
  for (const reportedValue of [
    'nproc',
    '/proc/loadavg',
    'systemctl show --property=ControlGroup',
    'memory.current',
    'memory.max',
    'cpu.max',
    '/proc/meminfo',
  ])
    expect(probe).toContain(reportedValue);
  expect(
    events()
      .filter((event) => event.kind === 'slot')
      .map((event) => event.address),
  ).toEqual(['ops@ready.test']);
});

test('configured slots and slice resources bound the admission capacity', async () => {
  const { env, events } = scenario({
    a: {
      available: 64 * 2 ** 30,
      memoryMax: 64 * 2 ** 30,
      memoryHeadroom: 64 * 2 ** 30,
      cpuQuotaPercent: 1600,
      processors: 16,
      load: 0,
      slots: 1,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '2']);

  expect(result.code).toBe(64);
  expect(result.stderr).toContain('cap of 1');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(1);
  expect(events().some((event) => event.kind === 'slot')).toBe(false);
});

test('a request above half the smallest answering host capacity is refused before waiting', async () => {
  const { env, events } = scenario({
    small: { slots: 4, memoryMax: 16 * 2 ** 30, memoryHeadroom: 16 * 2 ** 30, cpuQuotaPercent: 800 },
    large: { slots: 8, memoryMax: 48 * 2 ** 30, memoryHeadroom: 48 * 2 ** 30, cpuQuotaPercent: 1600 },
  });
  const directory = workspace();
  const result = await remote(env, directory, ['true'], ['--slots', '3']);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain('cap of 2');
  expect(result.stderr).toContain("lower the run's concurrency to match");
  expect(result.stderr).not.toContain('waiting for a free one');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(2);
  expect(events().some((event) => event.kind === 'slot')).toBe(false);

  const libraryCall = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { readHosts, remoteCheck, SlotRequestTooLarge } from ${JSON.stringify(remoteCheck)};
try {
  await remoteCheck({ hosts: readHosts(process.env.KERNEL_CHECK_REMOTE), workspace: ${JSON.stringify(directory)}, command: ['true'], slots: 3, pollMs: 20 }, new AbortController().signal);
  process.exit(2);
} catch (error) {
  if (error instanceof SlotRequestTooLarge) process.exit(0);
  console.error(error);
  process.exit(1);
}`,
    ],
    { cwd: repository, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  );
  const [libraryCode, libraryError] = await Promise.all([libraryCall.exited, new Response(libraryCall.stderr).text()]);
  expect(libraryCode, libraryError).toBe(0);
});

test('a remote slot wait is appended to GOAL_CHECK_WAIT_FILE while it is still waiting', async () => {
  const { env, events } = scenario({ a: { available: 8 * 2 ** 30, slots: 2, busy: 12 } });
  const waitFile = join(env.FAKE_DIR!, 'goal-check-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  env.REMOTE_CHECK_POLL_MS = '20';
  const run = startRemote(env, workspace(), ['true']);

  await waitFor(
    () => existsSync(waitFile) && events().filter((event) => event.kind === 'slot' && !event.granted).length > 0,
  );
  const whileWaiting = readFileSync(waitFile, 'utf8');
  expect(run.child.exitCode).toBeNull();
  await Bun.sleep(60);
  const whileStillWaiting = readFileSync(waitFile, 'utf8');
  expect(whileStillWaiting.length).toBeGreaterThanOrEqual(whileWaiting.length);

  const [code, ,] = await Promise.all([run.child.exited, run.stdout, run.stderr]);
  expect(code).toBe(0);
  const lines = readFileSync(waitFile, 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => /^\d+$/.test(line) && Number(line) > 0 && Number(line) <= 60_000)).toBe(true);
});

test('without GOAL_CHECK_WAIT_FILE no wait is recorded', async () => {
  const { env } = scenario({ a: { available: 8 * 2 ** 30, slots: 2, busy: 4 } });
  const waitFile = join(env.FAKE_DIR!, 'goal-check-wait-ms');
  delete env.GOAL_CHECK_WAIT_FILE;
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(existsSync(waitFile)).toBe(false);
});

test('acquisition prefers the host with the most free capacity', async () => {
  const { env, events } = scenario({
    a: {
      available: 64 * 2 ** 30,
      memoryMax: 8 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 8 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 8 - CHECK_SLOT_PROCESSORS + 0.01,
      slots: 4,
    },
    b: {
      available: 1,
      memoryMax: 4 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 4 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 8 - 3 * CHECK_SLOT_PROCESSORS,
      slots: 4,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '2']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@b.test:');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(2);
  const granted = events().filter((event) => event.kind === 'slot' && event.address === 'ops@b.test' && event.granted);
  expect(granted).toHaveLength(2);
  expect(new Set(granted.map((event) => event.call)).size).toBe(1);
});

test('an unreadable check slice memory limit falls back to MemAvailable', async () => {
  const { env, events } = scenario({
    a: {
      available: CHECK_SLOT_MEMORY_BYTES,
      memoryUnreadable: true,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 0,
    },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'probe')).toMatchObject({
    memoryCurrent: '-',
    memoryMaximum: '-',
    memoryHeadroom: CHECK_SLOT_MEMORY_BYTES,
  });
  expect(events().find((event) => event.kind === 'run')!.address).toBe('ops@a.test');
});

test("the remote run's output streams back and its exit code becomes the local exit code", async () => {
  const { env, events } = scenario({
    a: { available: 8e9, exit: 7, stdout: 'remote says hello', stderr: 'remote complains' },
  });
  const directory = workspace();
  const result = await remote(env, directory, ['bun', 'test'], ['--cwd', 'src']);

  expect(result.code).toBe(7);
  expect(result.stdout).toContain('remote says hello');
  expect(result.stderr).toContain('remote complains');
  const seen = events();
  const script = seen.find((event) => event.kind === 'run')!.script as string;
  expect(script).toMatch(/\/srv\/rezics-check\/runs\/[a-z0-9-]+/);
  expect(script).toContain('src bun test');
  const files = (seen.find((event) => event.kind === 'rsync')!.files as string[]).sort();
  expect(files).toEqual(['.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
  const cleanup = seen.find((event) => event.kind === 'cleanup')!.script as string;
  expect(cleanup).toContain('rm -rf');
  expect(cleanup).toMatch(/\/srv\/rezics-check\/runs\/[a-z0-9-]+/);
});

test("a remote run whose connection drops before the command's exit status arrives ends with the transport failure code", async () => {
  const { env, events } = scenario({ a: { available: 8e9, transportFailures: 1 } });
  const result = await remote(env, workspace());

  expect(result.code).toBe(75);
  expect(result.stderr).toContain('connection to a failed during remote command before a result');
  expect(events().filter((event) => event.kind === 'status')).toHaveLength(1);
});

test('a remote command that itself exits 255 keeps its exit code', async () => {
  const { env, events } = scenario({ a: { available: 8e9, exit: 255 } });
  const result = await remote(env, workspace());

  expect(result.code).toBe(255);
  expect(result.stderr).not.toContain('before a result');
  expect(events().filter((event) => event.kind === 'status')).toHaveLength(1);
});

test('rsync connection errors are reported as transport failures before the command runs', async () => {
  for (const exit of [12, 30, 35, 255]) {
    const { env, events } = scenario({ a: { available: 8e9, rsyncExit: exit } });
    const result = await remote(env, workspace());

    expect(result.code).toBe(75);
    expect(result.stderr).toContain('connection to a failed during workspace upload before a result');
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(0);
  }
});

test('a host with no free slot is skipped and with none free the check waits', async () => {
  const skipped = scenario({ a: { available: 4e9 }, b: { available: 30e9, busy: 1000 } });
  const first = await remote(skipped.env, workspace());
  expect(first.code).toBe(0);
  expect(first.stderr).not.toContain('waiting');
  const seen = skipped.events();
  expect(seen.find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@a.test:');
  expect(
    seen
      .filter((event) => event.kind === 'slot' && event.address === 'ops@b.test')
      .map(({ kind, granted }) => ({ kind, granted })),
  ).toEqual([{ kind: 'slot', granted: false }]);

  const waiting = scenario({ a: { available: 4e9, busy: 3 }, b: { available: 30e9, busy: 3 } });
  const second = await remote(waiting.env, workspace());
  expect(second.code).toBe(0);
  expect(second.stderr.match(/waiting/gi)?.length).toBe(1);
  const waited = waiting.events();
  expect(waited.filter((event) => event.kind === 'slot' && event.granted === false).length).toBe(6);
  expect(waited.filter((event) => event.kind === 'run').length).toBe(1);
});

test('a host that cannot be reached is skipped', async () => {
  const { env, events } = scenario({ a: { available: 4e9 }, b: { down: true } });
  const result = await remote(env, workspace());
  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@a.test:');
});

test('all ssh and rsync connections to a host share one control master', async () => {
  const { env, events } = scenario({ a: { available: 4e9, exit: 255, present: ['result.txt'] } });
  expect(controlSocketDirectoryPath(undefined, 124)).toBe('/tmp/rezics-ssh-124');
  expect(controlSocketDirectoryPath(undefined, undefined, 124)).toBe('/tmp/rezics-ssh-124');
  expect(controlSocketDirectoryPath(env.XDG_RUNTIME_DIR, 124)).toBe(join(env.XDG_RUNTIME_DIR!, 'rezics-ssh'));
  const result = await remote(env, workspace(), ['true'], ['--returns', 'result.txt']);
  expect(result.code).toBe(255);

  const sshEvents = events().filter((event) => event.kind !== 'rsync');
  const expectedControlPath = `ControlPath=${env.XDG_RUNTIME_DIR}/rezics-ssh/%C`;
  expect(sshEvents.map((event) => event.kind)).toEqual([
    'probe',
    'slot',
    'run',
    'status',
    'returns',
    'cleanup',
    'release',
  ]);
  for (const event of sshEvents) {
    const options = event.options as string[];
    expect(options).toContain('ControlMaster=auto');
    expect(options).toContain('ControlPersist=10m');
    expect(options.filter((option) => option.startsWith('ControlPath='))).toEqual([expectedControlPath]);
  }

  const rsyncEvents = events().filter((event) => event.kind === 'rsync');
  expect(rsyncEvents).toHaveLength(2);
  for (const event of rsyncEvents) {
    expect(event.rsh as string).toContain('ControlMaster=auto');
    expect(event.rsh as string).toContain('ControlPersist=10m');
    expect(event.rsh as string).toContain(expectedControlPath);
  }

  const controlDirectory = join(env.XDG_RUNTIME_DIR!, 'rezics-ssh');
  expect(statSync(controlDirectory).mode & 0o777).toBe(0o700);
  await remote(env, workspace(), ['true']);
  const repeated = events()
    .filter((event) => event.kind === 'probe')
    .at(-1)!;
  expect((repeated.options as string[]).filter((option) => option.startsWith('ControlPath='))).toEqual([
    expectedControlPath,
  ]);
});

test('a control master session refusal falls back to its own connection', async () => {
  const { env, events } = scenario({ a: { available: 4e9, refuseControlSession: true } });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  const seen = events();
  const probe = seen.find((event) => event.kind === 'probe')!;
  const refusedAt = seen.findIndex((event) => event.kind === 'master-session-refused');
  const fallbackAt = seen.findIndex((event) => event.kind === 'standalone-fallback');
  expect(probe.transport).toBe('control-master');
  expect(refusedAt).toBeGreaterThan(seen.indexOf(probe));
  expect(fallbackAt).toBeGreaterThan(refusedAt);
  expect(seen.find((event) => event.kind === 'run')!.transport).toBe('standalone-fallback');
  expect(seen.find((event) => event.kind === 'cleanup')!.transport).toBe('standalone-fallback');
});

function provisionScenario(existing?: string) {
  const directory = mkdtempSync(join(root, 'provision-'));
  const bin = join(directory, 'bin');
  const config = join(directory, '90-rezics-checks.conf');
  const log = join(directory, 'events.jsonl');
  mkdirSync(bin);
  mkdirSync(join(directory, 'work'));
  const identity = join(directory, 'identity');
  writeFileSync(identity, 'fake identity');
  if (existing !== undefined) writeFileSync(config, existing);
  const commands = {
    ssh: `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = await Bun.stdin.text();
writeFileSync(process.env.PROVISION_RECEIVED!, source);
const header = source.slice(0, source.indexOf('export DEBIAN_FRONTEND'));
const start = source.indexOf('sshd_config_dir=');
const end = source.indexOf('\\necho "chromium', start);
const block = source.slice(start, end).replace('sshd_config_dir=/etc/ssh/sshd_config.d', 'sshd_config_dir=$PROVISION_DIRECTORY');
const args = process.argv.slice(process.argv.indexOf('--') + 1);
const result = spawnSync('bash', ['-c', header + block, 'provision-test', ...args], { env: process.env, encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
    sshd: `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.PROVISION_LOG!, JSON.stringify({ command: 'sshd', args: process.argv.slice(2), config: readFileSync(process.env.PROVISION_CONFIG!, 'utf8') }) + '\\n');
process.exit(Number(process.env.PROVISION_VALIDATION_EXIT ?? 0));
`,
    systemctl: `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PROVISION_LOG!, JSON.stringify({ command: 'systemctl', args: process.argv.slice(2) }) + '\\n');
`,
  };
  for (const [name, source] of Object.entries(commands)) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const received = join(directory, 'received');
  return {
    config,
    received,
    events: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    run: (exemptions?: string, validationExit = 0) =>
      spawnSync(
        'bash',
        [
          join(repository, 'scripts/provision-check-host.sh'),
          'root@check.test',
          identity,
          '16',
          '800',
          ...(exemptions === undefined ? [] : [exemptions]),
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            PROVISION_DIRECTORY: directory,
            PROVISION_CONFIG: config,
            PROVISION_LOG: log,
            PROVISION_RECEIVED: received,
            PROVISION_VALIDATION_EXIT: String(validationExit),
            work: join(directory, 'work'),
          },
          encoding: 'utf8',
          timeout: 20_000,
        },
      ),
  };
}

test('provision-check-host installs and validates the sshd limits before reloading sshd', () => {
  const identity = join(root, 'provision-identity');
  const bin = join(root, 'provision-bin');
  const received = join(root, 'provision-remote-script');
  mkdirSync(bin, { recursive: true });
  writeFileSync(identity, 'fake identity');
  const ssh = join(bin, 'ssh');
  writeFileSync(
    ssh,
    `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROVISION_SCRIPT_FILE!, await Bun.stdin.text());\n`,
  );
  chmodSync(ssh, 0o755);
  const result = spawnSync(
    'bash',
    [join(repository, 'scripts/provision-check-host.sh'), 'root@check.test', identity, '16', '800'],
    {
      cwd: repository,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROVISION_SCRIPT_FILE: received },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );

  expect(result.status).toBe(0);
  const sent = readFileSync(received, 'utf8');
  expect(sent).toContain('sshd_dropin=$sshd_config_dir/90-rezics-checks.conf');
  expect(sent).toContain("sshd_wanted=$(printf 'MaxStartups 100:30:300\\nMaxSessions 64')");
  expect(sent).toContain('sshd_candidate=$(mktemp "$sshd_config_dir/.90-rezics-checks.XXXXXX")');
  expect(sent).toContain('if sshd -t; then');
  const validationStart = sent.indexOf('if sshd -t; then');
  const validationElse = sent.indexOf('\nelse\n', validationStart);
  const validationEnd = sent.indexOf('\nfi\n', validationElse);
  expect(validationElse).toBeGreaterThan(validationStart);
  expect(validationEnd).toBeGreaterThan(validationElse);
  expect(sent.slice(validationStart, validationElse)).toContain('systemctl reload ssh');
  expect(sent.slice(validationElse, validationEnd)).not.toContain('systemctl reload ssh');
  expect(sent).toContain('sshd configuration validation failed; sshd was not reloaded');
});

test('provision-check-host removes and reports the old shared runtime transpiler caches', () => {
  const fixture = provisionScenario();
  expect(fixture.run().status).toBe(0);

  const sent = readFileSync(fixture.received, 'utf8');
  expect(sent).toContain('/root/.bun/install/cache/@t@');
  expect(sent).toContain('/srv/rezics-check/bun-cache/@t@');
  expect(sent).toContain('rm -rf -- "$cache"');
  expect(sent).toContain('removed legacy Bun runtime transpiler caches (if present)');
  expect(sent.indexOf('legacy_transpiler_caches=')).toBeLessThan(sent.indexOf('bun x "playwright@'));
});

test('provision-check-host writes the whole sshd drop-in with the penalty exemptions it is given', () => {
  const previous = 'MaxStartups 10:30:100\nPerSourcePenaltyExemptList 192.0.2.0/24\n# obsolete\n';
  const fixture = provisionScenario(previous);
  const exemptions = '192.0.2.1/32,2001:db8::/32';
  const wanted = `MaxStartups 100:30:300\nMaxSessions 64\nPerSourcePenaltyExemptList ${exemptions}\n`;
  expect(fixture.run(exemptions).status).toBe(0);
  expect(readFileSync(fixture.config, 'utf8')).toBe(wanted);
  expect(statSync(fixture.config).mode & 0o777).toBe(0o644);
  expect(fixture.events()).toEqual([
    { command: 'sshd', args: ['-t'], config: wanted },
    { command: 'systemctl', args: ['reload', 'ssh'] },
  ]);
  expect(fixture.run(exemptions).status).toBe(0);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);

  writeFileSync(fixture.config, previous);
  expect(fixture.run(exemptions, 1).status).toBe(1);
  expect(readFileSync(fixture.config, 'utf8')).toBe(previous);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);
  const absent = provisionScenario();
  expect(absent.run(exemptions, 1).status).toBe(1);
  expect(existsSync(absent.config)).toBe(false);
});

test('provision-check-host keeps an existing penalty exemption list when it is given none', () => {
  const exemptionLine = '\tPeRsOuRcEpEnAlTyExEmPtLiSt  192.0.2.0/24,2001:db8::/32 # access\t';
  const fixture = provisionScenario(`MaxStartups 10:30:100\n${exemptionLine}\n# obsolete\n`);
  const wanted = `MaxStartups 100:30:300\nMaxSessions 64\n${exemptionLine}\n`;
  expect(fixture.run().status).toBe(0);
  expect(readFileSync(fixture.config, 'utf8')).toBe(wanted);
  expect(fixture.events()).toEqual([
    { command: 'sshd', args: ['-t'], config: wanted },
    { command: 'systemctl', args: ['reload', 'ssh'] },
  ]);
  expect(fixture.run().status).toBe(0);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);

  const absent = provisionScenario();
  expect(absent.run().status).toBe(0);
  expect(readFileSync(absent.config, 'utf8')).toBe('MaxStartups 100:30:300\nMaxSessions 64\n');
});

test('provision-check-host validates every penalty exemption CIDR before connecting', () => {
  for (const exemptions of [
    '',
    '192.0.2.0',
    '192.0.2.256/24',
    '192.0.02.0/24',
    '192.0.2.0/33',
    '192.0.2.0/-1',
    '2001:db8::/129',
    '2001:db8::/x',
    '2001:db8:::1/32',
    '2001::db8::1/32',
    '2001:db8/32',
    '2001:db8:0:0:0:0:0:0:1/32',
    '2001:db8::g/32',
    '::ffff:192.0.2.256/128',
    '192.0.2.0/24,',
    ',192.0.2.0/24',
    '192.0.2.0/24,,2001:db8::/32',
    '192.0.2.0/24,2001:db8::/129',
    '192.0.2.0/24\nMaxSessions 1',
    '192.0.2.0/24/1',
  ]) {
    const fixture = provisionScenario();
    const result = fixture.run(exemptions);
    expect(result.status, exemptions).toBe(2);
    expect(result.stderr).toContain('bad penalty exemption CIDR:');
    expect(existsSync(fixture.received)).toBe(false);
  }
  for (const exemptions of [
    '192.0.2.0/0',
    '192.0.2.1/32',
    '2001:db8::/0',
    '2001:db8::1/128',
    '2001:DB8:0:0:0:0:0:1/128',
    '::/128',
    '::ffff:192.0.2.1/128',
    '2001:db8:0:0:0:0:192.0.2.1/128',
  ]) {
    const fixture = provisionScenario();
    const result = fixture.run(exemptions);
    expect(result.status, `${exemptions}: ${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.config, 'utf8')).toContain(`PerSourcePenaltyExemptList ${exemptions}\n`);
  }
});

test('SIGTERM stops the run, removes its directory and releases the slot', async () => {
  const { env, events } = scenario({ a: { available: 4e9, hang: true } });
  const child = Bun.spawn(['bun', remoteCheck, workspace(), '--', 'bun', 'test'], {
    cwd: repository,
    env,
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
  const kinds = events()
    .filter((event) => event.address === 'ops@a.test')
    .map((event) => event.kind);
  expect(kinds.slice(-2)).toEqual(['cleanup', 'release']);
  expect(events().find((event) => event.kind === 'cleanup')!.script as string).toContain('systemctl stop');
});

test('containers started on a check host run under its capped cgroup slice', () => {
  const previous = process.env.KERNEL_CHECK_ON_REMOTE;
  process.env.KERNEL_CHECK_ON_REMOTE = '1';
  try {
    let args: string[] = [];
    startPostgresContainer((given) => ((args = given), 'id'));
    expect(args).toContain('--cgroup-parent=rezics-check.slice');
    const search = spawnSync(
      'bun',
      [
        '-e',
        "import { searchRunArgs } from './services/kernel/scripts/search.ts'; console.log(JSON.stringify(searchRunArgs('image')))",
      ],
      {
        cwd: repository,
        env: { ...process.env, KERNEL_CHECK_ON_REMOTE: '1' },
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(search.stdout) as string[]).toContain('--cgroup-parent=rezics-check.slice');
  } finally {
    if (previous === undefined) delete process.env.KERNEL_CHECK_ON_REMOTE;
    else process.env.KERNEL_CHECK_ON_REMOTE = previous;
  }
});

test('a remote run takes all requested slots in one session on one host and releases them all', async () => {
  // b and a have one resource-backed slot each; c has enough resources after three failed takes.
  const { env, events } = scenario({
    a: { available: 4e9, slots: 4 },
    b: { available: 4e9, slots: 4 },
    c: { available: 30e9, slots: 4, busy: 3 },
  });
  const result = await remote(env, workspace(), ['bun', 'test'], ['--slots', '2']);
  expect(result.code).toBe(0);

  const seen = events();
  const on = (host: string) => seen.filter((event) => event.address === `ops@${host}.test`);
  // b and a cannot serve this run; c wins by available memory and takes both slots in one SSH session.
  expect(on('b').filter((event) => event.kind === 'slot')).toEqual([]);
  expect(on('c').filter((event) => event.kind === 'reservation')).toHaveLength(0);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === false)).toHaveLength(3);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === true)).toHaveLength(2);
  // c holds both slots for the whole run and drops them after the run directory is removed.
  const kinds = on('c').map((event) => event.kind);
  expect(
    on('c')
      .filter((event) => event.kind === 'slot')
      .map((event) => event.granted),
  ).toEqual([false, false, false, true, true]);
  const successfulTakes = on('c').filter((event) => event.kind === 'slot' && event.granted);
  expect(new Set(successfulTakes.map((event) => event.call)).size).toBe(1);
  expect(kinds.indexOf('run')).toBeGreaterThan(kinds.lastIndexOf('slot'));
  expect(kinds.slice(-3)).toEqual(['cleanup', 'release', 'release']);
  expect(seen.filter((event) => event.kind === 'run')).toHaveLength(1);

  // Without the flag a run holds one slot, and a count no host can serve is refused rather than waited for.
  const single = scenario({ a: { available: 4e9 } });
  expect((await remote(single.env, workspace())).code).toBe(0);
  expect(single.events().filter((event) => event.kind === 'slot')).toHaveLength(1);
  const tooMany = scenario({ a: { available: 4e9 } });
  const refused = await remote(tooMany.env, workspace(), ['bun', 'test'], ['--slots', '3']);
  expect(refused.code).toBe(64);
  expect(refused.stderr).toContain("lower the run's concurrency to match");
  expect(tooMany.events().some((event) => event.kind === 'slot')).toBe(false);
});

test('single-slot runs keep starting on a host while a multi-slot run waits for it', async () => {
  const { env, events } = scenario({
    a: { available: 0, slots: 4, cpuQuotaPercent: 800 },
    b: { available: 20e9, slots: 4, cpuQuotaPercent: 800, hang: true, hangRuns: 1, loadOnHang: 6, loadAfterHang: 0 },
  });
  const waitFile = join(env.FAKE_DIR!, 'multi-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multi: ReturnType<typeof startRemote> | undefined;
  let laterSingle: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@b.test'));
    multi = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => existsSync(waitFile));
    expect(events().filter((event) => event.kind === 'slot' && event.requested === 2)).toHaveLength(0);

    laterSingle = startRemote(env, workspace(), ['true']);
    await waitFor(
      () => events().filter((event) => event.kind === 'run' && event.address === 'ops@b.test').length === 2,
    );
    expect(await laterSingle.child.exited).toBe(0);
    expect(
      events().filter((event) => event.kind === 'slot' && event.address === 'ops@b.test' && event.granted),
    ).toHaveLength(2);

    first.child.kill('SIGTERM');
    await first.child.exited;
    expect(await multi.child.exited).toBe(0);
    const onB = events().filter((event) => event.address === 'ops@b.test');
    expect(onB.filter((event) => event.kind === 'run')).toHaveLength(3);
    expect(onB.some((event) => event.kind === 'reservation')).toBe(false);
  } finally {
    for (const run of [laterSingle, multi, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a multi-slot waiter takes all slots or none and holds no slot or reservation while waiting', async () => {
  const { env, events } = scenario({
    a: { available: 20e9, slots: 4, hang: true, hangRuns: 1, loadOnHang: 6, loadAfterHang: 0 },
  });
  const waitFile = join(env.FAKE_DIR!, 'multi-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multi: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run'));
    multi = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => existsSync(waitFile));
    const waiting = events();
    expect(waiting.filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(waiting.filter((event) => event.kind === 'slot' && event.requested === 2)).toHaveLength(0);
    expect(waiting.some((event) => event.kind === 'reservation')).toBe(false);
    multi.child.kill('SIGTERM');
    expect(await multi.child.exited).toBe(143);
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(events().some((event) => event.kind === 'reservation')).toBe(false);
    first.child.kill('SIGTERM');
    await first.child.exited;
  } finally {
    for (const run of [multi, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('while a gate waits for a host, runs there use only the slots the gate leaves free', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, hang: true, hangRuns: 1 } });
  mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
  const workspaceDirectory = workspace();
  const multi = startRemote(env, workspaceDirectory, ['true'], ['--slots', '2']);
  let remainder: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'probe'));
    expect(events().some((event) => event.kind === 'run')).toBe(false);

    remainder = startRemote(env, workspaceDirectory, ['true']);
    await waitFor(() => events().some((event) => event.kind === 'run'));
    await waitFor(() => events().filter((event) => event.kind === 'probe').length >= 5);
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(1);
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(remainder.child.exitCode).toBeNull();
    expect(multi.child.exitCode).toBeNull();
  } finally {
    for (const run of [remainder, multi]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('while a gate waits for a host, a short run may take its express slot', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, ordinaryBusy: 1 } });
  mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
  const result = await remote(env, workspace(), ['true'], ['--estimate-ms', '120000']);
  expect(result.code).toBe(0);
  const admitted = events().find((event) => event.kind === 'slot' && event.granted)!;
  expect(admitted.slotClass).toBe('short');
  expect(admitted.slot).toBe('express');
});

test('a short run never takes an ordinary slot beyond the remainder on a gated host, whichever slot index is free', async () => {
  for (const freeSlot of [0, 1, 2, 3, 4]) {
    const { env, events } = scenario({
      b: {
        available: 20e9,
        cpuQuotaPercent: 1600,
        slots: 6,
        ordinaryBusySlots: [0, 1, 2, 3, 4].filter((index) => index !== freeSlot),
      },
    });
    mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
    const result = await remote(env, workspace(), ['true'], ['--estimate-ms', '120000']);
    expect(result.code).toBe(0);
    const admitted = events().find((event) => event.kind === 'slot' && event.granted)!;
    expect(admitted).toMatchObject({ slotClass: 'short', slot: 'express' });
    expect(admitted.script).toContain('# REMOTE_CHECK_ORDINARY_ADMISSION_LIMIT 1');
  }
});

test('gates waiting on every host still drain their hosts', async () => {
  const { env, events } = scenario({
    a: { available: 20e9, slots: 4, hang: true, hangRuns: 1 },
    b: { available: 20e9, slots: 4, hang: true, hangRuns: 1 },
  });
  for (const host of ['a', 'b']) mkdirSync(join(env.FAKE_DIR!, `ops_${host}_test.gate-marker`));
  const runs = Array.from({ length: 4 }, () => startRemote(env, workspace(), ['true']));
  try {
    await waitFor(() => events().filter((event) => event.kind === 'run').length === 2);
    await waitFor(() => events().filter((event) => event.kind === 'probe').length >= 12);
    const started = events().filter((event) => event.kind === 'run');
    expect(started.map((event) => event.address).sort()).toEqual(['ops@a.test', 'ops@b.test']);
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(2);
  } finally {
    for (const run of runs) {
      try {
        run.child.kill('SIGTERM');
      } catch {}
    }
    for (const run of runs) {
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a gate wait is bounded by its original slot holders with 1, 10 and 100 queued runs', async () => {
  const durationMs = 10;
  for (const queueLength of [1, 10, 100]) {
    const { env, events } = scenario({
      b: { available: 20e9, slots: 4, runDurationMs: durationMs },
    });
    const workspaceDirectory = workspace();
    const holders = Array.from({ length: 2 }, () =>
      startRemote(env, workspaceDirectory, ['sh', '-c', 'echo holder']),
    );
    let gate: ReturnType<typeof startRemote> | undefined;
    const queued: ReturnType<typeof startRemote>[] = [];
    try {
      await waitFor(
        () => events().filter((event) => event.kind === 'run' && String(event.script).includes('echo holder')).length === 2,
        15_000,
      );
      const originalHolders = events().filter(
        (event) => event.kind === 'run' && String(event.script).includes('echo holder'),
      );
      const latestOriginalFinish = Math.max(...originalHolders.map((event) => Number(event.fakeStartedAt) + durationMs));

      gate = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo gate-run'], ['--gate', '--slots', '2']);
      await waitFor(() => events().some((event) => event.kind === 'gate-marker' && event.address === 'ops@b.test'));
      const marker = events().find((event) => event.kind === 'gate-marker')!;
      const gateWaitingBeganAt = Number(marker.fakeStartedAt);
      await waitFor(
        () => events().some((event) => event.kind === 'probe' && event.address === 'ops@b.test' && event.gateWaiting),
      );

      for (let index = 0; index < queueLength; index += 1) {
        const queueEnv = {
          ...env,
          GOAL_CHECK_WAIT_FILE: join(env.FAKE_DIR!, `queued-${index}-wait-ms`),
        };
        queued.push(startRemote(queueEnv, workspaceDirectory, ['sh', '-c', 'echo queued']));
      }
      await waitFor(
        () => queued.every((_, index) => existsSync(join(env.FAKE_DIR!, `queued-${index}-wait-ms`))),
        30_000,
      );
      expect(events().filter((event) => event.kind === 'run')).toHaveLength(2);

      writeFileSync(join(env.FAKE_DIR!, 'clock'), String(latestOriginalFinish));
      await waitFor(
        () => events().some((event) => event.kind === 'run' && String(event.script).includes('echo gate-run')),
        15_000,
      );
      const gateStart = events().find(
        (event) => event.kind === 'run' && String(event.script).includes('echo gate-run'),
      )!;
      expect(Number(gateStart.fakeStartedAt)).toBeLessThanOrEqual(latestOriginalFinish);
      expect(Number(gateStart.fakeStartedAt) - gateWaitingBeganAt).toBeLessThanOrEqual(durationMs);
    } finally {
      for (const run of [...queued, gate, ...holders]) {
        if (!run) continue;
        try {
          run.child.kill('SIGTERM');
        } catch {}
      }
      for (const run of [...queued, gate, ...holders]) {
        if (!run) continue;
        await run.child.exited;
        await Promise.all([run.stdout, run.stderr]);
      }
    }
  }
});

test('while a gate waits for a host, single-slot runs prefer other hosts', async () => {
  const { env, events } = scenario({
    a: { available: 20e9, slots: 2, cpuQuotaPercent: 400 },
    b: { available: 20e9, slots: 4, cpuQuotaPercent: 800, hang: true, hangRuns: 1, loadOnHang: 6, loadAfterHang: 0 },
  });
  const waitFile = join(env.FAKE_DIR!, 'gate-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let gateRun: ReturnType<typeof startRemote> | undefined;
  let single: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@b.test'));
    gateRun = startRemote(env, workspace(), ['true'], ['--gate', '--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'gate-marker' && event.address === 'ops@b.test'));
    await waitFor(() =>
      events().some((event) => event.kind === 'probe' && event.address === 'ops@b.test' && event.gateWaiting === true),
    );
    await waitFor(() => existsSync(waitFile));

    single = startRemote(env, workspace(), ['true']);
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@a.test'));
    expect(await single.child.exited).toBe(0);
    expect(
      events().find((event) => event.kind === 'rsync' && String(event.destination).startsWith('ops@a.test:')),
    ).toBeDefined();

    gateRun.child.kill('SIGTERM');
    expect(await gateRun.child.exited).toBe(143);
    await waitFor(() =>
      events().some((event) => event.kind === 'gate-marker-release' && event.address === 'ops@b.test'),
    );
    first.child.kill('SIGTERM');
    await first.child.exited;
  } finally {
    for (const run of [single, gateRun, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a remote run reports how long it waited, synced, installed and ran', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 2 } });
  const result = await remote(env, workspace(), ['true']);
  expect(result.code).toBe(0);
  for (const phase of ['slot wait', 'rsync', 'bun install', 'command']) {
    expect(result.stderr).toMatch(new RegExp(`remote-check: ${phase} \\d+(?:\\.\\d+)? s on b`));
  }
  const script = events().find((event) => event.kind === 'run')!.script as string;
  expect(script).toContain('remote-check: peak memory of the run');
});

test('every container a check host run starts is in the check slice', () => {
  const { env, events } = scenario({ a: { available: 4e9 } });
  const wrapper = join(checkHost, 'docker');
  const docker = (...args: string[]) =>
    spawnSync(wrapper, args, { env: { ...env, PATH: `${checkHost}:${env.PATH}` }, encoding: 'utf8' });

  for (const args of [
    ['run', '-d', '--name', 'database', 'postgres:18'],
    ['create', '--name', 'database', 'postgres:18'],
    ['container', 'run', '--rm', 'postgres:18', 'run', 'create'],
    ['container', 'create', 'postgres:18'],
  ]) {
    // The fake behind it exits 99, which passes through along with its arguments.
    expect(docker(...args).status).toBe(99);
  }
  for (const args of [
    ['ps', '-aq'],
    ['rm', '-f', 'run'],
    ['port', 'create', '5432/tcp'],
    ['volume', 'create', 'run'],
  ])
    docker(...args);

  const calls = events()
    .filter((event) => event.kind === 'docker')
    .map((event) => event.args as string[]);
  expect(calls).toEqual([
    ['run', '--cgroup-parent=rezics-check.slice', '-d', '--name', 'database', 'postgres:18'],
    ['create', '--cgroup-parent=rezics-check.slice', '--name', 'database', 'postgres:18'],
    ['container', 'run', '--cgroup-parent=rezics-check.slice', '--rm', 'postgres:18', 'run', 'create'],
    ['container', 'create', '--cgroup-parent=rezics-check.slice', 'postgres:18'],
    ['ps', '-aq'],
    ['rm', '-f', 'run'],
    ['port', 'create', '5432/tcp'],
    ['volume', 'create', 'run'],
  ]);
});

test('a remote run copies the declared output paths back after it ends, also when it fails', async () => {
  const failed = scenario({ a: { available: 8e9, exit: 7, present: ['.temp/screenshots'] } });
  const failedWorkspace = workspace();
  const failure = await remote(
    failed.env,
    failedWorkspace,
    ['bun', 'test'],
    ['--returns', '.temp/screenshots', '--returns', '.temp/missing'],
  );

  expect(failure.code).toBe(7);
  expect(failure.stderr.split('\n').filter((line) => line.includes(', skipping'))).toEqual([
    'remote-check: .temp/missing is not on a, skipping',
  ]);
  const failedEvents = failed.events();
  const syncs = failedEvents.filter((event) => event.kind === 'rsync');
  expect(syncs).toHaveLength(2);
  expect(String(syncs[0]!.destination)).toStartWith('ops@a.test:/srv/rezics-check/runs/');
  expect(String(syncs[1]!.destination)).toBe(`${failedWorkspace}/`);
  expect(syncs[1]!.files).toEqual(['.temp/screenshots']);
  const kinds = failedEvents.map((event) => event.kind);
  const runAt = kinds.indexOf('run');
  expect(runAt).toBeGreaterThanOrEqual(0);
  expect(kinds.indexOf('returns')).toBeGreaterThan(runAt);
  expect(kinds.lastIndexOf('rsync')).toBeGreaterThan(kinds.indexOf('returns'));
  expect(kinds.indexOf('cleanup')).toBeGreaterThan(kinds.lastIndexOf('rsync'));

  const succeeded = scenario({
    a: { available: 8e9, present: ['.temp/screenshots', 'apps/web/src/kernel/recorded'] },
  });
  const success = await remote(
    succeeded.env,
    workspace(),
    ['true'],
    ['--returns', '.temp/screenshots', '--returns', 'apps/web/src/kernel/recorded'],
  );
  expect(success.code).toBe(0);
  expect(success.stderr).not.toContain('skipping');
  const copied = succeeded.events().filter((event) => event.kind === 'rsync');
  expect(copied).toHaveLength(2);
  expect(copied[1]!.files).toEqual(['.temp/screenshots', 'apps/web/src/kernel/recorded']);
});

test('the docker wrapper calls the docker behind it, not a shim that called the wrapper', () => {
  const { env, events } = scenario({ a: { available: 4e9 } });
  const shims = join(root, 'shims');
  mkdirSync(shims, { recursive: true });
  const shim = join(shims, 'docker');
  writeFileSync(shim, `#!/bin/sh\necho shim >> "$FAKE_DIR/shim.log"\nexec ${join(checkHost, 'docker')} "$@"\n`);
  chmodSync(shim, 0o755);
  const result = spawnSync(shim, ['run', 'image'], {
    env: { ...env, PATH: `${shims}:${checkHost}:${env.PATH}` },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status).toBe(99);
  expect(readFileSync(join(env.FAKE_DIR, 'shim.log'), 'utf8')).toBe('shim\n');
  expect(events().filter((event) => event.kind === 'docker')).toEqual([
    { kind: 'docker', args: ['run', '--cgroup-parent=rezics-check.slice', 'image'] },
  ]);
});

test('a remote run puts the docker wrapper first on the path', async () => {
  const { env, events } = scenario({ a: { available: 4e9 } });
  await remote(env, workspace());
  const script = events().find((event) => event.kind === 'run')!.script as string;
  const path = script.match(/export PATH=(\S+)/)![1];
  expect(path).toMatch(/^\/srv\/rezics-check\/runs\/[a-z0-9-]+\/\.temp\/check-host:/);
  expect(script).toContain(readFileSync(join(checkHost, 'docker'), 'utf8'));
});

test('without KERNEL_CHECK_REMOTE the kernel check runs locally as before', async () => {
  const { env, events } = scenario({ a: { available: 4e9 } });
  const local = { ...env };
  delete local.KERNEL_CHECK_REMOTE;
  const result = await kernelCheck(local);
  expect(result.code).not.toBe(0);
  const seen = events();
  expect(seen.some((event) => event.kind === 'docker')).toBe(true);
  // An unset name falls back to the shared hosts file. Those hosts do not answer this fake ssh, so the check still
  // runs locally; the probes are the only remote traffic.
  expect(seen.filter((event) => event.kind !== 'docker' && event.kind !== 'probe')).toEqual([]);

  // An unreadable hosts file does not fall back and does not hand off.
  const missing = scenario({ a: { available: 4e9 } });
  await kernelCheck({ ...missing.env, KERNEL_CHECK_REMOTE: join(root, 'no-such-hosts.json') });
  expect(missing.events().some((event) => event.kind === 'docker')).toBe(true);
  expect(missing.events().filter((event) => event.kind !== 'docker')).toEqual([]);

  // KERNEL_CHECK_ON_REMOTE does not mean this process is on a check host. The shared decision still places the run.
  const onRemote = scenario({ a: { available: 4e9 } });
  const placed = await kernelCheck({ ...onRemote.env, KERNEL_CHECK_ON_REMOTE: '1' });
  expect(placed.code).toBe(0);
  expect(placed.stderr).toContain('stack-run: kernel check on a');
  expect(onRemote.events().some((event) => event.kind === 'docker')).toBe(false);
  expect(onRemote.events().some((event) => event.kind === 'run')).toBe(true);
});
