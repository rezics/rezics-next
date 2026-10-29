import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { onCheckHost, runOnCheckHost } from './stack-run.ts';
import { ROOT } from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const stackRun = join(repository, 'scripts/stack-run.ts');
const databaseScript = join(repository, 'services/kernel/scripts/database.ts');
const searchScript = join(repository, 'services/kernel/scripts/search.ts');

// A fake ssh answers each kind of remote script by what it contains, so the tests see which host was chosen, what ran
// there and what was released, without a network.
const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const script = args.at(-1)!;
const address = args.at(-2)!;
const config = JSON.parse(readFileSync(dir + '/config.json', 'utf8'))[address] ?? {};
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, ...event }) + '\\n');
const hostKey = address.replace(/[^a-z0-9]/gi, '_');
const count = (name: string) => {
  const file = dir + '/' + hostKey + '.' + name;
  const seen = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(seen + 1));
  return seen;
};
if (script.includes('MemAvailable')) {
  const slots = config.slots ?? 2;
  const ordinarySlotsUsed = Array.from({ length: Math.max(0, slots - 1) }, (_, index) => existsSync(dir + '/' + hostKey + '.slot.' + index)).filter(Boolean).length;
  const expressSlotUsed = existsSync(dir + '/' + hostKey + '.slot.express');
  log({ kind: 'probe', ordinarySlotsUsed, expressSlotUsed });
  if (config.down) process.exit(255);
  console.log(
    'MEMORY_CURRENT -\\nMEMORY_MAX -\\nMEMORY_HEADROOM ' + (config.available ?? 16 * 2 ** 30) +
      '\\nAVAILABLE ' + (config.available ?? 16 * 2 ** 30) +
      '\\nPROCESSORS 16\\nSLICE_PROCESSORS ' + ((config.cpuQuotaPercent ?? 800) / 100) +
      '\\nLOAD 0\\nORDINARY_SLOTS_USED ' + ordinarySlotsUsed +
      '\\nEXPRESS_SLOT_USED ' + (expressSlotUsed ? 1 : 0) + '\\nGATE_WAITING 0' +
      '\\nMULTI_SLOT_WAITING_SLOTS 0\\nMULTI_SLOT_WAITING_ID -' +
      '\\nLANDING_WAITING_SLOTS 0\\nLANDING_WAITING_ID -',
  );
} else if (script.includes('REMOTE_CHECK_RESERVATION')) {
  const lock = dir + '/' + hostKey + '.reservation';
  let announcedWait = false;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!announcedWait) {
        log({ kind: 'reservation-wait' });
        announcedWait = true;
      }
      await Bun.sleep(5);
    }
  }
  log({ kind: 'reservation' });
  console.log('RESERVATION');
  const release = () => {
    rmSync(lock, { recursive: true, force: true });
    log({ kind: 'reservation-release' });
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_BASE_STATE')) {
  log({ kind: 'base' });
  console.log('BASE -\\nAGE -\\nZSTD 0');
} else if (script.includes('REMOTE_CHECK_BASE_REFRESH') && !script.includes('systemd-run')) {
  log({ kind: 'base-refresh' });
} else if (script.includes('REMOTE_CHECK_SLOT_')) {
  const requested = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const slotClass = script.match(/# REMOTE_CHECK_SLOT_CLASS (ordinary|short)/)?.[1] ?? 'ordinary';
  const call = count('slot');
  if (call < (config.busy ?? 0)) {
    log({ kind: 'slot', granted: false, reason: 'busy', slotClass, script });
    process.exit(75);
  }
  const grants = existsSync(dir + '/' + hostKey + '.granted')
    ? Number(readFileSync(dir + '/' + hostKey + '.granted', 'utf8'))
    : 0;
  if (config.grantOnly !== undefined && grants >= config.grantOnly) {
    log({ kind: 'slot', granted: false, reason: 'grant-limit', slotClass, script });
    process.exit(75);
  }
  const capacity = config.slots ?? 2;
  const ordinaryCapacity = Number(
    script.match(/# REMOTE_CHECK_ORDINARY_COUNT (\\d+)/)?.[1] ?? Math.max(0, capacity - 1),
  );
  const slotLimit = Number(script.match(/# REMOTE_CHECK_SLOT_LIMIT (\\d+)/)?.[1] ?? ordinaryCapacity);
  const occupied = Array.from({ length: ordinaryCapacity }, (_, index) => index).filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index));
  const expressOccupied = existsSync(dir + '/' + hostKey + '.slot.express');
  const freeOrdinary = Array.from({ length: ordinaryCapacity }, (_, index) => index).filter((index) => !occupied.includes(index));
  const free = slotClass === 'short' ? [...freeOrdinary, ...(expressOccupied ? [] : ['express' as const])] : freeOrdinary;
  const limitedOccupied = occupied.length + (slotClass === 'short' && expressOccupied ? 1 : 0);
  if (limitedOccupied + requested > slotLimit || free.length < requested) {
    log({ kind: 'slot', granted: false, reason: 'occupied', slotClass, script });
    process.exit(75);
  }
  const selected = free.slice(0, requested);
  for (const slot of selected) mkdirSync(dir + '/' + hostKey + '.slot.' + slot);
  writeFileSync(dir + '/' + hostKey + '.granted', String(grants + selected.length));
  for (const slot of selected) log({ kind: 'slot', granted: true, slotClass, script, slot });
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
} else if (script.includes('systemd-run')) {
  log({ kind: 'run', script, identity: args[args.indexOf('-i') + 1] });
  const host = address.slice(address.indexOf('@') + 1).replace(/\\.test$/, '');
  if (script.includes('remote-check: bun install') && script.includes('remote-check: command')) {
    console.error('remote-check: bun install 0.125 s on ' + host);
    console.error('remote-check: command 0.250 s on ' + host);
  }
  if (config.stdout) console.log(config.stdout);
  if (config.stderr) console.error(config.stderr);
  if (config.hang) {
    console.log('started');
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
  } else process.exit(config.exit ?? 0);
} else {
  log({ kind: 'cleanup', script });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination: args.at(-1),
  files: input.split('\\0').filter(Boolean),
}) + '\\n');
if (process.env.FAKE_RSYNC_FAIL === '1') process.exit(12);
`;

const fakeDocker = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({ kind: 'docker', args: process.argv.slice(2) }) + '\\n');
process.exit(99);
`;

