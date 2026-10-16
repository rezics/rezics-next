import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { command } from '../../../scripts/qa/core.ts';
import { composeProcessEnvironment } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import {
  dockerShimDirectory, processStartTime, reapChildScope, reapCreatedOwner, reapOwnerAlive, reapOwnerAssignment,
  reapOwnerEnvironment, reapOwnerLabel, reapScopeLabel, reapStateDirectory, removeScopedContainers, settleReap,
  sweepOrphanContainers,
} from '../../../scripts/qa/container-reaper.ts';

const root = resolve(import.meta.dir, '../../..');
const shim = join(dockerShimDirectory(), 'docker');

// A stub must finish writing its response before process.exit: console.log can
// leave pipe output pending under load, making a successful ps appear empty.
const dockerOutput = `import { writeSync } from 'node:fs';
const output = (value) => writeSync(1, String(value) + '\\n');
`;

async function waitFor(condition: () => boolean, description: string, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

function absentPid(): number {
  for (let pid = 2_000_000_000; pid < 2_000_000_020; pid++) {
    try { readFileSync(`/proc/${pid}/stat`); } catch { return pid; }
  }
  throw new Error('no unused pid');
}

test('the docker shim adds the reap owner only to run and create', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-shim-'));
  const stubDir = join(directory, 'stub');
  const pinnedDir = join(directory, 'pinned');
  mkdirSync(stubDir);
  mkdirSync(pinnedDir);
  const captured = join(directory, 'argv.json');
  const writeDocker = (dir: string, body: string) => {
    const path = join(dir, 'docker');
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  writeDocker(stubDir, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
`);
  writeDocker(pinnedDir, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_FILE, JSON.stringify(['pinned', ...process.argv.slice(2)]));
`);
  const run = (args: string[], labels?: { owner?: string; scope?: string },
    path = `${stubDir}:${dockerShimDirectory()}:${pinnedDir}:${process.env.PATH ?? ''}`) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, ARGV_FILE: captured, REZICS_REAL_DOCKER: join(pinnedDir, 'docker') };
    env.REZICS_REAP_STATE = join(directory, 'state');
    delete env.REZICS_REAP_OWNER;
    delete env.REZICS_REAP_SCOPE;
    delete env.REZICS_REAP_SCOPES;
    if (labels?.owner !== undefined) env.REZICS_REAP_OWNER = labels.owner;
    if (labels?.scope !== undefined) env.REZICS_REAP_SCOPES = labels.scope;
    const result = spawnSync(shim, args, { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(captured, 'utf8')) as string[];
  };
  try {
    const both = ['--label', `${reapOwnerLabel}=9:8`, '--label', `${reapScopeLabel}.shard-a=1`];
    const child = { owner: '9:8', scope: 'shard-a' };
    expect(run(['run', '--rm', 'alpine', 'sleep', '600'], child)).toEqual(['run', ...both, '--rm', 'alpine', 'sleep', '600']);
    expect(run(['create', '--name', 'box', 'alpine'], child)).toEqual(['create', ...both, '--name', 'box', 'alpine']);
    expect(run(['container', 'run', '--rm', 'alpine'], child)).toEqual(['container', 'run', ...both, '--rm', 'alpine']);
    expect(run(['container', 'create', 'alpine'], child)).toEqual(['container', 'create', ...both, 'alpine']);
    expect(run(['--host', 'unix:///var/run/docker.sock', 'run', 'alpine'], child))
      .toEqual(['--host', 'unix:///var/run/docker.sock', 'run', ...both, 'alpine']);
    expect(run(['-Hunix:///var/run/docker.sock', 'create'], child)).toEqual(['-Hunix:///var/run/docker.sock', 'create', ...both]);
    expect(run(['run', 'alpine'], { owner: '9:8' })).toEqual(['run', '--label', `${reapOwnerLabel}=9:8`, 'alpine']);
    expect(run(['run', 'alpine'], { owner: '9:8', scope: 'parent,shard-a' })).toEqual(['run', '--label', `${reapOwnerLabel}=9:8`,
      '--label', `${reapScopeLabel}.parent=1`, '--label', `${reapScopeLabel}.shard-a=1`, 'alpine']);
    expect(run(['ps', '-a'], child)).toEqual(['ps', '-a']);
    expect(run(['compose', 'up', '-d'], child)).toEqual(['compose', 'up', '-d']);
    expect(run(['compose', 'run', 'web'], child)).toEqual(['compose', 'run', 'web']);
    expect(run(['container', 'ls'], child)).toEqual(['container', 'ls']);
    expect(run(['context', 'create', 'local'], child)).toEqual(['context', 'create', 'local']);
    expect(run(['run', 'alpine'])).toEqual(['run', 'alpine']);
    expect(run(['ps'], undefined, `${dockerShimDirectory()}:${stubDir}:${dockerShimDirectory()}:${pinnedDir}:${process.env.PATH ?? ''}`)).toEqual(['ps']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shim directories from different roots resolve to the docker after every shim', () => {
  const rootA = mkdtempSync(join(root, '.temp', 'reap-shim-a-'));
  const rootB = mkdtempSync(join(root, '.temp', 'reap-shim-b-'));
  const stubDir = mkdtempSync(join(root, '.temp', 'reap-shim-real-'));
  const captured = join(stubDir, 'argv.json');
  const install = (directory: string) => {
    const path = join(directory, 'docker');
    copyFileSync(shim, path);
    chmodSync(path, 0o755);
    return path;
  };
  try {
    const shimA = install(rootA);
    const shimB = install(rootB);
    writeFileSync(join(stubDir, 'docker'), `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
`);
    chmodSync(join(stubDir, 'docker'), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${rootB}:${rootA}:${stubDir}:${process.env.PATH ?? ''}`, ARGV_FILE: captured,
    };
    delete env.REZICS_REAP_OWNER;
    delete env.REZICS_REAP_SCOPE;
    delete env.REZICS_REAP_SCOPES;
    const result = spawnSync(shimB, ['ps'], { env, encoding: 'utf8', timeout: 3_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(captured, 'utf8'))).toEqual(['ps']);
    expect(shimA).not.toBe(shimB);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('the sweep removes dead and reused owners and never lists unlabelled containers', () => {
  const start = processStartTime(process.pid);
  expect(start).toBeTruthy();
  expect(start).not.toBe('0');
  const deadPid = absentPid();
  expect(reapOwnerAlive(`${process.pid}:${start}`)).toBe(true);
  expect(reapOwnerAlive(`${process.pid}:0`)).toBe(false);
  expect(reapOwnerAlive(`${deadPid}:1`)).toBe(false);

  const directory = mkdtempSync(join(root, '.temp', 'reap-sweep-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  const owners = { dead: `${deadPid}:1`, reused: `${process.pid}:0`, live: `${process.pid}:${start}` };
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const [command, ...rest] = args;
if (command === 'ps') {
  if (!rest.includes(${JSON.stringify(`label=${reapOwnerLabel}`)})) output('unlabelled');
  else output('dead\\nreused\\nlive');
  process.exit(0);
}
if (command === 'inspect') {
  const owners = ${JSON.stringify(owners)};
  output(owners[rest.at(-1)] ?? '');
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ''}`;
  try {
    const stateFor = (owner: string) => {
      const dir = reapStateDirectory(owner);
      if (!dir) throw new Error(`unsafe owner ${owner}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.owner'), '');
      return dir;
    };
    const deadState = stateFor(owners.dead);
    const reusedState = stateFor(owners.reused);
    const liveState = stateFor(owners.live);
    sweepOrphanContainers();
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === 'ps')).toEqual([['ps', '-aq', '--filter', `label=${reapOwnerLabel}`]]);
    expect(calls.some(call => call.includes('unlabelled') || call[0] === 'ps' && !call.includes(`label=${reapOwnerLabel}`))).toBe(false);
    expect(calls.filter(call => call[0] === 'rm')).toEqual([['rm', '-f', 'dead', 'reused']]);
    expect(calls.flat()).not.toContain('unlabelled');
    expect(existsSync(deadState)).toBe(false);
    expect(existsSync(reusedState)).toBe(false);
    expect(existsSync(liveState)).toBe(true);
    rmSync(liveState, { recursive: true, force: true });
  } finally {
    process.env.PATH = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

function dockerStub(directory: string, listed: Record<string, string>): { log: string; use: (body: () => void) => void } {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const [command, ...rest] = args;
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const containers = ${JSON.stringify(listed)};
  if (containers[filter]) output(containers[filter]);
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return {
    log,
    use(body) {
      const saved = process.env.PATH;
      process.env.PATH = `${bin}:${saved ?? ''}`;
      try { body(); } finally { process.env.PATH = saved; }
    },
  };
}

test('removing a scope with no marker makes no Docker call', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-unmarked-'));
  const stub = dockerStub(directory, { [`label=${reapScopeLabel}.absent-scope`]: 'should-stay' });
  const started = Date.now();
  try {
    stub.use(() => {
      reapChildScope({ REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPE: 'absent-scope' });
      settleReap();
      reapChildScope({ REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPE: 'absent-scope' });
    });
    expect(Date.now() - started).toBeLessThan(200);
    expect(existsSync(stub.log)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a shim run records every scope marker and removal deletes the container and the marker', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-marked-'));
  // Fake dead owners must not share the orphan sweep's state directory.
  const state = join(directory, 'state');
  const parent = randomUUID();
  const child = randomUUID();
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const captured = join(directory, 'argv.json');
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.ARGV_FILE) writeFileSync(process.env.ARGV_FILE, JSON.stringify(args));
appendFileSync(process.env.LOG_FILE, JSON.stringify(args) + '\\n');
if (args[0] === 'ps' && args.at(-1).startsWith('label=rezics.reap-scope.')) output('marked-container');
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const savedPath = process.env.PATH;
  const savedState = process.env.REZICS_REAP_STATE;
  const savedLog = process.env.LOG_FILE;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${bin}:${dockerShimDirectory()}:${process.env.PATH ?? ''}`,
      ARGV_FILE: captured, LOG_FILE: log, REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPES: `${parent},${child}`,
      REZICS_REAP_STATE: state,
    };
    delete env.REZICS_REAP_SCOPE;
    const run = spawnSync(shim, ['run', '--rm', 'alpine'], { env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(captured, 'utf8'))).toEqual(['run', '--label', `${reapOwnerLabel}=9:8`,
      '--label', `${reapScopeLabel}.${parent}=1`, '--label', `${reapScopeLabel}.${child}=1`, '--rm', 'alpine']);
    expect(readFileSync(join(state, parent), 'utf8')).toBe('');
    expect(readFileSync(join(state, child), 'utf8')).toBe('');
    expect(existsSync(join(state, '.owner'))).toBe(true);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.REZICS_REAP_STATE = state;
    process.env.LOG_FILE = log;
    expect(removeScopedContainers(parent)).toBe(true);
    // Other harness processes sweep while this scope waits for dockerd.
    sweepOrphanContainers();
    settleReap();
    expect(removeScopedContainers(parent)).toBe(false);
    expect(removeScopedContainers(child)).toBe(true);
    settleReap();
    expect(removeScopedContainers(child)).toBe(false);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === 'rm')).toEqual([
      ['rm', '-f', 'marked-container'], ['rm', '-f', 'marked-container'],
      ['rm', '-f', 'marked-container'], ['rm', '-f', 'marked-container'],
    ]);
    expect(existsSync(join(state, parent))).toBe(false);
    expect(existsSync(join(state, child))).toBe(false);
  } finally {
    process.env.PATH = savedPath;
    if (savedState === undefined) delete process.env.REZICS_REAP_STATE;
    else process.env.REZICS_REAP_STATE = savedState;
    if (savedLog === undefined) delete process.env.LOG_FILE;
    else process.env.LOG_FILE = savedLog;
    rmSync(directory, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('an owner exit with no marker makes no Docker call', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-owner-quiet-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const script = join(directory, 'exit.ts');
  writeFileSync(script, `import ${JSON.stringify(join(root, 'scripts/qa/container-reaper.ts'))};\nprocess.exit(0);\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, REZICS_REAP_PRELOAD: '1' };
  delete env.REZICS_REAP_OWNER;
  delete env.REZICS_REAP_STATE;
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const started = Date.now();
  try {
    const child = spawnSync('bun', [script], { env, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
    expect(existsSync(log)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a timed-out child removes only its scope and leaves a sibling container', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-scope-'));
  const state = join(directory, 'state');
  const scope = randomUUID();
  const savedState = process.env.REZICS_REAP_STATE;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, scope), '');
  const stub = dockerStub(directory, {
    [`label=${reapScopeLabel}.${scope}`]: 'timed-out',
    [`label=${reapScopeLabel}.shard-b`]: 'live-sibling',
    [`label=${reapOwnerLabel}=9:8`]: 'timed-out\nlive-sibling',
  });
  try {
    process.env.REZICS_REAP_STATE = state;
    stub.use(() => {
      reapChildScope({ REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPE: scope });
      const calls = readFileSync(stub.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(calls.filter(call => call[0] === 'ps')).toEqual([['ps', '-aq', '--filter', `label=${reapScopeLabel}.${scope}`]]);
      expect(calls.filter(call => call[0] === 'rm')).toEqual([['rm', '-f', 'timed-out']]);
      expect(calls.flat()).not.toContain('live-sibling');
      settleReap();
      reapChildScope({ REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPE: scope });
    });
    expect(existsSync(join(state, scope))).toBe(false);
  } finally {
    if (savedState === undefined) delete process.env.REZICS_REAP_STATE;
    else process.env.REZICS_REAP_STATE = savedState;
    rmSync(directory, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('a nested runner exit keeps its ancestor containers', () => {
  const nested = reapOwnerAssignment({ PATH: process.env.PATH, REZICS_REAP_OWNER: '7:7' });
  expect(nested.createdOwner).toBeUndefined();
  expect(nested.environment.REZICS_REAP_OWNER).toBe('7:7');
  const directory = mkdtempSync(join(root, '.temp', 'reap-nested-'));
  const stub = dockerStub(directory, { [`label=${reapOwnerLabel}=7:7`]: 'ancestor' });
  try {
    stub.use(() => reapCreatedOwner(nested.createdOwner));
    expect(existsSync(stub.log)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the owner exit removes every scope it minted', () => {
  const start = processStartTime(process.pid);
  const created = reapOwnerAssignment({ PATH: process.env.PATH });
  expect(created.createdOwner).toBe(`${process.pid}:${start}`);
  const directory = mkdtempSync(join(root, '.temp', 'reap-owner-exit-'));
  const stub = dockerStub(directory, { [`label=${reapOwnerLabel}=${created.createdOwner}`]: 'scope-a\nscope-b' });
  try {
    stub.use(() => reapCreatedOwner(created.createdOwner));
    const calls = readFileSync(stub.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === 'ps')).toEqual([
      ['ps', '-aq', '--filter', `label=${reapOwnerLabel}=${created.createdOwner}`],
    ]);
    expect(calls.filter(call => call[0] === 'rm')).toEqual([['rm', '-f', 'scope-a', 'scope-b']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the runner sets its owner on test processes and keeps an inherited owner', () => {
  const start = processStartTime(process.pid);
  const assigned = reapOwnerEnvironment({ PATH: process.env.PATH, REZICS_REAL_DOCKER: '/usr/bin/docker' });
  expect(assigned.REZICS_REAP_OWNER).toBe(`${process.pid}:${start}`);
  expect(assigned.PATH?.startsWith(`${dockerShimDirectory()}:`)).toBe(true);
  expect(assigned.REZICS_REAL_DOCKER).toBeUndefined();
  const inherited = reapOwnerEnvironment({ ...assigned, REZICS_REAP_OWNER: '42:99' });
  expect(inherited.REZICS_REAP_OWNER).toBe('42:99');
  expect(inherited.PATH?.startsWith(`${dockerShimDirectory()}:`)).toBe(true);

  const directory = mkdtempSync(join(root, '.temp', 'reap-runner-'));
  const probe = join(directory, 'owner.test.ts');
  writeFileSync(probe, `import { test } from 'bun:test';
test('owner', () => {
  console.log('REAP_OWNER=' + process.env.REZICS_REAP_OWNER);
  console.log('REAP_SCOPE=' + process.env.REZICS_REAP_SCOPE);
  console.log('REAP_SCOPES=' + process.env.REZICS_REAP_SCOPES);
  console.log('REAP_PATH=' + (process.env.PATH ?? '').split(':')[0]);
});
`);
  const env = { ...process.env };
  delete env.REZICS_REAP_OWNER;
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const scopeOf = (output: string) => /^REAP_SCOPE=(.+)$/m.exec(output)?.[1];
  const chainOf = (output: string) => /^REAP_SCOPES=(.+)$/m.exec(output)?.[1];
  try {
    const result = command(root, 'bun', ['test', probe], 30_000, env);
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain(`REAP_OWNER=${process.pid}:${start}`);
    expect(result.output).toContain(`REAP_PATH=${dockerShimDirectory()}`);
    const firstScope = scopeOf(result.output);
    expect(firstScope).toMatch(/^[0-9a-f-]{36}$/);
    expect(chainOf(result.output)).toBe(firstScope);
    const kept = command(root, 'bun', ['test', probe], 30_000, { ...env, REZICS_REAP_OWNER: '42:99' });
    expect(kept.ok, kept.output).toBe(true);
    expect(kept.output).toContain('REAP_OWNER=42:99');
    const secondScope = scopeOf(kept.output);
    expect(secondScope).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondScope).not.toBe(firstScope);
    const chained = command(root, 'bun', ['test', probe], 30_000, { ...env, REZICS_REAP_SCOPES: 'parent-scope' });
    expect(chained.ok, chained.output).toBe(true);
    expect(chainOf(chained.output)).toBe(`parent-scope,${scopeOf(chained.output)}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a nested runner cancelled by SIGTERM removes its children and keeps ancestor and sibling scopes', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-cancel-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  const ready = join(directory, 'ready');
  const hang = join(directory, 'hang.test.ts');
  const runner = join(directory, 'nested-runner.ts');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const removed = new Set(String(process.env.REMOVED ?? '').split(',').filter(Boolean));
const [command, ...rest] = args;
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const listed = {
    'label=${reapScopeLabel}.extra-child': 'extra-child',
    'label=${reapScopeLabel}.ancestor': 'ancestor',
    'label=${reapScopeLabel}.sibling': 'sibling',
  };
  const ids = filter.startsWith('label=${reapOwnerLabel}=')
    ? ['nested', 'ancestor', 'sibling']
    : filter.startsWith('label=${reapScopeLabel}.') && !listed[filter]
      ? ['nested']
      : (listed[filter] ?? '').split('\\n');
  output(ids.filter(id => id && !removed.has(id)).join('\\n'));
  process.exit(0);
}
if (command === 'rm') process.env.REMOVED = [...removed, ...rest.slice(1).filter(id => id !== '-f')].join(',');
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(hang, `import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('hang', () => {
  const started = spawnSync('docker', ['run', '-d', 'alpine', 'sleep', '600'], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(started.stderr || started.stdout || 'docker run failed');
  writeFileSync(process.env.READY!, 'ready');
  return new Promise(() => {});
});
`);
  writeFileSync(runner, `import { noteChildScope } from ${JSON.stringify(join(root, 'scripts/qa/container-reaper.ts'))};
import { commandAsync } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
noteChildScope('extra-child');
await commandAsync(${JSON.stringify(directory)}, 'bun', ['test', ${JSON.stringify(hang)}, '--timeout=60000'], 60_000, process.env);
`);
  const noted = reapStateDirectory('4:4');
  if (!noted) throw new Error('owner 4:4 is not a state directory name');
  mkdirSync(noted, { recursive: true });
  writeFileSync(join(noted, 'extra-child'), '');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, REZICS_REAP_OWNER: '4:4' };
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const child = spawn('bun', [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await waitFor(() => existsSync(ready) && existsSync(join(noted, 'extra-child')), 'nested child and scope markers');
    expect(existsSync(ready), stderr).toBe(true);
    child.kill('SIGTERM');
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(closed, stderr).toEqual({ code: 143, signal: null });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    const removed = calls.filter(call => call[0] === 'rm').flatMap(call => call.slice(2));
    expect(removed).toContain('nested');
    expect(removed).toContain('extra-child');
    expect(removed).not.toContain('ancestor');
    expect(removed).not.toContain('sibling');
    // The labelled run records the owner. Cleanup listings stay on the child scopes.
    const cleanup = calls.filter(call => call[0] === 'ps' || call[0] === 'rm');
    expect(cleanup.some(call => call.join(' ').includes(`${reapOwnerLabel}=`) || call.includes('ancestor') || call.includes('sibling'))).toBe(false);
  } finally {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    rmSync(noted, { recursive: true, force: true });
  }
}, 20_000);

test('cancelling a runner removes a container started by a nested runner', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-chain-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  const state = join(directory, 'containers.json');
  const ready = join(directory, 'ready');
  const inner = join(directory, 'inner.test.ts');
  const middle = join(directory, 'middle.test.ts');
  const runner = join(directory, 'runner-a.ts');
  writeFileSync(state, JSON.stringify({ containers: [{ id: 'ancestor', labels: [`${reapScopeLabel}.ancestor-scope=1`], removed: false }] }));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, JSON.stringify(args) + '\\n');
const statePath = process.env.STATE;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const [command, ...rest] = args;
if (command === 'run') {
  const labels = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') labels.push(args[i + 1]);
  const saved = load();
  saved.containers.push({ id: 'grandchild', labels, removed: false });
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const key = filter.startsWith('label=') ? filter.slice('label='.length).split('=')[0] : '';
  const saved = load();
  output(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
  process.exit(0);
}
if (command === 'rm') {
  const ids = new Set(rest.filter(id => id !== '-f'));
  const saved = load();
  for (const container of saved.containers) if (ids.has(container.id)) container.removed = true;
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(inner, `import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('container', () => {
  const result = spawnSync('docker', ['run', '-d', '--name', 'rezics-reap-grandchild', 'alpine', 'sleep', '600'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'docker run failed');
  writeFileSync(process.env.READY, 'ready');
  return new Promise(() => {});
});
`);
  writeFileSync(middle, `import { test } from 'bun:test';
import { command } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
test('runner B', () => {
  command(${JSON.stringify(directory)}, 'bun', ['test', ${JSON.stringify(inner)}, '--timeout=60000'], 60_000, process.env);
});
`);
  writeFileSync(runner, `import { commandAsync } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
await commandAsync(${JSON.stringify(directory)}, 'bun', ['test', ${JSON.stringify(middle)}, '--timeout=60000'], 60_000, process.env);
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, LOG: log, STATE: state, REZICS_REAP_OWNER: '4:4',
  };
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const child = spawn('bun', [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready), stderr).toBe(true);
    child.kill('SIGTERM');
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(closed, stderr).toEqual({ code: 143, signal: null });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    const run = calls.find(call => call[0] === 'run');
    const scopeLabels = (run ?? []).filter((arg, index, args) => args[index - 1] === '--label' && arg.startsWith(`${reapScopeLabel}.`));
    expect(scopeLabels).toHaveLength(2);
    const parentKey = scopeLabels[0]?.slice(0, scopeLabels[0].indexOf('='));
    expect(calls.filter(call => call[0] === 'ps').some(call => call.includes(`label=${parentKey}`))).toBe(true);
    const removed = calls.filter(call => call[0] === 'rm').flatMap(call => call.slice(2));
    expect(removed).toContain('grandchild');
    expect(removed).not.toContain('ancestor');
    const saved = JSON.parse(readFileSync(state, 'utf8')) as { containers: { id: string; removed: boolean }[] };
    expect(saved.containers.find(container => container.id === 'ancestor')?.removed).toBe(false);
  } finally {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('SIGTERM to the dispatcher stops its child and removes that child\'s scope', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-dispatch-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  const state = join(directory, 'containers.json');
  const ready = join(directory, 'ready');
  const pidFile = join(directory, 'child.pid');
  const hang = join(directory, 'hang.test.ts');
  writeFileSync(state, JSON.stringify({ containers: [{ id: 'ancestor', labels: [`${reapScopeLabel}.ancestor-scope=1`], removed: false }] }));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const childState = () => {
  try {
    const stat = readFileSync('/proc/' + Number(readFileSync(process.env.PID_FILE, 'utf8')) + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] || 'missing';
  } catch { return 'missing'; }
};
const state = childState();
appendFileSync(process.env.LOG, JSON.stringify({ args, childState: state, childAlive: ['R', 'S', 'D'].includes(state) }) + '\\n');
const statePath = process.env.STATE;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const [command, ...rest] = args;
if (command === 'run') {
  const labels = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') labels.push(args[i + 1]);
  const saved = load();
  saved.containers.push({ id: 'child-container', labels, removed: false });
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const key = filter.startsWith('label=') ? filter.slice('label='.length).split('=')[0] : '';
  const saved = load();
  output(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
  process.exit(0);
}
if (command === 'rm') {
  const ids = new Set(rest.filter(id => id !== '-f'));
  const saved = load();
  for (const container of saved.containers) if (ids.has(container.id)) container.removed = true;
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(hang, `import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('hang', () => {
  process.on('SIGTERM', () => {});
  writeFileSync(process.env.PID_FILE, String(process.pid));
  const result = spawnSync('docker', ['run', '-d', '--name', 'rezics-reap-dispatch-child', 'alpine', 'sleep', '600'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'docker run failed');
  writeFileSync(process.env.READY, 'ready');
  return new Promise(() => {});
});
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, LOG: log, STATE: state, PID_FILE: pidFile,
    REZICS_REAP_OWNER: '4:4',
  };
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const dispatcher = spawn('bun', [join(root, 'scripts/qa/test.ts'), hang, '--timeout=60000'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  dispatcher.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready), stderr).toBe(true);
    const signalled = Date.now();
    dispatcher.kill('SIGTERM');
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      dispatcher.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(closed, stderr).toEqual({ code: 143, signal: null });
    expect(Date.now() - signalled).toBeGreaterThanOrEqual(1_500);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { args: string[]; childAlive: boolean; childState: string });
    const run = calls.find(call => call.args[0] === 'run');
    expect(run?.childAlive).toBe(true);
    const scopeCalls = calls.filter(call => call.args.some(arg => arg.startsWith(`label=${reapScopeLabel}.`)));
    expect(scopeCalls.length).toBeGreaterThan(0);
    expect(scopeCalls.filter(call => call.childAlive)).toEqual([]);
    const removed = calls.filter(call => call.args[0] === 'rm').flatMap(call => call.args.slice(2));
    expect(removed).toContain('child-container');
    expect(removed).not.toContain('ancestor');
  } finally {
    dispatcher.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('a detached grandchild that ignores SIGTERM is killed after its parent exits and before the scope is reaped', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-orphan-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'calls.jsonl');
  const state = join(directory, 'containers.json');
  const ready = join(directory, 'ready');
  const childPidFile = join(directory, 'child.pid');
  const grandchildPidFile = join(directory, 'grandchild.pid');
  const hang = join(directory, 'hang.test.ts');
  writeFileSync(state, JSON.stringify({ containers: [{ id: 'ancestor', labels: [`${reapScopeLabel}.ancestor-scope=1`], removed: false }] }));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const procState = (file) => {
  try {
    const stat = readFileSync('/proc/' + Number(readFileSync(file, 'utf8')) + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] || 'missing';
  } catch { return 'missing'; }
};
const grandchildState = procState(process.env.GRANDCHILD_PID);
appendFileSync(process.env.LOG, JSON.stringify({ args, grandchildState, grandchildAlive: ['R', 'S', 'D'].includes(grandchildState) }) + '\\n');
const statePath = process.env.STATE;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const [command, ...rest] = args;
if (command === 'run') {
  const labels = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') labels.push(args[i + 1]);
  const saved = load();
  saved.containers.push({ id: 'child-container', labels, removed: false });
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const key = filter.startsWith('label=') ? filter.slice('label='.length).split('=')[0] : '';
  const saved = load();
  output(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
  process.exit(0);
}
if (command === 'rm') {
  const ids = new Set(rest.filter(id => id !== '-f'));
  const saved = load();
  for (const container of saved.containers) if (ids.has(container.id)) container.removed = true;
  writeFileSync(statePath, JSON.stringify(saved));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(hang, `import { test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
test('orphan', () => {
  writeFileSync(process.env.CHILD_PID, String(process.pid));
  const grandchild = spawn(process.execPath, ['-e', \`
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.env.GRANDCHILD_PID, String(process.pid));
    setInterval(() => {}, 1_000);
  \`], { detached: true, stdio: 'ignore' });
  grandchild.unref();
  const deadline = Date.now() + 5_000;
  while (!existsSync(process.env.GRANDCHILD_PID) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const result = spawnSync('docker', ['run', '-d', '--name', 'rezics-reap-orphan-child', 'alpine', 'sleep', '600'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'docker run failed');
  writeFileSync(process.env.READY, 'ready');
  process.on('SIGTERM', () => process.exit(0));
  return new Promise(() => {});
});
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, LOG: log, STATE: state,
    CHILD_PID: childPidFile, GRANDCHILD_PID: grandchildPidFile, REZICS_REAP_OWNER: '4:4',
  };
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const dispatcher = spawn('bun', [join(root, 'scripts/qa/test.ts'), hang, '--timeout=60000'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  dispatcher.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready), stderr).toBe(true);
    const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    const before = readFileSync(`/proc/${grandchildPid}/stat`, 'utf8');
    expect(Number(before.slice(before.lastIndexOf(')') + 2).split(' ')[1])).toBe(childPid);
    dispatcher.kill('SIGTERM');
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      dispatcher.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(closed, stderr).toEqual({ code: 143, signal: null });
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { args: string[]; grandchildAlive: boolean });
    expect(calls.find(call => call.args[0] === 'run')?.grandchildAlive).toBe(true);
    const scopeCalls = calls.filter(call => call.args.some(arg => arg.startsWith(`label=${reapScopeLabel}.`)));
    expect(scopeCalls.length).toBeGreaterThan(0);
    expect(scopeCalls.filter(call => call.grandchildAlive)).toEqual([]);
    const removed = calls.filter(call => call.args[0] === 'rm').flatMap(call => call.args.slice(2));
    expect(removed).toContain('child-container');
    expect(removed).not.toContain('ancestor');
  } finally {
    dispatcher.kill('SIGKILL');
    try { process.kill(-Number(readFileSync(grandchildPidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('project settings cannot replace the reap owner a docker environment already carries', () => {
  const inherited = {
    PATH: `${dockerShimDirectory()}:${process.env.PATH ?? ''}`,
    REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPES: 'shard-a', DOCKER_HOST: 'unix:///run/docker.sock',
  };
  const saved = { PATH: '/usr/bin', REZICS_REAP_OWNER: '1:1', POSTGRES_PASSWORD: 'secret' };
  const composed = composeProcessEnvironment(inherited, saved);
  expect(composed.REZICS_REAP_OWNER).toBe('9:8');
  expect(composed.REZICS_REAP_SCOPES).toBe('shard-a');
  expect(composed.PATH?.startsWith(`${dockerShimDirectory()}:`)).toBe(true);
  expect(composed.POSTGRES_PASSWORD).toBe('secret');
  expect(composed.DOCKER_HOST).toBe('unix:///run/docker.sock');
  const previous = process.env.REZICS_REAP_OWNER;
  process.env.REZICS_REAP_OWNER = '9:8';
  try {
    const loaded = loadDockerEnvironment({ DOCKER_HOST: 'unix:///run/docker.sock' }, () => true);
    expect(loaded.REZICS_REAP_OWNER).toBe('9:8');
    expect(loaded.PATH?.split(':')[0]).toBe(dockerShimDirectory());
  } finally {
    if (previous === undefined) delete process.env.REZICS_REAP_OWNER;
    else process.env.REZICS_REAP_OWNER = previous;
  }
});

test('a stack started through qaStack carries the owner label and a killed owner leaves nothing', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-qastack-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const state = join(directory, 'containers.json');
  const log = join(directory, 'calls.jsonl');
  const runId = `own${process.pid.toString(16).slice(0, 6)}${Date.now().toString(16).slice(-4)}`;
  writeFileSync(state, JSON.stringify({ containers: [] }));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
${dockerOutput}import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, JSON.stringify(args) + '\\n');
const statePath = process.env.STATE;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = (value) => writeFileSync(statePath, JSON.stringify(value));
const [command] = args;
if (command === 'info') { output('28.0.0'); process.exit(0); }
if (command === 'compose' && args.includes('--services')) { output('postgres'); process.exit(0); }
if (command === 'compose' && args.includes('config')) process.exit(0);
if (command === 'compose' && args.includes('up')) {
  let owner = '';
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-f' || args[i] === '--file') && args[i + 1]) {
      try {
        const match = /rezics\\.reap-owner:\\s*"([^"]+)"/.exec(readFileSync(args[i + 1], 'utf8'));
        if (match) owner = match[1];
      } catch { /* the compose file itself has no reap label */ }
    }
  }
  const saved = load();
  saved.containers.push({ id: 'qa-stack', owner, removed: false });
  save(saved);
  process.exit(0);
}
if (command === 'ps') {
  const filter = args[args.indexOf('--filter') + 1] ?? '';
  if (filter !== 'label=${reapOwnerLabel}') process.exit(0);
  output(load().containers.filter(container => !container.removed).map(container => container.id).join('\\n'));
  process.exit(0);
}
if (command === 'inspect') {
  const id = args.at(-1);
  output(load().containers.find(container => container.id === id)?.owner ?? '');
  process.exit(0);
}
if (command === 'rm') {
  const ids = new Set(args.filter(id => id !== '-f' && id !== 'rm'));
  const saved = load();
  for (const container of saved.containers) if (ids.has(container.id)) container.removed = true;
  save(saved);
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const childSource = join(directory, 'start-stack.ts');
  writeFileSync(childSource, `import { reapOwnerAssignment } from ${JSON.stringify(join(root, 'scripts/qa/container-reaper.ts'))};
import { ensureSecrets } from ${JSON.stringify(join(root, 'scripts/dev/config.ts'))};
import { qaStack } from ${JSON.stringify(join(root, 'tests/qa/fault-recovery/search-ops-support.ts'))};
const assigned = reapOwnerAssignment(process.env);
for (const [key, value] of Object.entries(assigned.environment)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const runId = process.env.RUN_ID;
ensureSecrets(process.env.ROOT, { profile: 'qa', runId, persistent: true });
const result = qaStack(runId).compose(['up', '-d']);
if (result.status !== 0) {
  console.error(result.output);
  process.exit(1);
}
setInterval(() => {}, 1_000);
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STATE: state, LOG: log, RUN_ID: runId, ROOT: root,
  };
  delete env.REZICS_REAP_OWNER;
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  delete env.REZICS_REAP_STATE;
  delete env.REZICS_REAP_PRELOAD;
  const child = spawn('bun', [childSource], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const savedPath = process.env.PATH;
  const savedState = process.env.STATE;
  const savedLog = process.env.LOG;
  let owner = '';
  try {
    const deadline = Date.now() + 45_000;
    let containers: { id: string; owner: string; removed: boolean }[] = [];
    while (Date.now() < deadline) {
      containers = JSON.parse(readFileSync(state, 'utf8')).containers;
      if (containers.length) break;
      if (child.exitCode !== null) break;
      await Bun.sleep(50);
    }
    expect(containers, stderr).toHaveLength(1);
    owner = containers[0]!.owner;
    expect(owner).toBe(`${child.pid}:${processStartTime(child.pid!)}`);
    expect(containers[0]!.removed).toBe(false);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
    expect(reapOwnerAlive(owner)).toBe(false);
    expect(JSON.parse(readFileSync(state, 'utf8')).containers[0].removed).toBe(false);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.STATE = state;
    process.env.LOG = log;
    sweepOrphanContainers();
    const after = JSON.parse(readFileSync(state, 'utf8')).containers as { id: string; removed: boolean }[];
    expect(after.filter(container => !container.removed)).toEqual([]);
    expect(after.some(container => container.id === 'qa-stack' && container.removed)).toBe(true);
  } finally {
    child.kill('SIGKILL');
    process.env.PATH = savedPath;
    if (savedState === undefined) delete process.env.STATE;
    else process.env.STATE = savedState;
    if (savedLog === undefined) delete process.env.LOG;
    else process.env.LOG = savedLog;
    rmSync(directory, { recursive: true, force: true });
    rmSync(join(root, '.temp', 'stack', `rezics-qa-${runId}`), { recursive: true, force: true });
    if (owner) rmSync(reapStateDirectory(owner) ?? join(root, '.temp', 'reap', 'missing'), { recursive: true, force: true });
  }
}, 60_000);
