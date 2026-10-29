import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireStackSlot } from './stack-lease.ts';
import { processTreeCpuTicks, runWorkerCheck, startWorkerCheck, waitWorkerCheck } from './worker-check.ts';
import { checkClass, recordPeak } from './check-memory.ts';

const dirs: string[] = [];
const inheritedCheckEnvironment = { ...process.env };

function cleanTestEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete clean[key];
  }
  return clean;
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
});
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(inheritedCheckEnvironment)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    ) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('nested worker checks start with default placement environment', () => {
  const environment = cleanTestEnvironment({
    ...process.env,
    REZICS_CHECK_SLICE: 'outer.slice',
    REZICS_CHECK_RUN: 'outer-run',
    KERNEL_CHECK_REMOTE: '/outer/hosts.json',
    KERNEL_CHECK_ON_REMOTE: '1',
  });
  expect(environment.REZICS_CHECK_SLICE).toBeUndefined();
  expect(environment.REZICS_CHECK_RUN).toBeUndefined();
  expect(environment.KERNEL_CHECK_REMOTE).toBeUndefined();
  expect(environment.KERNEL_CHECK_ON_REMOTE).toBeUndefined();
});

function withQuietAdmission<T>(run: () => Promise<T>): Promise<T> {
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = '/tmp/worker-check-test-memory';
  process.env.REZICS_CHECK_SCOPE = 'off';
  return run().finally(() => {
    for (const key of ['REZICS_CHECK_MEMORY', 'REZICS_CHECK_MEMORY_DIR', 'REZICS_CHECK_SCOPE']) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
}

test('worker-check keeps exit status and writes a log plus failure summary with admission disabled', async () => {
  const directory = mkdtempSync('/tmp/worker-check-test-');
  dirs.push(directory);
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = directory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  process.env.REZICS_CHECK_SCOPE = 'off';
  delete process.env.KERNEL_CHECK_REMOTE;
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await runWorkerCheck(['bun', '-e', 'console.error("failure marker"); process.exit(7)'])).toBe(7);
  } finally {
    process.stdout.write = write;
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
  expect(out.join('')).toContain('check: exit status 7');
  expect(out.join('')).toContain('failure marker');
  const log = out
    .join('')
    .match(/check: log (.+)/)?.[1]
    ?.trim();
  expect(log).toBeTruthy();
  expect(readFileSync(log!, 'utf8')).toContain('failure marker');
});

test('a queued memory lease writes its waiting line repeatedly into the check log', async () => {
  const directory = mkdtempSync('/tmp/worker-check-lease-wait-');
  dirs.push(directory);
  const leaseDirectory = join(directory, 'leases');
  const holder = await acquireStackSlot('holder', { REZICS_STACK_SLOTS: '1', REZICS_STACK_LEASE_DIR: leaseDirectory });
  const old = { ...process.env };
  try {
    for (const [key, value] of Object.entries({
      REZICS_CHECK_MEMORY: 'on',
      REZICS_CHECK_MEMORY_DIR: leaseDirectory,
      REZICS_CHECK_MEMORY_GIB: '1',
      REZICS_CHECK_SCOPE: 'off',
    }))
      process.env[key] = value;
    delete process.env.KERNEL_CHECK_REMOTE;
    const waiting = runWorkerCheck(['bun', '-e', 'console.error("lease completed")'], directory, false, undefined, 15);
    await new Promise((resolveWait) => setTimeout(resolveWait, 55));
    await holder.release();
    expect(await waiting).toBe(0);
  } finally {
    await holder.release();
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
  const logDirectory = join(directory, '.temp/goal/checks');
  const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
  expect(log.match(/stack-lease: worker-check:.*waiting \(1\/1 held, 0 ahead\)/g)?.length).toBeGreaterThanOrEqual(2);
});

test('a timed out wait can wait again by id and receives the same check result', async () => {
  const directory = mkdtempSync('/tmp/worker-check-rewait-');
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const marker = `${directory}/runs`;
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `await Bun.sleep(180); const { openSync, writeSync, closeSync } = await import('node:fs'); const fd = openSync(${JSON.stringify(marker)}, 'wx'); writeSync(fd, 'ran\\n'); closeSync(fd); console.error('completed marker')`,
      ],
      directory,
    );
    const out: string[] = [];
    expect(await waitWorkerCheck(id, directory, 20, { write: (chunk) => out.push(chunk) })).toBe(75);
    expect(out.join('')).toContain('check: still running');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
    out.length = 0;
    expect(await waitWorkerCheck(id, directory, undefined, { write: (chunk) => out.push(chunk) })).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(out.join('')).toContain('check: exit status 0');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
  });
});