type Event = { kind: string; address?: string; [key: string]: unknown };
type HostConfig = {
  available?: number;
  busy?: number;
  grantOnly?: number;
  slots?: number;
  exit?: number;
  down?: boolean;
};

let root: string;
let counter = 0;

beforeAll(() => {
  // Keep fixture workspaces outside the remote run root. The acceptance file may itself run on a check host.
  const temporaryParent = onCheckHost(process.cwd()) ? ROOT : join(repository, '.temp');
  mkdirSync(temporaryParent, { recursive: true });
  root = mkdtempSync(join(temporaryParent, 'stack-run-test-'));
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

function scenario(hosts: Record<string, HostConfig>): {
  env: Record<string, string>;
  lease: string;
  events: () => Event[];
} {
  const dir = join(root, `scenario-${counter++}`);
  mkdirSync(dir);
  const lease = join(dir, 'lease');
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
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: hosts[name]!.slots ?? 2,
      })),
    }),
  );
  const env = { ...process.env } as Record<string, string>;
  for (const name of [
    'KERNEL_CHECK_ON_REMOTE',
    'REZICS_STACK_LEASE',
    'REZICS_STACK_SLOT',
    'REZICS_STACK_REMOTE',
    'GOAL_TASK_ID',
  ]) {
    delete env[name];
  }
  return {
    env: {
      ...env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      KERNEL_CHECK_REMOTE: join(dir, 'hosts.json'),
      REMOTE_CHECK_POLL_MS: '20',
      REZICS_STACK_LEASE_DIR: lease,
      REZICS_STACK_SLOTS: '1',
    },
    lease,
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
  };
}

