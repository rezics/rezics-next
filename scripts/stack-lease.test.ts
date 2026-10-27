import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireStackSlot, stackCapacity } from './stack-lease.ts';

const repository = resolve(import.meta.dir, '..');
const lease = join(import.meta.dir, 'stack-lease.ts');
const directories: string[] = [];
type Run = {
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  output: { stdout: string; stderr: string };
  done: Promise<void[]>;
};
const runs: Run[] = [];
const slots: Awaited<ReturnType<typeof acquireStackSlot>>[] = [];

function environment(capacity = 1): Record<string, string> {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/stack-lease-test-'));
  directories.push(directory);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REZICS_STACK_SLOTS: String(capacity),
    REZICS_STACK_LEASE_DIR: directory,
  };
  delete env.REZICS_STACK_SLOT;
  delete env.REZICS_STACK_LEASE;
  // These runs test the local lease, so the entries must not hand them to a check host.
  delete env.KERNEL_CHECK_REMOTE;
  return env as Record<string, string>;
}

function start(env: Record<string, string>, label: string, command?: string[], script = lease): Run {
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      ...(script === lease ? [label, '--'] : []),
      ...(command ?? [process.execPath, '-e', 'console.log(process.env.REZICS_STACK_SLOT); await Bun.stdin.text();']),
    ],
    { cwd: repository, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const output = { stdout: '', stderr: '' };
  const drain = async (stream: ReadableStream<Uint8Array>, key: 'stdout' | 'stderr') => {
    for await (const chunk of stream) output[key] += new TextDecoder().decode(chunk);
  };
  const done = Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')]);
  const run = { child, output, done };
  runs.push(run);
  return run;
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

async function stop(run: ReturnType<typeof start>, code = 0) {
  await run.child.stdin.end();
  expect(await run.child.exited).toBe(code);
  await run.done;
}

async function take(env: Record<string, string>) {
  const slot = await acquireStackSlot('test', env);
  slots.push(slot);
  return slot;
}

function held(env: Record<string, string>, index = 1) {
  return (
    Bun.spawnSync(['flock', '-n', '-E', '75', join(env.REZICS_STACK_LEASE_DIR!, `slot-${index}.lock`), 'true'])
      .exitCode === 75
  );
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    await run.child.stdin.end();
    if (run.child.exitCode === null) run.child.kill('SIGTERM');
    await run.child.exited;
    await run.done;
  }
  await Promise.all(slots.splice(0).map((slot) => slot.release()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a slot is held for the command's life and released when it exits", async () => {
  const env = environment();
  const run = start(env, 'holder');
  await waitFor(() => run.output.stdout.includes('1/1'));
  expect(held(env)).toBe(true);
  const waiter = start(env, 'waiter', [process.execPath, '-e', 'console.log("taken"); process.exit(7)']);
  await waitFor(() => waiter.output.stderr.includes('waiting (1/1 held, 0 ahead)'));
  expect(waiter.output.stdout).toBe('');
  await stop(run);
  expect(await waiter.child.exited).toBe(7);
  await waiter.done;
  expect(waiter.output.stdout).toBe('taken\n');
  expect(held(env)).toBe(false);

  // The wrapper forwards each supported signal, holds until the child exits, and preserves its exit code.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const signaled = start(env, signal, [
      process.execPath,
      '-e',
      `process.on('${signal}', () => { console.log('forwarded'); process.exit(23); }); console.log('ready'); setInterval(() => {}, 1000);`,
    ]);
    await waitFor(() => signaled.output.stdout.includes('ready'));
    signaled.child.kill(signal);
    expect(await signaled.child.exited).toBe(23);
    await signaled.done;
    expect(signaled.output.stdout).toContain('forwarded');
    expect(held(env)).toBe(false);
  }
}, 20_000);