test('a queued check timeout prints the latest waiting line and its log path', async () => {
  const root = mkdtempSync('/tmp/worker-check-queued-wait-');
  dirs.push(root);
  const log = '.temp/goal/checks/queued.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'stack-lease: worker-check:kernel waiting (1/1 held, 0 ahead)\n');
  const id = '00000000-0000-4000-8000-000000000006';
  writeRunningRecord(root, id, log, 2_000_000_000);
  const out: string[] = [];
  expect(await waitWorkerCheck(id, root, 0, { write: (chunk) => out.push(chunk) })).toBe(75);
  expect(out.join('')).toContain('check: still running');
  expect(out.join('')).toContain('stack-lease: worker-check:kernel waiting (1/1 held, 0 ahead)');
  expect(out.join('')).toContain(`check: log ${log}`);
});

test('a finished check result remains readable by id after its worker session ends', async () => {
  const directory = mkdtempSync('/tmp/worker-check-finished-');
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'console.error("finished failure marker"); process.exit(9)'], directory);
    // A separate invocation models a retry after the original worker has ended.
    const record = `${directory}/.temp/goal/checks/results/${id}.json`;
    for (
      let attempt = 0;
      attempt < 200 && (!existsSync(record) || !readFileSync(record, 'utf8').includes('"finished"'));
      attempt++
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(readFileSync(record, 'utf8')).toContain('"finished"');
    const out: string[] = [];
    expect(await waitWorkerCheck(id, directory, undefined, { write: (chunk) => out.push(chunk) })).toBe(9);
    expect(out.join('')).toContain('check: exit status 9');
    expect(out.join('')).toContain('finished failure marker');
    expect(out.join('')).toContain(`check: log .temp/goal/checks/worker-check-`);
  });
});

