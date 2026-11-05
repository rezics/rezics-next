import { afterEach, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const remoteCheck = join(repository, 'scripts/remote-check.ts');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trimEnd();
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

const fakeSsh = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const script = args.at(-1) || '';
const address = args.at(-2) || '';
const hostRoot = process.env.PARITY_REMOTE_ROOT;
const record = (value) => appendFileSync(process.env.PARITY_TRANSPORT_LOG, JSON.stringify({ address, ...value }) + '\n');
if (script.includes('/proc/loadavg')) {
  console.log('MEMORY_CURRENT 0\nMEMORY_MAX 17179869184\nMEMORY_HEADROOM 17179869184\nMEMORY_RESERVED 0\nPROCESSORS 16\nSLICE_PROCESSORS 8\nLOAD 0\nAVAILABLE 17179869184\nTMP_BYTES 17179869184\nTMP_INODES 1000000\nORDINARY_SLOTS_USED 0\nEXPRESS_SLOT_USED 0\nGATE_WAITING 0\nMULTI_SLOT_WAITING_SLOTS 0\nMULTI_SLOT_WAITING_ID -\nLANDING_WAITING_SLOTS 0\nLANDING_WAITING_ID -\nLANDING_WAITING_STARTED -\nLANDING_WAITING_ESTIMATE_MS -1\nLANDING_WAITING_MEMORY_BYTES 1');
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const count = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\d+)/)?.[1] || 1);
  console.log('SLOTS ' + count);
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (script.includes('REMOTE_CHECK_BASE_STATE')) {
  console.log('BASE -\nAGE -\nZSTD 0');
} else if (script.includes('REMOTE_CHECK_RETURNS')) {
  const run = script.match(/\/srv\/rezics-check\/runs\/([^/' ]+)/)?.[1] || '';
  for (const match of script.matchAll(/^# PATH ([^\n]+)$/gm)) {
    const path = join(hostRoot, 'runs', run, match[1]);
    console.log((existsSync(path) ? 'PRESENT ' : 'ABSENT ') + match[1]);
  }
} else if (script.includes('REMOTE_CHECK_STATUS')) {
  console.log('NOT_STARTED');
} else if (script.includes('systemd-run')) {
  const mapped = script.replaceAll('/srv/rezics-check', hostRoot);
  const run = mapped.match(/runs\/([^/' ]+)/)?.[1] || '';
  const manifest = mapped.match(/restore\s+([^\s]+manifest\.json)/)?.[1] || '';
  const pack = join(dirname(manifest), 'snapshot.pack');
  const runRoot = join(hostRoot, 'runs', run);
  const artifactBytes = existsSync(manifest) && existsSync(pack) ? statSync(manifest).size + statSync(pack).size : 0;
  record({
    kind: 'run-start',
    run,
    artifactBytes,
    manifestRelative: manifest.startsWith(runRoot + '/') ? manifest.slice(runRoot.length + 1) : '',
    artifactsPresentBeforeBootstrap: artifactBytes > 0,
    gitUnavailableBeforeBootstrap: !existsSync(join(hostRoot, 'runs', run, '.git')),
  });
  const child = Bun.spawn(['sh', '-c', mapped], {
    cwd: hostRoot,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  process.off('SIGTERM', stop);
  process.off('SIGHUP', stop);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  record({ kind: 'run-finish', code });
  process.exitCode = code;
} else {
  const mapped = script.replaceAll('/srv/rezics-check', hostRoot);
  const result = spawnSync('sh', ['-c', mapped], {
    cwd: hostRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
`;

const fakeRsync = String.raw`#!/usr/bin/env bun
import { appendFileSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('rsync version 3.3.0\nCapabilities: zstd zlib');
  process.exit(0);
}
const inputFiles = (await Bun.stdin.text()).split('\0').filter(Boolean);
const fileList = args.find((argument) => argument.startsWith('--files-from='))?.slice('--files-from='.length);
const listedFiles = fileList && fileList !== '-' ? readFileSync(fileList).toString().split('\0').filter(Boolean) : [];
const files = [...new Set([...inputFiles, ...listedFiles])];
const source = (args.at(-2) || '').replace(/\/$/, '');
const destination = args.at(-1) || '';
const upload = destination.match(/^.+:(\/srv\/rezics-check\/runs\/([^/]+))\/?$/);
if (upload) {
  const targetRoot = join(process.env.PARITY_REMOTE_ROOT, 'runs', upload[2]);
  mkdirSync(targetRoot, { recursive: true });
  for (const file of files) {
    const from = join(source, file);
    const to = join(targetRoot, file);
    mkdirSync(dirname(to), { recursive: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else cpSync(from, to);
  }
  appendFileSync(process.env.PARITY_TRANSPORT_LOG, JSON.stringify({ kind: 'workspace-upload', count: files.length, run: upload[2] }) + '\n');
  rmSync(join(source, '.git'), { recursive: true, force: true });
} else {
  const download = source.match(/^.+:(\/srv\/rezics-check\/runs\/([^/]+))\/?$/);
  if (!download) process.exit(2);
  const remoteRoot = join(process.env.PARITY_REMOTE_ROOT, 'runs', download[2]);
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const from = join(remoteRoot, file);
    const to = join(destination, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  appendFileSync(process.env.PARITY_TRANSPORT_LOG, JSON.stringify({ kind: 'workspace-return', count: files.length, run: download[2] }) + '\n');
}
`;

function createGateRepository(label: string): {
  root: string;
  head: string;
  historical: string;
  expectedStatus: string;
} {
  const root = mkdtempSync(join(repository, `.temp/gate-parity-${label}-`));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'scripts/check-host'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  mkdirSync(join(root, 'apps/pass'), { recursive: true });
  mkdirSync(join(root, 'apps/fail'), { recursive: true });
  mkdirSync(join(root, 'apps/solo'), { recursive: true });
  for (const file of ['gate.ts', 'remote-check.ts', 'check-git.ts', 'test-lanes.ts', 'stack-lease.ts']) {
    cpSync(join(repository, 'scripts', file), join(root, 'scripts', file));
  }
  cpSync(join(repository, 'scripts/check-host/docker'), join(root, 'scripts/check-host/docker'));

  const rootPackage = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'native-gate-parity-fixture',
        private: true,
        type: 'module',
        packageManager: rootPackage.packageManager,
        workspaces: ['apps/*'],
        scripts: { check: 'bun scripts/gate.ts' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.temp/\n');
  for (const workspace of ['pass', 'fail', 'solo']) {
    writeFileSync(
      join(root, `apps/${workspace}/package.json`),
      JSON.stringify({ name: `@fixture/${workspace}`, scripts: { check: 'bun check.ts' } }, null, 2) + '\n',
    );
    writeFileSync(join(root, `apps/${workspace}/check.ts`), workspaceCheckScript);
  }

  const install = Bun.spawnSync([process.execPath, 'install'], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(install.exitCode, install.stderr.toString()).toBe(0);

  writeFileSync(join(root, 'history.txt'), 'historical\n');
  writeFileSync(join(root, 'staged.txt'), 'old\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Parity Fixture');
  git(root, 'config', 'user.email', 'parity@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'native history');
  const historical = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'history.txt'), 'committed\n');
  git(root, 'commit', '-qam', 'advance native history');
  const head = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', 'staged.txt');
  writeFileSync(join(root, 'history.txt'), 'unstaged\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
  const expectedStatus = git(root, 'status', '--porcelain=v1');
  expect(expectedStatus).toBe(' M history.txt\nM  staged.txt\n?? untracked.txt');
  return { root, head, historical, expectedStatus };
}

const workspaceCheckScript = String.raw`import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const workspace = process.cwd().split('/').at(-1);
const runId = process.env.PARITY_RUN_ID;
const stateDirectory = join(resolve(process.cwd(), '../..'), '.temp/gate-parity-state');
mkdirSync(stateDirectory, { recursive: true });
const readGit = (args) => {
  const result = Bun.spawnSync(['git', ...args], { cwd: resolve(process.cwd(), '../..'), stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error('native workspace Git probe failed');
  return result.stdout.toString().trimEnd();
};
const ancestry = [];
let pid = process.pid;
for (let step = 0; step < 16 && pid > 1; step += 1) {
  let command = '';
  let parent = 0;
  try {
    command = readFileSync('/proc/' + pid + '/cmdline').toString().split('\0').filter(Boolean).join(' ');
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { break; }
  ancestry.push({ pid, parent, command });
  if (!parent || parent === pid) break;
  pid = parent;
}
const record = {
  workspace,
  cwd: process.cwd(),
  pid: process.pid,
  parent: process.ppid,
  ancestry,
  environment: {
    remoteHost: process.env.REMOTE_CHECK_HOST,
    remoteMarker: process.env.KERNEL_CHECK_ON_REMOTE,
    stackLease: process.env.REZICS_STACK_LEASE,
    run: process.env.REZICS_CHECK_RUN,
    slice: process.env.REZICS_CHECK_SLICE,
    phases: process.env.REZICS_CHECK_PHASES,
    authLaneOwner: process.env.AUTH_CHECK_LANE_OWNER,
    webStateDirectory: process.env.WEB_TEST_STATE_DIR,
  },
  result: null,
};
if (workspace === 'pass' || workspace === 'solo') {
  const sourceRoot = resolve(process.cwd(), '../..');
  record.result = {
    head: readGit(['rev-parse', 'HEAD']),
    historical: readGit(['show', process.env.PARITY_HISTORICAL + ':history.txt']),
    staged: readGit(['show', ':staged.txt']),
    status: readGit(['status', '--porcelain=v1']),
    gitDirectory: readGit(['rev-parse', '--absolute-git-dir']),
    worktreeFile: readFileSync(join(sourceRoot, 'history.txt'), 'utf8'),
  };
  record.result.gitMetadataInsideRun = record.result.gitDirectory === join(sourceRoot, '.git');
  if (record.result.head !== process.env.PARITY_HEAD) throw new Error('restored HEAD identity changed');
  if (record.result.historical !== 'historical' || record.result.staged !== 'staged') throw new Error('restored Git objects changed');
  if (record.result.status !== process.env.PARITY_EXPECTED_STATUS) {
    throw new Error('restored source status changed: ' + JSON.stringify(record.result.status));
  }
  if (record.result.worktreeFile !== 'unstaged\n') throw new Error('workspace bytes changed during restore');
  if (!record.result.gitMetadataInsideRun) throw new Error('restored Git metadata is not private to this run');
  const worktree = join(stateDirectory, 'native-worktree-' + runId + '-' + workspace);
  const added = Bun.spawnSync(['git', 'worktree', 'add', '--detach', worktree, 'HEAD'], {
    cwd: sourceRoot, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  if (added.exitCode !== 0) throw new Error('restored Git repository cannot add an independent worktree');
  record.result.childWorktree = readFileSync(join(worktree, 'history.txt'), 'utf8');
  const removed = Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktree], {
    cwd: sourceRoot, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  });
  if (removed.exitCode !== 0) throw new Error('restored Git repository cannot remove its independent worktree');
  if (record.result.childWorktree !== 'committed\n') throw new Error('restored worktree did not use HEAD bytes');
}
appendFileSync(join(stateDirectory, runId + '.jsonl'), JSON.stringify(record) + '\n');
if (workspace === 'fail') {
  console.error('selected fixture failure');
  process.exit(17);
}
console.log('controlled workspace check passed');
`;

function startRemoteGate(
  fixture: ReturnType<typeof createGateRepository>,
  runLabel: string,
  selected: string[],
  environment: Record<string, string>,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      process.execPath,
      remoteCheck,
      '--max-ms',
      '25000',
      '--returns',
      '.temp/gate/result.json',
      '--returns',
      `.temp/gate-parity-state/${runLabel}.jsonl`,
      fixture.root,
      '--',
      'env',
      `PARITY_RUN_ID=${runLabel}`,
      `PARITY_HEAD=${fixture.head}`,
      `PARITY_HISTORICAL=${fixture.historical}`,
      `PARITY_EXPECTED_STATUS=${fixture.expectedStatus}`,
      'GATE_RESULT_FILE=.temp/gate/result.json',
      `GATE_CONCURRENCY=${Math.max(1, selected.length)}`,
      'bun',
      'scripts/gate.ts',
      '--workspaces',
      ...selected.map((workspace) => `apps/${workspace}`),
    ],
    {
      cwd: repository,
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

test('the root gate keeps its supported workspace check environment and native Git survives concurrent remote restores', async () => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const fixtureRoot = mkdtempSync(join(repository, '.temp/gate-parity-joint-'));
  fixtureRoots.push(fixtureRoot);
  const remoteRoot = join(fixtureRoot, 'remote-host');
  const bin = join(fixtureRoot, 'bin');
  mkdirSync(remoteRoot);
  mkdirSync(bin);
  const hosts = join(fixtureRoot, 'hosts.json');
  const transportLog = join(fixtureRoot, 'transport.jsonl');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'native-fixture',
          address: 'fixture@native.test',
          identity: '/fixture/identity',
          memoryMaxGiB: 16,
          cpuQuotaPercent: 1600,
          slots: 3,
          processorsPerSlot: 2,
        },
      ],
    }),
  );
  executable(join(bin, 'ssh'), fakeSsh);
  executable(join(bin, 'rsync'), fakeRsync);
  executable(
    join(bin, 'systemd-run'),
    '#!/bin/sh\nif [ "$1" = --help ]; then printf "%s\\n" --expand-environment; exit 0; fi\nwhile [ "$#" -gt 0 ]; do if [ "$1" = sh ]; then exec "$@"; fi; shift; done\nexit 2\n',
  );
  executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');

  const fixtureA = createGateRepository('selected');
  const fixtureB = createGateRepository('concurrent');
  const environment: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${join(repository, 'node_modules/.bin')}:${process.env.PATH}`,
    KERNEL_CHECK_REMOTE: hosts,
    REMOTE_CHECK_POLL_MS: '10',
    REMOTE_CHECK_PINNED_BUN_PATH: join(repository, 'node_modules/.bin/bun'),
    PARITY_REMOTE_ROOT: remoteRoot,
    PARITY_TRANSPORT_LOG: transportLog,
  };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_ON_REMOTE' ||
      key === 'AUTH_CHECK_LANE_OWNER' ||
      key === 'WEB_TEST_STATE_DIR' ||
      key === 'GATE_RESULT_FILE' ||
      key === 'GATE_CONCURRENCY' ||
      key === 'GATE_DURATIONS_FILE'
    ) {
      delete environment[key];
    }
  }

  const first = startRemoteGate(fixtureA, 'selected', ['pass', 'fail'], environment);
  const second = startRemoteGate(fixtureB, 'concurrent', ['solo'], environment);
  const collect = async (child: ReturnType<typeof Bun.spawn>) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 50_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
  const [failedRun, passingRun] = await Promise.all([collect(first), collect(second)]);
  expect(failedRun.code, `${failedRun.stdout}\n${failedRun.stderr}`).toBe(1);
  expect(passingRun.code, `${passingRun.stdout}\n${passingRun.stderr}`).toBe(0);
  expect(existsSync(join(fixtureA.root, '.git'))).toBe(false);
  expect(existsSync(join(fixtureB.root, '.git'))).toBe(false);

  const selectedOutcomes = JSON.parse(readFileSync(join(fixtureA.root, '.temp/gate/result.json'), 'utf8')) as {
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
  expect(selectedOutcomes.workspaces).toEqual([
    {
      name: '@fixture/fail',
      directory: 'apps/fail',
      host: 'native-fixture',
      passed: false,
      durationSeconds: expect.any(Number),
      failingFiles: [],
      loadSensitiveTests: [],
    },
    {
      name: '@fixture/pass',
      directory: 'apps/pass',
      host: 'native-fixture',
      passed: true,
      durationSeconds: expect.any(Number),
      failingFiles: [],
      loadSensitiveTests: [],
    },
  ]);
  const concurrentOutcomes = JSON.parse(readFileSync(join(fixtureB.root, '.temp/gate/result.json'), 'utf8')) as {
    workspaces: Array<{ directory: string; host: string; passed: boolean }>;
  };
  expect(concurrentOutcomes.workspaces).toHaveLength(1);
  expect(concurrentOutcomes.workspaces[0]).toMatchObject({
    directory: 'apps/solo',
    host: 'native-fixture',
    passed: true,
  });

  const selectedRecords = readFileSync(join(fixtureA.root, '.temp/gate-parity-state/selected.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const concurrentRecords = readFileSync(join(fixtureB.root, '.temp/gate-parity-state/concurrent.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(selectedRecords.map((record) => record.workspace).sort()).toEqual(['fail', 'pass']);
  expect(concurrentRecords.map((record) => record.workspace)).toEqual(['solo']);
  const passedSelected = selectedRecords.find((record) => record.workspace === 'pass')!;
  const passedConcurrent = concurrentRecords[0]!;
  for (const [record, workspace] of [
    [passedSelected, 'pass'],
    [passedConcurrent, 'solo'],
  ] as const) {
    expect(record.cwd).toMatch(new RegExp(`/runs/[^/]+/apps/${workspace}$`));
    expect(record.ancestry[0].command).toContain('check.ts');
    expect(record.ancestry.some((entry: { command: string }) => entry.command.includes('scripts/gate.ts'))).toBe(true);
    expect(record.environment).toMatchObject({
      remoteHost: 'native-fixture',
      remoteMarker: '1',
      stackLease: 'off',
    });
    expect(record.environment.run).toBeTruthy();
    expect(record.environment.slice).toBeTruthy();
    expect(record.environment.phases).toBeTruthy();
    expect(record.environment.authLaneOwner).toBeUndefined();
    expect(record.environment.webStateDirectory).toBeUndefined();
    expect(record.result).toMatchObject({
      head: expect.any(String),
      historical: 'historical',
      staged: 'staged',
      status: fixtureA.expectedStatus,
      worktreeFile: 'unstaged\n',
      childWorktree: 'committed\n',
      gitMetadataInsideRun: true,
    });
  }
  expect(passedSelected.environment.run).not.toBe(passedConcurrent.environment.run);
  expect(passedSelected.result.gitDirectory).not.toBe(passedConcurrent.result.gitDirectory);
  const transportRecords = readFileSync(transportLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(transportRecords.filter((record) => record.kind === 'workspace-upload')).toHaveLength(2);
  expect(transportRecords.filter((record) => record.kind === 'workspace-return')).toHaveLength(2);
  const runStarts = transportRecords.filter((record) => record.kind === 'run-start');
  expect(runStarts).toHaveLength(2);
  for (const run of runStarts) {
    expect(run.artifactBytes).toBeGreaterThan(0);
    expect(run.manifestRelative).toContain('.temp/remote-check-git-');
    expect(run.artifactsPresentBeforeBootstrap).toBe(true);
    expect(run.gitUnavailableBeforeBootstrap).toBe(true);
    expect(existsSync(join(remoteRoot, 'bases/current', run.manifestRelative))).toBe(false);
    expect(existsSync(join(remoteRoot, 'bases/current/.git'))).toBe(false);
    expect(existsSync(join(remoteRoot, 'runs', run.run))).toBe(false);
  }
}, 65_000);