test('waiters take slots in arrival order', async () => {
  const env = environment();
  const slot = await take(env);
  const waiters: ReturnType<typeof start>[] = [];
  for (let i = 0; i < 4; i++) {
    const run = start(env, `waiter-${i}`);
    await waitFor(() => run.output.stderr.includes(`${i} ahead`));
    waiters.push(run);
  }
  // A dead queued waiter must not hold up the remaining tickets.
  waiters[1]!.child.kill('SIGKILL');
  await waiters[1]!.child.exited;
  await slot.release();
  for (const i of [0, 2, 3]) {
    const run = waiters[i]!;
    await waitFor(() => run.output.stdout.includes('1/1'));
    for (const later of waiters.slice(i + 1)) expect(later.output.stdout).toBe('');
    await stop(run);
  }
}, 20_000);

test('a holder killed with SIGKILL frees its slot without cleanup', async () => {
  const env = environment();
  const holder = start(env, 'killed');
  await waitFor(() => holder.output.stdout.includes('1/1'));
  const first = start(env, 'first');
  await waitFor(() => first.output.stderr.includes('0 ahead'));
  const second = start(env, 'second');
  await waitFor(() => second.output.stderr.includes('1 ahead'));
  // No file is touched on the holder's death: the two-second recheck must notice the unlocked flock.
  await Bun.sleep(250);
  holder.child.kill('SIGKILL');
  await holder.child.exited;
  await waitFor(() => first.output.stdout.includes('1/1'));
  expect(second.output.stdout).toBe('');
  await holder.child.stdin.end();
  await holder.done;
  await stop(first);
  await waitFor(() => second.output.stdout.includes('1/1'));
  await stop(second);
}, 20_000);

test('a command under a held slot takes no second slot', async () => {
  const env = environment();
  const slot = await take(env);
  const nestedEnv = { ...env, ...slot.env };
  const nested = await take(nestedEnv);
  expect(nested.index).toBeNull();
  expect(nested.waitedMs).toBe(0);
  expect(nested.env).toEqual(slot.env);
  await nested.release();
  expect(held(env)).toBe(true);
  const run = start(nestedEnv, 'nested', [
    process.execPath,
    lease,
    'inner',
    '--',
    process.execPath,
    '-e',
    'console.log(process.env.REZICS_STACK_SLOT)',
  ]);
  await stop(run);
  expect(run.output.stdout).toBe('1/1\n');
  expect(run.output.stderr).toBe('');
  const off = await take({ ...env, REZICS_STACK_LEASE: 'off' });
  expect(off.index).toBeNull();
  expect(off.env).toEqual({});
  await slot.release();
  await slot.release();
  expect(held(env)).toBe(false);

  // A throwing callback also releases, and withStackSlot passes the token to the callback.
  const check = start(
    env,
    'callback',
    [
      `
    import { withStackSlot } from ${JSON.stringify(lease)};
    try { await withStackSlot('throwing', async env => { console.log(env.REZICS_STACK_SLOT); throw Error('expected'); }); }
    catch (error) { if (error.message !== 'expected') throw error; }
  `,
    ],
    '-e',
  );
  await stop(check);
  expect(check.output.stdout).toBe('1/1\n');
  expect(held(env)).toBe(false);
});

test('capacity comes from cores and memory and REZICS_STACK_SLOTS overrides it', async () => {
  const env = environment(3);
  expect(stackCapacity(env)).toBe(3);
  expect(stackCapacity({})).toBe(
    Math.max(1, Math.min(Math.floor(cpus().length / 8), Math.floor(totalmem() / 2 ** 30 / 7.5))),
  );
  for (const [cores, gib, expected] of [
    [64, 62, 8],
    [16, 100, 2],
    [64, 15, 2],
    [1, 1, 1],
  ]) {
    const run = start(env, 'capacity', [
      process.execPath,
      '-e',
      `
      import { spyOn } from 'bun:test';
      import * as os from 'node:os';
      spyOn(os, 'cpus').mockReturnValue(Array(${cores}));
      spyOn(os, 'totalmem').mockReturnValue(${gib} * 2 ** 30);
      const { stackCapacity } = await import(${JSON.stringify(lease)});
      console.log(stackCapacity({}));
    `,
    ]);
    await stop(run);
    expect(run.output.stdout.trim()).toBe(String(expected));
  }
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '3x', ' 2', '1e2', '9007199254740992']) {
    expect(() => stackCapacity({ ...env, REZICS_STACK_SLOTS: value })).toThrow('positive integer');
    await expect(acquireStackSlot('invalid', { ...env, REZICS_STACK_SLOTS: value })).rejects.toThrow(
      'positive integer',
    );
  }
  const holders = await Promise.all([take(env), take(env), take(env)]);
  expect(new Set(holders.map((slot) => slot.index)).size).toBe(3);
  const waiter = start(env, 'fourth');
  await waitFor(() => waiter.output.stderr.includes('3/3 held'));
  await holders[0]!.release();
  await waitFor(() => waiter.output.stdout.includes('/3'));
  await stop(waiter);
}, 20_000);

