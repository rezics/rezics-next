import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgresContainer } from '../services/kernel/scripts/check.ts';

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
  log({ kind: 'run', script, identity: args[args.indexOf('-i') + 1] });
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
  if (config.hang) {
    console.log('started');
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
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
const code = config.rsyncExit ?? 0;
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination: args.at(-1),
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
  busy?: number;
  grantOnly?: number;
  slots?: number;
  down?: boolean;
  exit?: number;
  transportFailures?: number;
  rsyncExit?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  present?: string[];
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
        slots: hosts[name].slots ?? 2,
      })),
    }),
  );
  return {
    env: {
      ...(process.env as Record<string, string>),
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
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

test('a remote run holds the requested number of slots on one host and releases them all', async () => {
  // b has the most free memory but too few slots, and c has a single free slot; a has all it needs.
  const { env, events } = scenario({
    a: { available: 4e9, slots: 3 },
    b: { available: 40e9, slots: 1 },
    c: { available: 30e9, slots: 3, busy: 3 },
  });
  const result = await remote(env, workspace(), ['bun', 'test'], ['--slots', '2']);
  expect(result.code).toBe(0);

  const seen = events();
  const on = (host: string) => seen.filter((event) => event.address === `ops@${host}.test`);
  // b cannot serve this run; c wins by available memory and keeps its reservation while the slots free up.
  expect(on('b').filter((event) => event.kind === 'slot')).toEqual([]);
  expect(on('c').filter((event) => event.kind === 'reservation')).toHaveLength(1);
  expect(on('c').filter((event) => event.kind === 'reservation-release')).toHaveLength(1);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === false)).toHaveLength(3);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === true)).toHaveLength(2);
  // c holds two slots for the whole run and drops both after the run directory is removed.
  const kinds = on('c').map((event) => event.kind);
  expect(
    on('c')
      .filter((event) => event.kind === 'slot')
      .map((event) => event.granted),
  ).toEqual([false, false, false, true, true]);
  expect(kinds.indexOf('run')).toBeGreaterThan(kinds.lastIndexOf('slot'));
  expect(kinds.indexOf('reservation-release')).toBeGreaterThan(kinds.lastIndexOf('slot'));
  expect(kinds.indexOf('run')).toBeGreaterThan(kinds.indexOf('reservation-release'));
  expect(kinds.slice(-3)).toEqual(['cleanup', 'release', 'release']);
  expect(seen.filter((event) => event.kind === 'run')).toHaveLength(1);

  // Without the flag a run holds one slot, and a count no host can serve is refused rather than waited for.
  const single = scenario({ a: { available: 4e9 } });
  expect((await remote(single.env, workspace())).code).toBe(0);
  expect(single.events().filter((event) => event.kind === 'slot')).toHaveLength(1);
  const tooMany = scenario({ a: { available: 4e9 } });
  const refused = await remote(tooMany.env, workspace(), ['bun', 'test'], ['--slots', '3']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('3 slots');
  expect(tooMany.events()).toEqual([]);
});

test('a multi-slot waiter reserves its host and later single-slot runs go elsewhere', async () => {
  const { env, events } = scenario({ a: { available: 10e9, slots: 2 }, b: { available: 20e9, slots: 2, hang: true } });
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multi: ReturnType<typeof startRemote> | undefined;
  let laterSingle: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@b.test'));
    multi = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => {
      const seen = events();
      return (
        seen.some((event) => event.kind === 'reservation' && event.address === 'ops@b.test') &&
        seen.some((event) => event.kind === 'slot' && event.mode === 'reserved' && event.granted === true) &&
        seen.some((event) => event.kind === 'slot' && event.mode === 'reserved' && event.granted === false)
      );
    });

    laterSingle = startRemote(env, workspace(), ['true']);
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@a.test'));
    expect(await laterSingle.child.exited).toBe(0);
    expect(
      events().some((event) => event.kind === 'slot' && event.address === 'ops@b.test' && event.reason === 'reserved'),
    ).toBe(true);
    expect(
      events().find((event) => event.kind === 'rsync' && String(event.destination).startsWith('ops@a.test:'))!
        .destination,
    ).toStartWith('ops@a.test:');

    first.child.kill('SIGTERM');
    await first.child.exited;
    await waitFor(
      () => events().filter((event) => event.kind === 'run' && event.address === 'ops@b.test').length === 2,
    );
    multi.child.kill('SIGTERM');
    await multi.child.exited;
    const onB = events().filter((event) => event.address === 'ops@b.test');
    expect(onB.filter((event) => event.kind === 'reservation')).toHaveLength(1);
    expect(onB.filter((event) => event.kind === 'reservation-release')).toHaveLength(1);
    expect(onB.filter((event) => event.kind === 'release')).toHaveLength(3);
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

test('a multi-slot waiter keeps partial slots, serializes reservations and releases them on abort', async () => {
  const { env, events } = scenario({ a: { available: 12e9, slots: 3, hang: true } });
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multiOne: ReturnType<typeof startRemote> | undefined;
  let multiTwo: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run'));
    multiOne = startRemote(env, workspace(), ['true'], ['--slots', '3']);
    await waitFor(() => {
      const seen = events();
      return (
        seen.filter((event) => event.kind === 'slot' && event.mode === 'reserved' && event.granted === true).length ===
          2 && seen.some((event) => event.kind === 'slot' && event.mode === 'reserved' && event.granted === false)
      );
    });

    multiTwo = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'reservation-wait'));
    const waiting = events();
    expect(waiting.filter((event) => event.kind === 'reservation')).toHaveLength(1);
    expect(waiting.filter((event) => event.kind === 'release' && event.mode === 'reserved')).toHaveLength(0);
    expect(
      waiting.filter((event) => event.kind === 'slot' && event.mode === 'reserved' && event.granted === true),
    ).toHaveLength(2);

    multiOne.child.kill('SIGTERM');
    expect(await multiOne.child.exited).toBe(143);
    await waitFor(
      () =>
        events().filter((event) => event.kind === 'reservation').length === 2 &&
        events().filter((event) => event.kind === 'run').length === 2,
    );
    const afterSecondAcquired = events();
    const reservations = afterSecondAcquired.filter((event) => event.kind === 'reservation');
    const secondReservation = afterSecondAcquired.indexOf(reservations[1]);
    const releasedSlots = afterSecondAcquired.filter((event) => event.kind === 'release' && event.mode === 'reserved');
    expect(releasedSlots).toHaveLength(2);
    expect(
      afterSecondAcquired.indexOf(afterSecondAcquired.find((event) => event.kind === 'reservation-release')!),
    ).toBeLessThan(secondReservation);
    expect(afterSecondAcquired.indexOf(releasedSlots[1])).toBeLessThan(secondReservation);
    multiTwo.child.kill('SIGTERM');
    await multiTwo.child.exited;
    first.child.kill('SIGTERM');
    await first.child.exited;
    expect(events().filter((event) => event.kind === 'reservation')).toHaveLength(2);
    expect(events().filter((event) => event.kind === 'reservation-release')).toHaveLength(2);
  } finally {
    for (const run of [multiTwo, multiOne, first]) {
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