function workspace(): string {
  const directory = mkdtempSync(join(root, 'workspace-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/tracked.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  return directory;
}

async function stack(
  environment: Record<string, string>,
  command: string[],
  options: string[] = [],
  directory = workspace(),
): Promise<{ code: number; stdout: string; stderr: string; directory: string }> {
  const child = Bun.spawn(
    ['bun', stackRun, ...options, 'the run', directory, join(directory, 'src'), '--', ...command],
    {
      cwd: repository,
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, directory };
}

const local = ['sh', '-c', 'echo "local slot=$REZICS_STACK_SLOT"; exit 3'];

test("a stack run goes to a free check host and returns the command's exit code", async () => {
  const { env, lease, events } = scenario({ a: { available: 4e9 }, b: { available: 30e9, exit: 7 } });
  const result = await stack(env, local);

  expect(result.code, `${result.stderr} ${JSON.stringify(events())}`).toBe(7);
  expect(result.stderr).toContain('stack-run: the run on b');
  expect(result.stdout).not.toContain('local slot');
  const seen = events();
  expect(seen.find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@b.test:/srv/rezics-check/runs/');
  const run = seen.find((event) => event.kind === 'run')!;
  expect(run.address).toBe('ops@b.test');
  const script = run.script as string;
  expect(script).toContain('KERNEL_CHECK_ON_REMOTE=1');
  expect(script).toContain('REZICS_STACK_LEASE=off');
  expect(script).toContain('echo "local slot=$REZICS_STACK_SLOT"; exit 3');
  // The run held a host slot and no local one.
  const kinds = seen.filter((event) => event.address === 'ops@b.test').map((event) => event.kind);
  expect(kinds.slice(-2)).toEqual(['cleanup', 'release']);
  expect(existsSync(lease)).toBe(false);
}, 30_000);

test('stack-run passes --estimate-ms through to remote placement and refuses invalid values', async () => {
  const valid = scenario({ a: { available: 20e9, slots: 2 } });
  const completed = await stack(valid.env, ['true'], ['--estimate-ms', '120000']);
  expect(completed.code).toBe(0);
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)).toMatchObject({
    slotClass: 'short',
    slot: 0,
  });
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS 120000',
  );

  for (const estimate of ['-1', '1.5', '9007199254740992', 'Infinity']) {
    const invalid = scenario({ a: { available: 20e9 } });
    const refused = await stack(invalid.env, ['true'], ['--estimate-ms', estimate]);
    expect(refused.code, estimate).toBe(2);
    expect(refused.stderr, estimate).toContain('--estimate-ms');
    expect(invalid.events(), estimate).toEqual([]);
  }

  const missing = scenario({ a: { available: 20e9 } });
  const refused = await stack(missing.env, ['true'], ['--estimate-ms']);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain('--estimate-ms');
  expect(missing.events()).toEqual([]);
});

test('a stack run runs locally when no check host answers, and when no host has enough slots', async () => {
  const down = scenario({ a: { down: true }, b: { down: true } });
  const first = await stack(down.env, local);

  expect(first.code).toBe(3);
  expect(first.stderr).toContain('stack-run: the run local, no check host answered');
  expect(first.stderr).not.toContain('waiting');
  expect(first.stdout).toContain('local slot=1/1');
  const seen = down.events();
  expect(seen.filter((event) => event.kind === 'probe')).toHaveLength(2);
  expect(seen.filter((event) => event.kind === 'slot' || event.kind === 'rsync' || event.kind === 'run')).toEqual([]);

  // No host has two slots, so the run never asks one.
  const small = scenario({ a: { available: 5 * 2 ** 30, slots: 1 } });
  const third = await stack(small.env, local, ['--slots', '2']);
  expect(third.code).toBe(1);
  expect(third.stderr).toContain('requested 2 slots exceeds the cap of 1');
  expect(small.events().filter((event) => event.kind === 'slot')).toEqual([]);
}, 30_000);

test('a stack run that is already on a check host, or that writes files the caller keeps, runs locally', async () => {
  const cases: [string, Record<string, string>, string[], string][] = [
    ['inside a slot', { REZICS_STACK_SLOT: '2/4' }, [], 'already inside a stack slot'],
    ['keeps files', {}, ['--keeps-files'], 'the run keeps files it writes'],
    ['forced local', { REZICS_STACK_REMOTE: 'off' }, [], 'REZICS_STACK_REMOTE=off'],
  ];
  for (const [name, extra, options, reason] of cases) {
    const { env, events } = scenario({ a: { available: 4e9, exit: 7 } });
    const result = await stack({ ...env, ...extra }, local, options);
    expect(result.code, name).toBe(3);
    expect(result.stderr, name).toContain(`stack-run: the run local, ${reason}`);
    expect(events(), name).toEqual([]);
  }

  // The working directory under the remote run root is what counts, not an environment variable.
  const onHost = scenario({ a: { available: 4e9, exit: 7 } });
  const directory = workspace();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const code = await runOnCheckHost(
      {
        label: 'the run',
        root: directory,
        cwd: '/srv/rezics-check/runs/example/src',
        command: local,
      },
      onHost.env,
    );
    expect(code).toBeNull();
  } finally {
    console.error = original;
  }
  expect(lines.join('\n')).toContain('stack-run: the run local, already on a check host');
  expect(onHost.events()).toEqual([]);

  // Without a hosts file, or with an unreadable one, the run is local as before and holds the local slot.
  const none = scenario({ a: { available: 4e9 } });
  const unset = await stack({ ...none.env, KERNEL_CHECK_REMOTE: '' }, local);
  expect(unset.code).toBe(3);
  expect(unset.stderr).toContain('stack-run: the run local, no check host is configured');
  expect(unset.stdout).toContain('local slot=1/1');
  const missing = await stack({ ...none.env, KERNEL_CHECK_REMOTE: join(root, 'missing.json') }, local);
  expect(missing.code).toBe(3);
  expect(missing.stderr).toContain('is not readable');
  expect(none.events()).toEqual([]);
}, 30_000);