test('the wait is printed when a slot is taken', async () => {
  const env = environment();
  const holder = await take(env);
  const waiter = start(env, 'logged');
  await waitFor(() => waiter.output.stderr.includes('stack-lease: logged waiting (1/1 held, 0 ahead)'));
  await Bun.sleep(50);
  await holder.release();
  await waitFor(() => waiter.output.stdout.includes('1/1'));
  await stop(waiter);
  const match = waiter.output.stderr.match(/stack-lease: logged slot 1\/1 after (\d+) ms/);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThanOrEqual(50);
  const immediate = start(env, 'immediate', ['true']);
  await stop(immediate);
  expect(immediate.output.stderr).toMatch(/^stack-lease: immediate slot 1\/1 after \d+ ms\n$/);
});

test('web and auth isolated runs hold one slot for the whole command', async () => {
  const env = environment();
  for (const app of ['web', 'auth']) {
    const run = start(env, app, undefined, join(repository, `apps/${app}/scripts/isolated.ts`));
    await waitFor(() => run.output.stdout.includes('1/1'));
    expect(held(env)).toBe(true);
    const waiter = start(env, 'outside', ['true']);
    await waitFor(() => waiter.output.stderr.includes('waiting'));
    await stop(run);
    expect(await waiter.child.exited).toBe(0);
    await waiter.done;
    expect(held(env)).toBe(false);
  }
}, 20_000);

test('remote commands run with the lease off', async () => {
  const env = environment();
  const directory = env.REZICS_STACK_LEASE_DIR!;
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const scriptFile = join(directory, 'remote-script');
  writeFileSync(
    join(bin, 'ssh'),
    `#!/usr/bin/env bun
    const script = process.argv.at(-1);
    if (script.includes('MemAvailable')) console.log('AVAILABLE 1000000000');
    else if (script.includes('systemd-run')) await Bun.write(${JSON.stringify(scriptFile)}, script);
    else if (script.includes('SLOT')) { console.log('SLOT 0'); await Bun.stdin.text(); }
  `,
  );
  writeFileSync(join(bin, 'rsync'), '#!/usr/bin/env bun\nawait Bun.stdin.text();\n');
  for (const name of ['ssh', 'rsync']) chmodSync(join(bin, name), 0o755);
  const hosts = join(directory, 'hosts.json');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        { name: 'test', address: 'ops@test', identity: '/unused', memoryMaxGiB: 8, cpuQuotaPercent: 100, slots: 1 },
      ],
    }),
  );
  const run = start({ ...env, PATH: `${bin}:${env.PATH}`, KERNEL_CHECK_REMOTE: hosts }, 'remote', [
    process.execPath,
    join(import.meta.dir, 'remote-check.ts'),
    repository,
    '--',
    'true',
  ]);
  await stop(run);
  const script = readFileSync(scriptFile, 'utf8');
  expect(script).toContain('REZICS_STACK_LEASE=off');
  const exportLine = script.split('\n').find((line) => line.startsWith('export PATH='))!;
  const remoteEnv = Bun.spawnSync(['sh', '-c', `${exportLine}\nprintf '%s' "$REZICS_STACK_LEASE"`], { env });
  expect(remoteEnv.stdout.toString()).toBe('off');
});
