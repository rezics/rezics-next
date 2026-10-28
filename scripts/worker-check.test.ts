import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWorkerCheck, startWorkerCheck, waitWorkerCheck } from './worker-check.ts';
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
    await expect(waitWorkerCheck(id, directory, 20)).rejects.toThrow('Wait timed out');
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await waitWorkerCheck(id, directory)).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(out.join('')).toContain('check: exit status 0');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
  });
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
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await waitWorkerCheck(id, directory)).toBe(9);
    } finally {
      process.stdout.write = write;
    }
    expect(out.join('')).toContain('check: exit status 9');
    expect(out.join('')).toContain('finished failure marker');
    expect(out.join('')).toContain(`check: log .temp/goal/checks/worker-check-`);
  });
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
if (process.env.WORKER_REMOTE_MODE === 'transport') {
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  process.exit(75);
}
if (process.env.WORKER_REMOTE_MODE === 'failure') process.exit(7);
if (process.env.WORKER_REMOTE_MODE === 'failure-75') process.exit(75);
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