function writeRunningRecord(
  root: string,
  id: string,
  log: string,
  runnerPid: number,
  runnerHost = 'check-host-a',
  reruns = 0,
) {
  const resultDirectory = join(root, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    join(resultDirectory, `${id}.json`),
    JSON.stringify({
      id,
      cwd: root,
      argv: [
        'bun',
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(join(root, 'rerun-marker'))}, 'rerun\\n')`,
      ],
      status: 'running',
      log,
      runnerPid,
      runnerHost,
      ...(reruns ? { reruns } : {}),
    }),
  );
}

test('worker-check --wait reruns once when the runner is gone but its result still says running', async () => {
  const root = mkdtempSync('/tmp/worker-check-dead-runner-');
  dirs.push(root);
  const log = '.temp/goal/checks/dead-runner.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), '');
  const id = '00000000-0000-4000-8000-000000000001';
  writeRunningRecord(root, id, log, 2_000_000_000, hostname());
  const out: string[] = [];
  await withQuietAdmission(async () =>
    expect(await waitWorkerCheck(id, root, 5_000, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(0),
  );
  expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
  expect(out.join('')).toContain(`infrastructure failure (runner process exited) on ${hostname()}`);
  expect(out.join('')).toContain('check: exit status 0');
  const result = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
  expect(result.reruns).toBe(1);
  expect(result.infrastructureFailure).toContain(`old log ${log}`);
});

test('a check whose log has been silent for 10 minutes is stopped and rerun once with host and log reported', async () => {
  const root = mkdtempSync('/tmp/worker-check-stalled-runner-');
  dirs.push(root);
  const log = '.temp/goal/checks/stalled.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), '');
  const stale = new Date(Date.now() - 25);
  utimesSync(join(root, log), stale, stale);
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolveRunner) => runner.once('spawn', resolveRunner));
  const id = '00000000-0000-4000-8000-000000000002';
  writeRunningRecord(root, id, log, runner.pid!, 'stall-host-b');
  const out: string[] = [];
  try {
    await withQuietAdmission(async () =>
      expect(
        await waitWorkerCheck(id, root, 5_000, {
          pollMs: 5,
          stallMs: 10,
          rerunStallMs: 1_000,
          write: (chunk) => out.push(chunk),
        }),
      ).toBe(0),
    );
  } finally {
    runner.kill('SIGKILL');
  }
  expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
  expect(out.join('')).toContain('infrastructure failure (log did not grow for 10 ms) on stall-host-b');
  expect(out.join('')).toContain('check: exit status 0');
  expect(out.join('')).toContain('log .temp/goal/checks/worker-check-');
});

test('a second interrupted runner finishes as infrastructure failure without a third run', async () => {
  const root = mkdtempSync('/tmp/worker-check-second-runner-');
  dirs.push(root);
  const log = '.temp/goal/checks/second.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'last rerun output\n');
  const id = '00000000-0000-4000-8000-000000000003';
  writeRunningRecord(root, id, log, 2_000_000_000, hostname(), 1);
  const out: string[] = [];
  await withQuietAdmission(async () =>
    expect(await waitWorkerCheck(id, root, 100, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(1),
  );
  expect(() => readFileSync(join(root, 'rerun-marker'), 'utf8')).toThrow();
  expect(out.join('')).toContain('second runner failed');
  expect(out.join('')).toContain('check: exit status 1');
  expect(
    JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).infrastructureFailureFinal,
  ).toBe(true);
});

test('an unrelated local pid and a runner recorded on another host are not treated as live runners', async () => {
  for (const [id, pid, host] of [
    ['00000000-0000-4000-8000-000000000004', process.pid, hostname()],
    ['00000000-0000-4000-8000-000000000005', 2_000_000_000, hostname() + '-elsewhere'],
  ] as const) {
    const root = mkdtempSync('/tmp/worker-check-unrelated-runner-');
    dirs.push(root);
    const log = '.temp/goal/checks/live.log';
    mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
    writeFileSync(join(root, log), 'queued line\n');
    writeRunningRecord(root, id, log, pid, host);
    const out: string[] = [];
    await withQuietAdmission(async () =>
      expect(await waitWorkerCheck(id, root, 20, { pollMs: 5, stallMs: 1000, write: (chunk) => out.push(chunk) })).toBe(
        75,
      ),
    );
    expect(out.join('')).toContain('queued line');
    expect(
      JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).reruns,
    ).toBeUndefined();
  }
});

function workerFixture(): { root: string; memory: string; remoteEvents: string; localMarker: string } {
  const root = mkdtempSync('/tmp/worker-check-remote-test-');
  dirs.push(root);
  const memory = join(root, 'memory');
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  const remoteEvents = join(root, 'remote-events');
  const localMarker = join(root, 'local-marker');
  writeFileSync(
    join(scripts, 'remote-check.ts'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.WORKER_REMOTE_EVENTS!, 'remote\\n');
appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.args', JSON.stringify(process.argv.slice(2)));
if (process.env.WORKER_REMOTE_MODE === 'transport') {
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  process.exit(75);
}
if (process.env.WORKER_REMOTE_MODE === 'failure') process.exit(7);
if (process.env.WORKER_REMOTE_MODE === 'failure-75') process.exit(75);
if (process.env.WORKER_REMOTE_MODE === 'queued') {
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
}
console.error('remote-check: run used 2.000 CPU seconds over 1.000 s (2.00 cores), peak memory 3072 MiB on check-a');
process.exit(0);
`,
  );
  return { root, memory, remoteEvents, localMarker };
}

function workerEnv(fixture: ReturnType<typeof workerFixture>, hostsPath?: string): Record<string, string | undefined> {
  process.env.REZICS_CHECK_MEMORY = 'on';
  process.env.REZICS_CHECK_MEMORY_DIR = fixture.memory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  process.env.REZICS_CHECK_SCOPE = 'off';
  process.env.WORKER_REMOTE_EVENTS = fixture.remoteEvents;
  process.env.WORKER_REMOTE_MODE = 'success';
  if (hostsPath === undefined) delete process.env.KERNEL_CHECK_REMOTE;
  else process.env.KERNEL_CHECK_REMOTE = hostsPath;
  return process.env;
}

function localCommand(marker: string): string[] {
  return [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.REZICS_CHECK_MEMORY_LEASE ?? 'missing')`,
  ];
}

test('worker checks at least 2 GiB run remotely and record the remote peak under their class', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root)).toBe(0);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    const remoteArgv = JSON.parse(readFileSync(fixture.remoteEvents + '.args', 'utf8')) as string[];
    expect(remoteArgv.slice(0, 3)).toEqual(['--memory-gib', '2', fixture.root]);
    expect(JSON.parse(readFileSync(join(fixture.memory, 'peaks.json'), 'utf8'))[commandClass]).toEqual([
      2 * 2 ** 30,
      2 * 2 ** 30,
      2 * 2 ** 30,
      3 * 2 ** 30,
    ]);
    expect(
      readFileSync(
        join(fixture.root, '.temp/goal/checks', readdirSync(join(fixture.root, '.temp/goal/checks'))[0]!),
        'utf8',
      ),
    ).toContain('peak memory 3072 MiB');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('remote slot wait heartbeats emitted by the runner reach the local check log', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.WORKER_REMOTE_MODE = 'queued';
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root)).toBe(0);
    const logDirectory = join(fixture.root, '.temp/goal/checks');
    const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
    expect(
      log.match(/remote-check: every check slot is busy; waiting.*check-a 0\/1 free/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('lighter classes, --local, and unreadable hosts files run locally under the memory lease', async () => {
  for (const mode of ['light', 'local', 'unreadable'] as const) {
    const fixture = workerFixture();
    const old = { ...process.env };
    try {
      workerEnv(fixture, join(fixture.root, 'hosts.json'));
      writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
      const command = localCommand(fixture.localMarker);
      if (mode === 'light') {
        const commandClass = checkClass(command, fixture.root);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
      } else if (mode === 'local') command.unshift('--local');
      else process.env.KERNEL_CHECK_REMOTE = join(fixture.root, 'missing-hosts.json');
      expect(await runWorkerCheck(command, fixture.root)).toBe(0);
      expect(readFileSync(fixture.localMarker, 'utf8')).not.toBe('missing');
      expect(() => readFileSync(fixture.remoteEvents, 'utf8')).toThrow();
    } finally {
      for (const key of [
        'REZICS_CHECK_MEMORY',
        'REZICS_CHECK_MEMORY_DIR',
        'REZICS_CHECK_MEMORY_GIB',
        'REZICS_CHECK_SCOPE',
        'WORKER_REMOTE_EVENTS',
        'WORKER_REMOTE_MODE',
        'KERNEL_CHECK_REMOTE',
      ]) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key]!;
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('a remote transport failure is logged and rerun once locally, but a failed command is not retried', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.WORKER_REMOTE_MODE = 'transport';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(0);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(readFileSync(fixture.localMarker, 'utf8')).not.toBe('missing');
    const logDirectory = join(fixture.root, '.temp/goal/checks');
    const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
    expect(log).toContain(
      'remote transport failed: remote-check: connection to host failed during rsync before a result',
    );

    rmSync(fixture.remoteEvents, { force: true });
    rmSync(fixture.localMarker, { force: true });
    process.env.WORKER_REMOTE_MODE = 'failure';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(7);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(() => readFileSync(fixture.localMarker, 'utf8')).toThrow();

    rmSync(fixture.remoteEvents, { force: true });
    process.env.WORKER_REMOTE_MODE = 'failure-75';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(75);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(() => readFileSync(fixture.localMarker, 'utf8')).toThrow();
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

function recoveryFixture(): string {
  const parent = join(import.meta.dir, '../.temp/worker-check-recovery-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'check-'));
  dirs.push(root);
  return root;
}

async function untilRecorded(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test('a silent verified runner and its command are stopped before the detached rerun completes', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'first-command');
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `
      const fs = require('node:fs');
      if (fs.existsSync(${JSON.stringify(marker)})) { console.error('rerun completed'); process.exit(0); }
      fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
      ],
      root,
    );
    const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
    await untilRecorded(() => existsSync(marker));
    const original = JSON.parse(readFileSync(resultPath, 'utf8'));
    const stale = new Date(Date.now() - 100);
    utimesSync(join(root, original.log), stale, stale);
    const out: string[] = [];
    expect(
      await waitWorkerCheck(id, root, 5_000, {
        stallMs: 50,
        rerunStallMs: 2_000,
        pollMs: 5,
        write: (line) => out.push(line),
      }),
    ).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(result.runnerPid).not.toBe(original.runnerPid);
    expect(result.log).not.toBe(original.log);
    expect(result.reruns).toBe(1);
    expect(out.join('')).toContain('infrastructure failure (log did not grow for 50 ms)');
    const commandPid = readFileSync(marker, 'utf8');
    await untilRecorded(() => {
      try {
        return readFileSync(`/proc/${commandPid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z');
      } catch {
        return true;
      }
    });
  });
});

test('CPU sampling follows parent links, includes descendants and excludes unrelated processes', () => {
  const root = recoveryFixture();
  const stat = (pid: number, parent: number, user: number, system: number) => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(
      join(root, String(pid), 'stat'),
      `${pid} (command with ) parentheses) S ${parent} 0 0 0 0 0 0 0 0 0 ${user} ${system}\n`,
    );
  };
  stat(10, 1, 0, 0);
  stat(11, 10, 110, 20);
  stat(12, 11, 30, 40);
  stat(13, 1, 500, 600);
  mkdirSync(join(root, '14')); // A process that exited before its stat could be read.
  expect(processTreeCpuTicks(10, root)).toBe(200);
  expect(processTreeCpuTicks(11, root)).toBe(200);
  expect(processTreeCpuTicks(99, root)).toBeUndefined();
  expect(processTreeCpuTicks(10, join(root, 'unavailable'))).toBeUndefined();
});

test('a quiet local command with CPU progress is not stopped as stalled and its runner ends cleanly', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'progress-pid');
  const procRoot = join(root, 'fake-proc');
  mkdirSync(procRoot);
  const oldInterval = process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS;
  const oldProcRoot = process.env.REZICS_CHECK_PROC_ROOT;
  const oldPidFile = process.env.REZICS_CHECK_PROGRESS_PID_FILE;
  process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS = '5';
  process.env.REZICS_CHECK_PROC_ROOT = procRoot;
  process.env.REZICS_CHECK_PROGRESS_PID_FILE = marker;
  try {
    await withQuietAdmission(async () => {
      const id = startWorkerCheck(
        ['bun', '-e', 'const end = Date.now() + 700; while (Date.now() < end) {}'],
        root,
      );
      const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
      const originalLog = JSON.parse(readFileSync(resultPath, 'utf8')).log as string;
      await untilRecorded(() => existsSync(marker));
      const commandPid = Number(readFileSync(marker, 'utf8'));
      mkdirSync(join(procRoot, String(commandPid)));
      const stat = ['S', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '160', '0'].join(' ');
      const statFile = join(procRoot, String(commandPid), 'stat');
      writeFileSync(statFile, `${commandPid} (quiet-command) ${stat}\n`);
      expect(processTreeCpuTicks(commandPid, procRoot)).toBe(160);
      let fakeTicks = 160;
      const cpuProgress = setInterval(() => {
        fakeTicks += 100;
        const advancingStat = ['S', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', String(fakeTicks), '0'].join(' ');
        writeFileSync(statFile, `${commandPid} (quiet-command) ${advancingStat}\n`);
      }, 20);
      const out: string[] = [];
      const result = await waitWorkerCheck(id, root, 2_000, { stallMs: 200, pollMs: 5, write: (line) => out.push(line) });
      clearInterval(cpuProgress);
      const record = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
      const log = readFileSync(join(root, originalLog), 'utf8');
      expect(result, `${out.join('')}\n${log}`).toBe(0);
      expect(out.join('')).not.toContain('infrastructure failure');
      expect(record.reruns).toBeUndefined();
      expect(readFileSync(join(root, record.log), 'utf8')).toContain('worker-check: running, 1 CPU seconds');
      await untilRecorded(() => !existsSync(`/proc/${commandPid}`));
      const runnerPid = record.runnerPid as number;
      await untilRecorded(() => {
        try {
          return readFileSync(`/proc/${runnerPid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z');
        } catch {
          return true;
        }
      });
    });
  } finally {
    if (oldInterval === undefined) delete process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS;
    else process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS = oldInterval;
    if (oldProcRoot === undefined) delete process.env.REZICS_CHECK_PROC_ROOT;
    else process.env.REZICS_CHECK_PROC_ROOT = oldProcRoot;
    if (oldPidFile === undefined) delete process.env.REZICS_CHECK_PROGRESS_PID_FILE;
    else process.env.REZICS_CHECK_PROGRESS_PID_FILE = oldPidFile;
  }
});

