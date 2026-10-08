import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { command } from '../../../scripts/qa/core.ts';
import {
  dockerShimDirectory, processStartTime, reapChildScope, reapCreatedOwner, reapOwnerAlive, reapOwnerAssignment,
  reapOwnerEnvironment, reapOwnerLabel, reapScopeLabel, sweepOrphanContainers,
} from '../../../scripts/qa/container-reaper.ts';

const root = resolve(import.meta.dir, '../../..');
const shim = join(dockerShimDirectory(), 'docker');

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
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const [command, ...rest] = args;
if (command === 'ps') {
  if (!rest.includes(${JSON.stringify(`label=${reapOwnerLabel}`)})) console.log('unlabelled');
  else console.log('dead\\nreused\\nlive');
  process.exit(0);
}
if (command === 'inspect') {
  const owners = ${JSON.stringify(owners)};
  console.log(owners[rest.at(-1)] ?? '');
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ''}`;
  try {
    sweepOrphanContainers();
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === 'ps')).toEqual([['ps', '-aq', '--filter', `label=${reapOwnerLabel}`]]);
    expect(calls.some(call => call.includes('unlabelled') || call[0] === 'ps' && !call.includes(`label=${reapOwnerLabel}`))).toBe(false);
    expect(calls.filter(call => call[0] === 'rm')).toEqual([['rm', '-f', 'dead', 'reused']]);
    expect(calls.flat()).not.toContain('unlabelled');
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
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const [command, ...rest] = args;
if (command === 'ps') {
  const filter = rest[rest.indexOf('--filter') + 1] ?? '';
  const containers = ${JSON.stringify(listed)};
  if (containers[filter]) console.log(containers[filter]);
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

test('a timed-out child removes only its scope and leaves a sibling container', () => {
  const directory = mkdtempSync(join(root, '.temp', 'reap-scope-'));
  const stub = dockerStub(directory, {
    [`label=${reapScopeLabel}.shard-a`]: 'timed-out',
    [`label=${reapScopeLabel}.shard-b`]: 'live-sibling',
    [`label=${reapOwnerLabel}=9:8`]: 'timed-out\nlive-sibling',
  });
  try {
    stub.use(() => reapChildScope({ REZICS_REAP_OWNER: '9:8', REZICS_REAP_SCOPE: 'shard-a' }));
    const calls = readFileSync(stub.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === 'ps')).toEqual([['ps', '-aq', '--filter', `label=${reapScopeLabel}.shard-a`]]);
    expect(calls.filter(call => call[0] === 'rm')).toEqual([['rm', '-f', 'timed-out']]);
    expect(calls.flat()).not.toContain('live-sibling');
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
import { appendFileSync } from 'node:fs';
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
  console.log(ids.filter(id => id && !removed.has(id)).join('\\n'));
  process.exit(0);
}
if (command === 'rm') process.env.REMOVED = [...removed, ...rest.slice(1).filter(id => id !== '-f')].join(',');
process.exit(0);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(hang, `import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
test('hang', () => {
  writeFileSync(process.env.READY!, 'ready');
  return new Promise(() => {});
});
`);
  writeFileSync(runner, `import { noteChildScope } from ${JSON.stringify(join(root, 'scripts/qa/container-reaper.ts'))};
import { commandAsync } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
noteChildScope('extra-child');
await commandAsync(${JSON.stringify(directory)}, 'bun', ['test', ${JSON.stringify(hang)}, '--timeout=60000'], 60_000, process.env);
`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, REZICS_REAP_OWNER: '4:4' };
  delete env.REZICS_REAP_SCOPE;
  delete env.REZICS_REAP_SCOPES;
  const child = spawn('bun', [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
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
    expect(calls.some(call => call.join(' ').includes(`${reapOwnerLabel}=`) || call.includes('ancestor') || call.includes('sibling'))).toBe(false);
  } finally {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.log(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.log(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.log(saved.containers.filter(container => !container.removed && container.labels.some(label => label.split('=')[0] === key)).map(container => container.id).join('\\n'));
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