test("a worker's stack run waits for a check host slot instead of running locally", async () => {
  const { env, events } = scenario({ a: { available: 4e9, busy: 2 }, b: { available: 30e9, busy: 2, exit: 9 } });
  const result = await stack({ ...env, GOAL_TASK_ID: 'worker' }, local);

  expect(result.code).toBe(9);
  expect(result.stderr).toContain('waiting');
  expect(result.stderr).toContain('stack-run: the run on b');
  expect(result.stdout).not.toContain('local slot');
  const seen = events();
  expect(seen.filter((event) => event.kind === 'slot' && event.granted === false).length).toBeGreaterThan(0);
  expect(seen.filter((event) => event.kind === 'run')).toHaveLength(1);
  expect(seen.filter((event) => event.kind === 'probe').length).toBeGreaterThan(2);
}, 30_000);

test('landing priority: stackRun carries landing to admission and check entry points preserve the caller environment', async () => {
  const { env, events } = scenario({ a: { available: 20e9 } });
  const result = await stack({ ...env, REMOTE_CHECK_PRIORITY: 'landing' }, ['true']);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('stack-run: the run priority landing on a');
  expect(events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain('# REMOTE_CHECK_PRIORITY landing');
  expect(events().find((event) => event.kind === 'run')?.script).toContain("printf 'remote-check: run priority %s");

  const kernel = readFileSync(join(repository, 'services/kernel/scripts/check.ts'), 'utf8');
  const auth = readFileSync(join(repository, 'services/auth/scripts/check.ts'), 'utf8');
  const web = readFileSync(join(repository, 'apps/web/scripts/check.ts'), 'utf8');
  const placement = readFileSync(join(repository, 'scripts/stack-run.ts'), 'utf8');
  expect(kernel).toContain('    env,\n  );');
  expect(auth).toContain('process.exitCode = await stackRun(');
  expect(auth).toContain("command: ['bun', 'scripts/check.ts', ...args],\n    },\n    async () => {");
  expect(web).toContain('      options.env ?? process.env,');
  expect(web).toContain('export async function runHostTests(\n  env: NodeJS.ProcessEnv = process.env');
  expect(placement).toContain('env: Environment = process.env');
}, 30_000);

test('landing priority: workers drop landing and report it once, and other values are usage errors', async () => {
  const worker = scenario({ a: { available: 20e9 } });
  const workerResult = await stack({ ...worker.env, REMOTE_CHECK_PRIORITY: 'landing', GOAL_TASK_ID: 'worker' }, ['true']);
  expect(workerResult.code).toBe(0);
  expect(workerResult.stderr.match(/worker environment ignores REMOTE_CHECK_PRIORITY=landing/g)).toHaveLength(1);
  expect(worker.events().some((event) => event.kind === 'landing-marker')).toBe(false);
  expect(worker.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain('# REMOTE_CHECK_PRIORITY ordinary');

  const invalid = scenario({ a: { available: 20e9 } });
  const refused = await stack({ ...invalid.env, REMOTE_CHECK_PRIORITY: 'urgent' }, ['true']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('REMOTE_CHECK_PRIORITY must be landing');
  expect(invalid.events()).toEqual([]);
}, 30_000);

test('a worker does not run locally after a reachable host fails during workspace sync', async () => {
  const { env, lease, events } = scenario({ a: { available: 30e9 } });
  const result = await stack({ ...env, GOAL_TASK_ID: 'worker', FAKE_RSYNC_FAIL: '1' }, local);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('connection to a failed during workspace upload before a result');
  expect(result.stderr).not.toContain('stack-run: the run local');
  expect(result.stdout).not.toContain('local slot');
  expect(events().some((event) => event.kind === 'probe')).toBe(true);
  expect(events().some((event) => event.kind === 'run')).toBe(false);
  expect(existsSync(lease)).toBe(false);
}, 30_000);

test("environment variables cannot make a worker's run count as on a check host", async () => {
  const extras: Record<string, string>[] = [
    { KERNEL_CHECK_ON_REMOTE: '1' },
    { REZICS_STACK_LEASE: 'off' },
    {
      KERNEL_CHECK_ON_REMOTE: '1',
      REZICS_STACK_LEASE: 'off',
      REZICS_STACK_REMOTE: 'off',
      REZICS_STACK_SLOT: '1/1',
    },
  ];
  for (const extra of extras) {
    const { env, events } = scenario({ a: { available: 30e9, exit: 4 } });
    const name = JSON.stringify(extra);
    const result = await stack({ ...env, GOAL_TASK_ID: 'worker', ...extra }, local);
    expect(result.code, name).toBe(4);
    expect(result.stderr, name).toContain('stack-run: the run on a');
    expect(result.stderr, name).not.toContain('already on a check host');
    expect(result.stderr, name).not.toContain('REZICS_STACK_REMOTE=off');
    expect(result.stderr, name).not.toContain('already inside a stack slot');
    expect(result.stdout, name).not.toContain('local slot');
    expect(
      events().some((event) => event.kind === 'run'),
      name,
    ).toBe(true);
  }
}, 30_000);

test('an empty or missing KERNEL_CHECK_REMOTE falls back to the shared hosts file', async () => {
  for (const clear of ['empty', 'missing'] as const) {
    const { env, events } = scenario({ a: { available: 30e9, exit: 5 } });
    const directory = workspace();
    mkdirSync(join(directory, '.temp/goal'), { recursive: true });
    copyFileSync(env.KERNEL_CHECK_REMOTE!, join(directory, '.temp/goal/remote-check-hosts.json'));
    const environment = { ...env };
    if (clear === 'empty') environment.KERNEL_CHECK_REMOTE = '';
    else delete environment.KERNEL_CHECK_REMOTE;
    const result = await stack(environment, local, [], directory);
    expect(result.code, clear).toBe(5);
    expect(result.stderr, clear).toContain('stack-run: the run on a');
    expect(
      events().some((event) => event.kind === 'probe'),
      clear,
    ).toBe(true);
    expect(
      events().some((event) => event.kind === 'run'),
      clear,
    ).toBe(true);
  }
}, 30_000);

test('a worker cannot start a local stack container while a check host is reachable', async () => {
  const reachable = scenario({ a: { available: 30e9 } });
  const worker = { ...reachable.env, GOAL_TASK_ID: 'worker' };
  for (const script of [databaseScript, searchScript]) {
    const child = Bun.spawn(['bun', script, 'up'], {
      cwd: root,
      env: worker,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, script).not.toBe(0);
    expect(stderr, script).toContain('bun run --cwd services/kernel check <files>');
    expect(stderr, script).toContain('bun run --cwd services/auth check <files>');
    expect(stderr, script).toContain('root `bun test`');
  }
  expect(reachable.events().filter((event) => event.kind === 'docker')).toEqual([]);
  expect(reachable.events().some((event) => event.kind === 'probe')).toBe(true);

  const ask = async (environment: Record<string, string>, cwd: string): Promise<string | null> => {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        'import { workerLocalContainerError } from "./scripts/stack-run.ts"; const reason = await workerLocalContainerError(process.env, process.env.PROBE_CWD ?? ""); console.log(JSON.stringify(reason));',
      ],
      {
        cwd: repository,
        env: { ...environment, PROBE_CWD: cwd },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as string | null;
  };

  const down = scenario({ a: { down: true } });
  expect(await ask({ ...down.env, GOAL_TASK_ID: 'worker' }, join(repository, 'services/kernel'))).toBeNull();

  const person = scenario({ a: { available: 30e9 } });
  expect(await ask(person.env, join(repository, 'services/kernel'))).toBeNull();
  expect(person.events().filter((event) => event.kind === 'probe')).toEqual([]);

  const hosted = scenario({ a: { available: 30e9 } });
  expect(
    await ask({ ...hosted.env, GOAL_TASK_ID: 'worker' }, '/srv/rezics-check/runs/example/services/kernel'),
  ).toBeNull();
  expect(hosted.events().filter((event) => event.kind === 'probe')).toEqual([]);
}, 30_000);
