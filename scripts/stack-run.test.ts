import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { onCheckHost, runOnCheckHost } from './stack-run.ts';
import {
  REMOTE_TRANSPORT_FAILURE,
  ROOT,
  requestExecutionCancellation,
  type RemoteCheckSettlement,
} from './remote-check.ts';
import { runWorkerCheck } from './worker-check.ts';
import { checkClass, recordPeak } from './check-memory.ts';

const repository = resolve(import.meta.dir, '..');
const stackRun = join(repository, 'scripts/stack-run.ts');
const databaseScript = join(repository, 'services/kernel/scripts/database.ts');
const searchScript = join(repository, 'services/kernel/scripts/search.ts');

// A fake ssh answers each kind of remote script by what it contains, so the tests see which host was chosen, what ran
// there and what was released, without a network.
const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const positionals: string[] = [];
const options: string[] = [];
const reject = (detail: string): never => {
  try { appendFileSync(dir + '/log.jsonl', JSON.stringify({ kind: 'reject', detail }) + '\\n'); } catch {}
  process.stderr.write('fake ssh: ' + detail + '\\n');
  process.exit(2);
};
for (let index = 0; index < args.length;) {
  const argument = args[index]!;
  if (argument === '-o' || argument === '-i' || argument === '-O') {
    const value = args[index + 1];
    if (!value || value.startsWith('-')) reject('option ' + argument + ' must have one value');
    if (argument === '-o' && (!value.includes('=') || value.startsWith('='))) reject('invalid -o configuration');
    if (argument === '-O' && value !== 'exit') reject('unsupported -O operation');
    options.push(argument, value);
    index += 2;
  } else if (argument.startsWith('-')) reject('unexpected option ' + argument);
  else {
    positionals.push(argument);
    index += 1;
  }
}
const controlExit = options.includes('-O');
if (options.filter((argument) => argument === '-O').length > 1) reject('duplicate -O operation');
if (positionals.length !== (controlExit ? 1 : 2)) reject('expected host and optional command positionals');
const address = positionals[0]!;
if (!address.startsWith('ops@') || !address.endsWith('.test')) reject('invalid host position');
const script = controlExit ? 'REMOTE_CHECK_CONTROL_CLOSE' : positionals[1]!;
const config = JSON.parse(readFileSync(dir + '/config.json', 'utf8'))[address] ?? {};
const controlPath = options.find((option) => option.startsWith('ControlPath='));
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, argv: args, options, ...event }) + '\\n');
const hostKey = address.replace(/[^a-z0-9]/gi, '_');
const slotHeld = () => readdirSync(dir).some((name) => name.startsWith(hostKey + '.slot.') && !name.endsWith('.memory'));
const count = (name: string) => {
  const file = dir + '/' + hostKey + '.' + name;
  const seen = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(seen + 1));
  return seen;
};
if (controlExit) {
  log({ kind: 'control-close', controlPath });
  process.exit(0);
}
if (script.includes('REMOTE_CHECK_CONTROL_PROBE')) {
  log({ kind: 'control-probe', controlPath, slotHeld: slotHeld() });
  console.log('REMOTE_CHECK_CONTROL_OK');
  process.exit(0);
}
if (script.includes('MemAvailable')) {
  const slots = config.slots ?? 2;
  const ordinarySlotsUsed = Array.from({ length: Math.max(0, slots - 1) }, (_, index) => existsSync(dir + '/' + hostKey + '.slot.' + index)).filter(Boolean).length;
  const expressSlotUsed = existsSync(dir + '/' + hostKey + '.slot.express');
  log({ kind: 'probe', ordinarySlotsUsed, expressSlotUsed });
  if (config.down) process.exit(255);
  console.log(
    'MEMORY_CURRENT -\\nMEMORY_MAX -\\nMEMORY_HEADROOM ' + (config.available ?? 16 * 2 ** 30) +
      '\\nAVAILABLE ' + (config.available ?? 16 * 2 ** 30) +
      '\\nMEMORY_RESERVED 0' +
      '\\nPROCESSORS 16\\nSLICE_PROCESSORS ' + ((config.cpuQuotaPercent ?? 800) / 100) +
      '\\nLOAD 0\\nORDINARY_SLOTS_USED ' + ordinarySlotsUsed +
      '\\nEXPRESS_SLOT_USED ' + (expressSlotUsed ? 1 : 0) + '\\nGATE_WAITING 0' +
      '\\nMULTI_SLOT_WAITING_SLOTS 0\\nMULTI_SLOT_WAITING_ID -' +
      '\\nLANDING_WAITING_SLOTS 0\\nLANDING_WAITING_ID -' +
      '\\nLANDING_WAITING_STARTED -\\nLANDING_WAITING_ESTIMATE_MS -1\\nLANDING_WAITING_MEMORY_BYTES 2684354560' +
      '\\nTMP_BYTES 17179869184\\nTMP_INODES 1000000',
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
  log({ kind: 'base', slotHeld: slotHeld() });
  console.log('BASE -\\nAGE -\\nZSTD 0');
} else if (script.includes('REMOTE_CHECK_BASE_REFRESH') && !script.includes('systemd-run')) {
  log({ kind: 'base-refresh' });
} else if (script.includes('REMOTE_CHECK_PREPARED_INPUTS')) {
  log({ kind: 'prepared-inputs' });
  if (config.preparedInputs) console.log(JSON.stringify(config.preparedInputs));
  else process.exit(4);
} else if (script.includes('REMOTE_CHECK_SLOT_')) {
  const requested = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const slotClass = script.match(/# REMOTE_CHECK_SLOT_CLASS (ordinary|short)/)?.[1] ?? 'ordinary';
  const call = count('slot');
  if (call < (config.busy ?? 0)) {
  log({ kind: 'slot', granted: false, reason: 'busy', slotClass, slotHeld: slotHeld(), script });
    process.exit(75);
  }
  const grants = existsSync(dir + '/' + hostKey + '.granted')
    ? Number(readFileSync(dir + '/' + hostKey + '.granted', 'utf8'))
    : 0;
  if (config.grantOnly !== undefined && grants >= config.grantOnly) {
    log({ kind: 'slot', granted: false, reason: 'grant-limit', slotClass, slotHeld: slotHeld(), script });
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
    log({ kind: 'slot', granted: false, reason: 'occupied', slotClass, slotHeld: slotHeld(), script });
    process.exit(75);
  }
  const selected = free.slice(0, requested);
  for (const slot of selected) mkdirSync(dir + '/' + hostKey + '.slot.' + slot);
  writeFileSync(dir + '/' + hostKey + '.granted', String(grants + selected.length));
  for (const slot of selected) log({ kind: 'slot', granted: true, slotClass, script, slot, slotHeld: slotHeld() });
  console.log('SLOTS ' + requested);
  const release = () => {
    for (const slot of selected) {
      rmSync(dir + '/' + hostKey + '.slot.' + slot, { recursive: true, force: true });
      log({ kind: 'release', slot, slotHeld: slotHeld() });
    }
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('systemd-run')) {
  log({ kind: 'run', script, identity: args[args.indexOf('-i') + 1], slotHeld: slotHeld() });
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
} else if (script.includes('REMOTE_CHECK_RETURNS')) {
  log({ kind: 'returns', script, slotHeld: slotHeld() });
  for (const path of [...script.matchAll(/^# PATH (.+)$/gm)]) console.log('ABSENT ' + path[1]);
  console.log('MANIFEST ' + Buffer.from('[]').toString('base64'));
} else if (script.includes('REMOTE_CHECK_PHYSICAL_RESOURCES')) {
  // This fixture has no owned native cgroup counters.
} else if (script.includes('CLEANED')) {
  const run = script.match(/^run_id='?([^'\\r\\n]+)'?/m)?.[1] ?? 'unknown';
  log({ kind: 'cleanup', script, slotHeld: slotHeld() });
  console.log('CLEANED ' + run);
} else {
  log({ kind: 'cleanup', script, slotHeld: slotHeld() });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync, readdirSync } from 'node:fs';
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
const remote = args.find((argument) => /ops@[^:]+\\.test:/.test(argument));
const hostKey = (remote ?? '').slice(0, (remote ?? '').indexOf(':')).replace(/[^a-z0-9]/gi, '_');
const isBack = args.at(-1)?.endsWith('/') && !args.at(-1)?.startsWith('ops@');
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  step: isBack ? 'returns copy' : 'workspace upload',
  destination: args.at(-1),
  files: input.split('\\0').filter(Boolean),
  slotHeld: readdirSync(process.env.FAKE_DIR!).some((name) => name.startsWith(hostKey + '.slot.') && !name.endsWith('.memory')),
}) + '\\n');
if (process.env.FAKE_RSYNC_FAIL === '1') process.exit(12);
`;

const fakeDocker = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({ kind: 'docker', args: process.argv.slice(2) }) + '\\n');
process.exit(99);
`;

function nodeFixture(source: string): string {
  // Keep fake SSH and rsync startup cheap while these fixtures exercise remote placement.
  const javascript = new Bun.Transpiler({ loader: 'ts', target: 'node' })
    .transformSync(source.replace(/^#![^\r\n]*(?:\r?\n|$)/, ''))
    .replace(/^import (\{[^\r\n]*\}) from "([^"]+)";$/gm, 'const $1 = require("$2");')
    .replace(/await import\("([^"]+)"\)/g, 'require("$1")')
    .replaceAll('Bun.stdin.text()', 'readStdin()')
    .replaceAll('Bun.sleep(', 'sleep(');
  if (/\bBun\./.test(javascript)) throw new Error('Node fake transport still contains a Bun runtime call');
  return `#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};
(async () => {
${javascript}
})().catch((error) => { console.error(error); process.exit(1); });
`;
}

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
    writeFileSync(file, nodeFixture(source));
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
        performance: true,
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

function assertMockProbeReady(fixture: ReturnType<typeof scenario>): void {
  const probe = Bun.spawnSync(
    [
      join(root, 'bin', 'ssh'),
      '-i',
      '/keys/a',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      'ops@a.test',
      'MemAvailable',
    ],
    { env: fixture.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  expect(probe.exitCode, probe.stderr.toString()).toBe(0);
  expect(probe.stdout.toString()).toContain('PROCESSORS 16');
  writeFileSync(join(fixture.env.FAKE_DIR!, 'log.jsonl'), '');
}

function workspace(): string {
  const directory = mkdtempSync(join(root, 'workspace-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/tracked.ts'), 'export {};\n');
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, packageManager: 'bun@1.2.3' }) + '\n',
  );
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  const installed = join(directory, 'node_modules/bun');
  mkdirSync(join(installed, 'bin'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'bun', version: '1.2.3' }));
  writeFileSync(
    join(installed, 'bin/bun.exe'),
    `#!/bin/sh
if [ "$1" = --eval ]; then
  printf '%s\\n' '{"version":"1.2.3","revision":"${'c'.repeat(40)}"}'
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(installed, 'bin/bun.exe'), 0o755);
  return directory;
}

function lockedMemorySlots(directory: string, capacity: number): number[] {
  const locked: number[] = [];
  for (let index = 1; index <= capacity; index++) {
    const result = spawnSync('flock', ['-n', '-E', '75', join(directory, `slot-${index}.lock`), 'true'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    if (result.status === 75) locked.push(index);
    else if (result.status !== 0) throw new Error(result.stderr || 'could not inspect check-memory slot');
  }
  return locked;
}

test('placement memory: explicit local placement and a nested stack runner cannot retain local memory slots during remote admission or execute local work without its required memory admission', async () => {
  const { env: remoteEnv, events } = scenario({ a: { available: 30e9, exit: 5 } });
  const directory = workspace();
  const memory = join(directory, '.temp/check-memory');
  const localMarker = join(directory, 'nested-local.started');
  const old = { ...process.env };
  const nested = `import { stackRun } from ${JSON.stringify(stackRun)};
const result = await stackRun(
  { label: 'nested placement', root: process.cwd(), cwd: process.cwd(), command: ['true'] },
  async () => { require('node:fs').writeFileSync(${JSON.stringify(localMarker)}, process.env.REZICS_CHECK_MEMORY_LEASE ?? 'missing'); await Bun.sleep(150); return 0; },
  process.env,
);
process.exitCode = result;`;
  const command = [process.execPath, '--eval', nested];
  const commandClass = checkClass(command, directory);
  for (let count = 0; count < 3; count++) recordPeak(memory, commandClass, 4 * 2 ** 30);
  const oldKeys = new Set(Object.keys(process.env));
  Object.assign(process.env, {
    ...remoteEnv,
    REZICS_CHECK_MEMORY: 'on',
    REZICS_CHECK_MEMORY_DIR: memory,
    REZICS_CHECK_MEMORY_GIB: '4',
    REZICS_CHECK_SCOPE: 'off',
    REZICS_STACK_SLOTS: '1',
    REZICS_STACK_LEASE_DIR: join(directory, '.temp/stack-lease'),
  });
  try {
    const running = runWorkerCheck(['--local', ...command], directory, false);
    for (let attempt = 0; attempt < 200 && !existsSync(localMarker); attempt++) await Bun.sleep(5);
    expect(existsSync(localMarker)).toBe(true);
    expect(readFileSync(localMarker, 'utf8')).not.toBe('missing');
    expect(lockedMemorySlots(memory, 4)).toEqual([1, 2, 3, 4]);
    expect(events().filter((event) => event.kind === 'probe')).toEqual([]);
    expect(await running).toBe(0);
    expect(lockedMemorySlots(memory, 4)).toEqual([]);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!oldKeys.has(key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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

async function stackWithFixtureDeadline(
  fixture: ReturnType<typeof scenario>,
  command: string[],
  options: string[] = [],
  directory = workspace(),
): Promise<{ code: number; stdout: string; stderr: string; directory: string }> {
  const child = Bun.spawn(
    ['bun', stackRun, ...options, 'the run', directory, join(directory, 'src'), '--', ...command],
    {
      cwd: repository,
      env: fixture.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
    ([code, stdout, stderr]) => ({ code, stdout, stderr, directory }),
  );
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !fixture.events().some((event) => event.kind === 'run')) await Bun.sleep(10);
  if (!fixture.events().some((event) => event.kind === 'run')) {
    child.kill('SIGTERM');
    const stopped = await result;
    throw new Error(
      `mock did not reach its native run; events=${JSON.stringify(fixture.events())}; stderr=${stopped.stderr}`,
    );
  }
  return result;
}

async function missingGenericEvidenceRun(
  environment: Record<string, string>,
  directory: string,
  events: () => Event[],
) {
  const source = `const { remoteCheck } = await import(${JSON.stringify(join(repository, 'scripts/remote-check.ts'))});
let settlement;
let outcome;
try {
  const code = await remoteCheck({
    hosts: [{ name: 'a', performance: true, address: 'ops@a.test', identity: '/keys/a', memoryMaxGiB: 16,
      cpuQuotaPercent: 800, slots: 2, processorsPerSlot: 4 }],
    workspace: process.env.TEST_WORKSPACE,
    command: ['true'],
    expectedSourceSha256: '${'a'.repeat(64)}',
    returns: ['missing-output.txt'],
    settled: (receipt) => { settlement = receipt; },
  }, new AbortController().signal);
  outcome = { kind: 'returned', code };
} catch (error) {
  outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify({ outcome, settlement }) + '\\n');
`;
  const child = Bun.spawn([process.execPath, '--eval', source], {
    cwd: repository,
    env: { ...environment, TEST_WORKSPACE: directory },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let exited = false;
  const childExit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const result = Promise.all([childExit, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !exited && !events().some((event) => event.kind === 'run')) await Bun.sleep(10);
  if (!exited && !events().some((event) => event.kind === 'run')) {
    child.kill('SIGTERM');
  }
  const [code, stdout, stderr] = await result;
  const eventSummary = events().map(({ kind, address, granted, reason }) => ({ kind, address, granted, reason }));
  expect(code, `${stderr} events=${JSON.stringify(eventSummary)}`).toBe(0);
  if (!events().some((event) => event.kind === 'run')) {
    throw new Error(
      `mock exited without reaching its native run; stdout=${stdout}; events=${JSON.stringify(eventSummary)}`,
    );
  }
  return {
    ...(JSON.parse(stdout.trim()) as {
      outcome: { kind: string; code?: number; message?: string };
      settlement: RemoteCheckSettlement;
    }),
    stderr,
  };
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
  const hostEvents = seen.filter((event) => event.address === 'ops@b.test');
  const kinds = hostEvents.map((event) => event.kind);
  const runAt = kinds.indexOf('run');
  const releaseAt = kinds.indexOf('release');
  const cleanupAt = kinds.indexOf('cleanup');
  expect(hostEvents[runAt]!.slotHeld).toBe(true);
  expect(hostEvents[releaseAt]!.slotHeld).toBe(false);
  expect(runAt).toBeLessThan(releaseAt);
  expect(releaseAt).toBeLessThan(cleanupAt);
  expect(existsSync(lease)).toBe(false);
}, 30_000);

test('ordinary remote transport keeps the native outcome and declared returns/cleanup without generic prepared evidence', async () => {
  const fixture = scenario({ a: { available: 20e9, exit: 7 } });
  assertMockProbeReady(fixture);
  const directory = workspace();
  const result = await stackWithFixtureDeadline(fixture, ['true'], ['--returns', 'missing-output.txt'], directory);
  const eventSummary = fixture
    .events()
    .map(({ kind, address, granted, reason }) => ({ kind, address, granted, reason }));
  expect(result.code, `${result.stderr} ${JSON.stringify(eventSummary)}`).toBe(7);
  const events = fixture.events();
  expect(events.some((event) => event.kind === 'prepared-inputs')).toBe(false);
  const runIndex = events.findIndex((event) => event.kind === 'run');
  const releaseIndex = events.findIndex((event) => event.kind === 'release');
  const returnsIndex = events.findIndex((event) => event.kind === 'returns');
  const cleanupIndex = events.findIndex((event) => event.kind === 'cleanup');
  expect(runIndex).toBeGreaterThanOrEqual(0);
  expect(releaseIndex).toBeGreaterThan(runIndex);
  expect(returnsIndex).toBeGreaterThan(releaseIndex);
  expect(cleanupIndex).toBeGreaterThan(returnsIndex);
  expect(String(events[returnsIndex]!.script)).toContain('# PATH missing-output.txt');
  expect(events[cleanupIndex]!.script).toContain('CLEANED');
});

test('generic remote transport still requires explicitly requested prepared source evidence', async () => {
  const fixture = scenario({ a: { available: 20e9, exit: 7 } });
  assertMockProbeReady(fixture);
  const result = await missingGenericEvidenceRun(fixture.env, workspace(), fixture.events);
  expect(result.outcome).toEqual({
    kind: 'error',
    message: 'remote-check: prepared source/generated input evidence is unavailable',
  });
  expect(result.settlement.native).toMatchObject({ host: 'a', exitCode: 7 });
  expect(result.settlement.preparedInputs).toBeNull();
  expect(result.settlement.returns).toMatchObject({ status: 'missing', missing: ['missing-output.txt'] });
  expect(result.settlement.cleanup).toMatchObject({ status: 'verified', runDirectoryRemoved: true });
  expect(result.settlement.transportChildReaped).toBe(true);
  const events = fixture.events();
  const evidenceIndex = events.findIndex((event) => event.kind === 'prepared-inputs');
  const returnsIndex = events.findIndex((event) => event.kind === 'returns');
  const cleanupIndex = events.findIndex((event) => event.kind === 'cleanup');
  expect(evidenceIndex).toBeGreaterThan(events.findIndex((event) => event.kind === 'run'));
  expect(returnsIndex).toBeGreaterThan(evidenceIndex);
  expect(cleanupIndex).toBeGreaterThan(returnsIndex);
});

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

test('stack-run shares the estimate-derived host lifetime for ordinary, multi-slot and nested callers', async () => {
  for (const flags of [[], ['--slots', '2']]) {
    const fixture = scenario({ a: { available: 40e9, slots: 4 } });
    expect((await stack(fixture.env, ['true'], [...flags, '--estimate-ms', '3000'])).code).toBe(0);
    expect(fixture.events().find((event) => event.kind === 'run')?.script).toContain(
      '# REMOTE_CHECK_RUN_LIFETIME_MS 9000',
    );
  }
  const fixture = scenario({ a: { available: 40e9, slots: 4 } });
  const result = await runOnCheckHost(
    { label: 'nested', root: `${ROOT}/runs/outer`, cwd: `${ROOT}/runs/outer`, command: ['true'], estimateMs: 10 },
    fixture.env,
  );
  expect(result).toBeNull();
  expect(fixture.events()).toEqual([]);
});

test('a refused physical run keeps its predicate primary and cannot start nested host discovery', async () => {
  const fixture = scenario({ a: { available: 40e9, slots: 4 } });
  const run = `${ROOT}/runs/m7v0a9-k1a2b3c4`;
  const diagnostics: string[] = [];
  const original = console.error;
  let remoteAttempts = 0;
  console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(' '));
  let result: number | null = null;
  try {
    result = await runOnCheckHost(
      {
        label: 'kernel typecheck',
        root: run,
        cwd: `${run}/services/kernel`,
        command: ['bun', 'scripts/typecheck.ts'],
      },
      fixture.env,
      async () => {
        remoteAttempts += 1;
        return 0;
      },
      () => ({ outcome: 'refused', reason: 'supervisor-marker-invalid' }),
    );
  } finally {
    console.error = original;
  }
  expect(result).toBe(REMOTE_TRANSPORT_FAILURE);
  expect(diagnostics).toEqual([
    'stack-run: kernel typecheck physical run recognition refused (supervisor-marker-invalid)',
  ]);
  expect(remoteAttempts).toBe(0);
  expect(fixture.events()).toEqual([]);
});

test('durable cancellation forbids remote and local stack starts even when every host is unreachable', async () => {
  const fixture = scenario({ a: { down: true } });
  const cancellation = { file: join(fixture.env.FAKE_DIR!, 'cancel.json'), id: 'owned-stack-execution' };
  requestExecutionCancellation(cancellation);
  fixture.env.REMOTE_CHECK_CANCELLATION_FILE = cancellation.file;
  fixture.env.REMOTE_CHECK_CANCELLATION_ID = cancellation.id;
  const result = await stack(fixture.env, ['sh', '-c', 'echo forbidden-local-fallback']);
  expect(result.code).toBe(143);
  expect(result.stdout).not.toContain('forbidden-local-fallback');
  expect(fixture.events()).toEqual([]);
});

test('growth profile: a root-relative profile is forwarded and returned with the run', async () => {
  const { env, events } = scenario({ host: { available: 30e9 } });
  const directory = workspace();
  const profile = 'profile.jsonl';
  writeFileSync(join(directory, profile), '{"earlier":true}\n');
  const result = await stack({ ...env, GROWTH_PROFILE: join(directory, profile) }, local, [], directory);
  expect(result.code).toBe(0);
  const run = events().find((event) => event.kind === 'run')!;
  expect(run.script).toContain(`GROWTH_PROFILE=${profile}`);
  expect(run.script).toContain(profile);
  const returns = events().find((event) => event.kind === 'returns')!;
  expect(returns.script).toContain(`# PATH ${profile}`);
  const seen = events();
  const releaseAt = seen.findIndex((event) => event.kind === 'release');
  const returnsAt = seen.findIndex((event) => event.kind === 'returns');
  const copiedAt = seen.findIndex((event) => event.kind === 'rsync' && event.step === 'returns copy');
  const cleanupAt = seen.findIndex((event) => event.kind === 'cleanup');
  expect(seen.find((event) => event.kind === 'run')!.slotHeld).toBe(true);
  expect(returns.slotHeld).toBe(false);
  expect(seen[copiedAt]!.slotHeld).toBe(false);
  expect(releaseAt).toBeLessThan(returnsAt);
  expect(returnsAt).toBeLessThan(copiedAt);
  expect(copiedAt).toBeLessThan(cleanupAt);
  expect(readFileSync(join(directory, profile), 'utf8')).toBe('{"earlier":true}\n');
});

test('growth profile: an outside path is a usage error and never falls back locally', async () => {
  const { env, events } = scenario({ host: { available: 30e9 } });
  const directory = workspace();
  const outside = join(directory, '..', 'outside-profile.jsonl');
  const result = await stack({ ...env, GROWTH_PROFILE: outside }, local, [], directory);
  expect(result.code).not.toBe(3);
  expect(result.stderr).toContain(`GROWTH_PROFILE path is outside the run root: ${outside}`);
  expect(events()).toEqual([]);
});

test('growth profile: an unset profile adds no command or returned file', async () => {
  const { env, events } = scenario({ host: { available: 30e9 } });
  const result = await stack(env, local);
  expect(result.code).toBe(0);
  const run = events().find((event) => event.kind === 'run')!;
  expect(run.script).not.toContain('GROWTH_PROFILE=');
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
  expect(existsSync(join(down.lease, 'slot-1.lock'))).toBe(true);
  expect(spawnSync('flock', ['-n', join(down.lease, 'slot-1.lock'), '-c', 'true']).status).toBe(0);
  expect(readdirSync(down.env.FAKE_DIR!).filter((entry) => entry.includes('.slot.'))).toEqual([]);

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
  expect(events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_PRIORITY landing',
  );
  expect(events().find((event) => event.kind === 'run')?.script).toContain("printf 'remote-check: run priority %s");

  const kernel = readFileSync(join(repository, 'services/kernel/scripts/check.ts'), 'utf8');
  const auth = readFileSync(join(repository, 'services/auth/scripts/check.ts'), 'utf8');
  const authDatabase = readFileSync(join(repository, 'services/auth/scripts/database.ts'), 'utf8');
  const web = readFileSync(join(repository, 'apps/web/scripts/check.ts'), 'utf8');
  const placement = readFileSync(join(repository, 'scripts/stack-run.ts'), 'utf8');
  expect(kernel).toContain('    env,\n  );');
  expect(auth).toContain("process.exitCode = await databaseCheck(['bun', 'scripts/check.ts', ...args], async () => {");
  expect(authDatabase).toContain(
    "return stackRun({ label: 'auth check', root: resolve(directory, '../..'), cwd: directory, command }, async () => {",
  );
  expect(web).toContain('      options.env ?? process.env,');
  expect(web).toContain('export async function runHostTests(\n  env: NodeJS.ProcessEnv = process.env');
  expect(placement).toContain('env: Environment = process.env');
}, 30_000);

test('landing priority: workers drop landing and report it once, and other values are usage errors', async () => {
  const worker = scenario({ a: { available: 20e9 } });
  const workerResult = await stack({ ...worker.env, REMOTE_CHECK_PRIORITY: 'landing', GOAL_TASK_ID: 'worker' }, [
    'true',
  ]);
  expect(workerResult.code).toBe(0);
  expect(workerResult.stderr.match(/worker environment ignores REMOTE_CHECK_PRIORITY=landing/g)).toHaveLength(1);
  expect(worker.events().some((event) => event.kind === 'landing-marker')).toBe(false);
  expect(worker.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_PRIORITY ordinary',
  );

  const invalid = scenario({ a: { available: 20e9 } });
  const refused = await stack({ ...invalid.env, REMOTE_CHECK_PRIORITY: 'urgent' }, ['true']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('REMOTE_CHECK_PRIORITY must be landing');
  expect(invalid.events()).toEqual([]);
}, 30_000);

test('critical priority: worker environments preserve critical through stackRun and check entry points', async () => {
  const { env, events } = scenario({ a: { available: 20e9 } });
  const result = await stack({ ...env, REMOTE_CHECK_PRIORITY: 'critical', GOAL_TASK_ID: 'worker' }, ['true']);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('stack-run: the run priority critical on a');
  expect(events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_PRIORITY critical',
  );
  const kernel = readFileSync(join(repository, 'services/kernel/scripts/check.ts'), 'utf8');
  const auth = readFileSync(join(repository, 'services/auth/scripts/check.ts'), 'utf8');
  const authDatabase = readFileSync(join(repository, 'services/auth/scripts/database.ts'), 'utf8');
  const web = readFileSync(join(repository, 'apps/web/scripts/check.ts'), 'utf8');
  expect(kernel).toContain('    env,\n  );');
  expect(auth).toContain("process.exitCode = await databaseCheck(['bun', 'scripts/check.ts', ...args], async () => {");
  expect(authDatabase).toContain("return stackRun({ label: 'auth check'");
  expect(web).toContain('options.env ?? process.env');
});

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

test('Kernel tree profile and mixed schema travel through real stack placement as bounded physical returns', async () => {
  const { KERNEL_CLIENT_OUTPUT } = await import('./check-output-tree.ts');
  const directory = workspace();
  const physical = scenario({ a: {} });
  for (const mixed of [false, true]) {
    const returns = [KERNEL_CLIENT_OUTPUT.transport, ...(mixed ? ['services/kernel/db/semantic/schema.sql'] : [])];
    let placements = 0;
    const code = await runOnCheckHost(
      {
        label: 'kernel typecheck',
        root: directory,
        cwd: join(directory, 'services/kernel'),
        command: ['bun', 'scripts/typecheck.ts', '--emit-client', ...(mixed ? ['--emit-schema=semantic'] : [])],
        keepsFiles: true,
        returns,
      },
      physical.env,
      async (options) => {
        placements++;
        expect(options.returns).toEqual(returns);
        expect(options.workspace).toBe(directory);
        expect(options.cwd).toBe('services/kernel');
        expect(options.command).toContain('--emit-client');
        expect(options.allowedHosts).toEqual(['a']);
        return 23;
      },
    );
    expect(code).toBe(23);
    expect(placements).toBe(1);
    expect(physical.events()).toEqual([]);
  }
});
