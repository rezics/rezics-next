import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const stackRun = join(repository, 'scripts/stack-run.ts');

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
  log({ kind: 'probe' });
  if (config.down) process.exit(255);
  console.log('AVAILABLE ' + config.available);
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
} else if (script.includes('REMOTE_CHECK_SLOT_') || script.includes('flock')) {
  const mode = script.includes('REMOTE_CHECK_SLOT_RESERVED') ? 'reserved' : 'single';
  const reserved = dir + '/' + hostKey + '.reservation';
  const call = count('slot');
  if (mode === 'single' && existsSync(reserved)) {
    log({ kind: 'slot', granted: false, reason: 'reserved', mode });
    process.exit(75);
  }
  if (call < (config.busy ?? 0)) {
    log({ kind: 'slot', granted: false, reason: 'busy', mode });
    process.exit(75);
  }
  const grants = existsSync(dir + '/' + hostKey + '.granted')
    ? Number(readFileSync(dir + '/' + hostKey + '.granted', 'utf8'))
    : 0;
  if (config.grantOnly !== undefined && grants >= config.grantOnly) {
    log({ kind: 'slot', granted: false, reason: 'grant-limit', mode });
    process.exit(75);
  }
  const capacity = Number(script.match(/i -lt (\\d+)/)?.[1] ?? config.slots ?? 1);
  let slot = -1;
  for (let index = 0; index < capacity; index++) {
    try {
      mkdirSync(dir + '/' + hostKey + '.slot.' + index);
      slot = index;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (slot < 0) {
    log({ kind: 'slot', granted: false, reason: 'occupied', mode });
    process.exit(75);
  }
  writeFileSync(dir + '/' + hostKey + '.granted', String(grants + 1));
  const lock = dir + '/' + hostKey + '.slot.' + slot;
  log({ kind: 'slot', granted: true, mode, slot });
  console.log('SLOT ' + slot);
  const release = () => {
    rmSync(lock, { recursive: true, force: true });
    log({ kind: 'release', mode, slot });
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
`;

type Event = { kind: string; address?: string; [key: string]: unknown };
type HostConfig = { available?: number; busy?: number; grantOnly?: number; slots?: number; exit?: number };

let root: string;
let counter = 0;

beforeAll(() => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  root = mkdtempSync(join(repository, '.temp/stack-run-test-'));
  mkdirSync(join(root, 'bin'));
  for (const [name, source] of [
    ['ssh', fakeSsh],
    ['rsync', fakeRsync],
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
  for (const name of ['KERNEL_CHECK_ON_REMOTE', 'REZICS_STACK_LEASE', 'REZICS_STACK_SLOT', 'REZICS_STACK_REMOTE']) {
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
): Promise<{ code: number; stdout: string; stderr: string; directory: string }> {
  const directory = workspace();
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

  expect(result.code).toBe(7);
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

test('a stack run takes the local stack slot when every check host slot is busy, without waiting for a host', async () => {
  const busy = scenario({ a: { available: 4e9, busy: 1000 }, b: { available: 30e9, busy: 1000 } });
  const first = await stack(busy.env, local);

  expect(first.code).toBe(3);
  expect(first.stderr).toContain('stack-run: the run local, every check host slot busy');
  expect(first.stderr).toMatch(/stack-lease: the run slot 1\/1 after \d+ ms/);
  expect(first.stdout).toContain('local slot=1/1');
  const seen = busy.events();
  // Each host's slot was tried once, nothing was synced or run, and nothing polled again.
  expect(seen.filter((event) => event.kind === 'slot').map((event) => [event.address, event.granted])).toEqual(
    expect.arrayContaining([
      ['ops@a.test', false],
      ['ops@b.test', false],
    ]),
  );
  expect(seen.filter((event) => event.kind === 'slot')).toHaveLength(2);
  expect(seen.filter((event) => event.kind === 'rsync' || event.kind === 'run')).toEqual([]);

  // A run of two slots on hosts that can only grant one is also local, and the first slot goes back.
  const partial = scenario({ a: { available: 4e9, grantOnly: 1 } });
  const second = await stack(partial.env, local, ['--slots', '2']);
  expect(second.code).toBe(3);
  expect(second.stderr).toContain('stack-run: the run local, every check host slot busy');
  const kinds = partial.events().map((event) => event.kind);
  expect(kinds).toContain('reservation-release');
  expect(kinds).toContain('release');
  expect(kinds).not.toContain('run');

  // No host has two slots, so the run never asks one.
  const small = scenario({ a: { available: 4e9, slots: 1 } });
  const third = await stack(small.env, local, ['--slots', '2']);
  expect(third.code).toBe(3);
  expect(third.stderr).toContain('every check host slot busy');
  expect(small.events().filter((event) => event.kind === 'slot')).toEqual([]);
}, 30_000);

test('a stack run that is already on a check host, or that writes files the caller keeps, runs locally', async () => {
  const cases: [string, Record<string, string>, string[], string][] = [
    ['on a check host', { KERNEL_CHECK_ON_REMOTE: '1' }, [], 'already on a check host'],
    ['lease off', { REZICS_STACK_LEASE: 'off' }, [], 'already on a check host'],
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