test('a quiet local command with no CPU progress is stopped by the stall rule', async () => {
  const root = recoveryFixture();
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'setInterval(() => {}, 1000)'], root);
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 2_000, { stallMs: 50, rerunStallMs: 50, pollMs: 5, write: (line) => out.push(line) })).toBe(1);
    expect(out.join('')).toContain('infrastructure failure (log did not grow for 50 ms)');
    expect(readFileSync(join(root, JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).log), 'utf8')).not.toContain('worker-check: running');
  });
});

test('a detached recovery survives a bounded wait and returns its own failing exit status on the same id', async () => {
  const root = recoveryFixture();
  const id = '00000000-0000-4000-8000-000000000007';
  const log = '.temp/goal/checks/original.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'original output\n');
  writeRunningRecord(root, id, log, 2_000_000_000, hostname());
  const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
  const initial = JSON.parse(readFileSync(resultPath, 'utf8'));
  initial.argv = ['bun', '-e', 'await Bun.sleep(300); console.error("rerun failed"); process.exit(7)'];
  writeFileSync(resultPath, JSON.stringify(initial));
  await withQuietAdmission(async () => {
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 50, { pollMs: 5, write: (line) => out.push(line) })).toBe(75);
    expect(out.join('')).toContain('check: still running');
    const rerun = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(rerun.runnerPid).not.toBe(process.pid);
    expect(readFileSync(`/proc/${rerun.runnerPid}/cmdline`, 'utf8')).toContain(`--run\0${id}\0`);
    out.length = 0;
    expect(await waitWorkerCheck(id, root, 5_000, { write: (line) => out.push(line) })).toBe(7);
    expect(out.join('')).toContain('infrastructure failure');
    expect(out.join('')).toContain('check: exit status 7');
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).reruns).toBe(1);
  });
});

test('a second silent runner finishes with infrastructure failure and no third command', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'commands');
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n'); setInterval(() => {}, 1000)`,
      ],
      root,
    );
    const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
    await untilRecorded(() => existsSync(marker));
    const first = JSON.parse(readFileSync(resultPath, 'utf8'));
    const stale = new Date(Date.now() - 100);
    utimesSync(join(root, first.log), stale, stale);
    expect(await waitWorkerCheck(id, root, 5_000, { stallMs: 50, rerunStallMs: 500, pollMs: 5, write: () => {} })).toBe(
      1,
    );
    expect(readFileSync(marker, 'utf8')).toBe('run\nrun\n');
    const final = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(final.status).toBe('finished');
    expect(final.reruns).toBe(1);
    expect(final.infrastructureFailureFinal).toBe(true);
    expect(await waitWorkerCheck(id, root, 0, { write: () => {} })).toBe(1);
  });
});

test('a command exit status 75 is distinguished from a running check', async () => {
  const root = recoveryFixture();
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'process.exit(75)'], root);
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 5_000, { write: (line) => out.push(line) })).toBe(75);
    expect(out.join('')).toContain('check: exit status 75');
    expect(out.join('')).not.toContain('check: still running');
  });
});

test('memory wait heartbeats keep a queued check alive across successive bounded waits without a recorded pid', async () => {
  const root = recoveryFixture();
  const memory = join(root, 'memory');
  const holder = await acquireStackSlot('holder', { REZICS_STACK_SLOTS: '1', REZICS_STACK_LEASE_DIR: memory });
  const old = { ...process.env };
  const id = '00000000-0000-4000-8000-000000000008';
  const log = '.temp/goal/checks/queued.log';
  const record = { id, cwd: root, status: 'running', log, argv: ['bun', '-e', 'console.error("admitted")'] };
  const resultDirectory = join(root, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(join(resultDirectory, `${id}.json`), JSON.stringify(record));
  Object.assign(process.env, {
    REZICS_CHECK_MEMORY: 'on',
    REZICS_CHECK_MEMORY_DIR: memory,
    REZICS_CHECK_MEMORY_GIB: '1',
    REZICS_CHECK_SCOPE: 'off',
  });
  delete process.env.KERNEL_CHECK_REMOTE;
  const command = runWorkerCheck(record.argv, root, false, join(root, log), 15);
  try {
    await untilRecorded(() => readFileSync(join(root, log), 'utf8').includes('waiting (1/1 held, 0 ahead)'));
    for (let attempt = 0; attempt < 5; attempt++) {
      const out: string[] = [];
      expect(await waitWorkerCheck(id, root, 60, { stallMs: 200, pollMs: 5, write: (line) => out.push(line) })).toBe(
        75,
      );
      expect(out.join('')).toContain('waiting (1/1 held, 0 ahead)');
      expect(JSON.parse(readFileSync(join(resultDirectory, `${id}.json`), 'utf8')).reruns).toBeUndefined();
    }
  } finally {
    await holder.release();
    await command;
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('a worker already on a check host runs its command locally without relaying again', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.KERNEL_CHECK_ON_REMOTE = '1';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root, false)).toBe(0);
    expect(existsSync(fixture.localMarker)).toBe(true);
    expect(existsSync(fixture.remoteEvents)).toBe(false);
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'KERNEL_CHECK_ON_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});
