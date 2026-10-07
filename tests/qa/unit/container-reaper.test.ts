import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { command } from '../../../scripts/qa/core.ts';
import {
  dockerShimDirectory, processStartTime, reapOwnerAlive, reapOwnerEnvironment, reapOwnerLabel, sweepOrphanContainers,
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
  const stub = join(directory, 'docker-stub');
  const captured = join(directory, 'argv.json');
  writeFileSync(stub, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
`);
  chmodSync(stub, 0o755);
  const run = (args: string[], owner?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, REZICS_REAL_DOCKER: stub, ARGV_FILE: captured };
    if (owner === undefined) delete env.REZICS_REAP_OWNER;
    else env.REZICS_REAP_OWNER = owner;
    const result = spawnSync(shim, args, { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(captured, 'utf8')) as string[];
  };
  try {
    const label = ['--label', `${reapOwnerLabel}=9:8`];
    expect(run(['run', '--rm', 'alpine', 'sleep', '600'], '9:8')).toEqual(['run', ...label, '--rm', 'alpine', 'sleep', '600']);
    expect(run(['create', '--name', 'box', 'alpine'], '9:8')).toEqual(['create', ...label, '--name', 'box', 'alpine']);
    expect(run(['container', 'run', '--rm', 'alpine'], '9:8')).toEqual(['container', 'run', ...label, '--rm', 'alpine']);
    expect(run(['container', 'create', 'alpine'], '9:8')).toEqual(['container', 'create', ...label, 'alpine']);
    expect(run(['--host', 'unix:///var/run/docker.sock', 'run', 'alpine'], '9:8'))
      .toEqual(['--host', 'unix:///var/run/docker.sock', 'run', ...label, 'alpine']);
    expect(run(['-Hunix:///var/run/docker.sock', 'create'], '9:8')).toEqual(['-Hunix:///var/run/docker.sock', 'create', ...label]);
    expect(run(['ps', '-a'], '9:8')).toEqual(['ps', '-a']);
    expect(run(['compose', 'up', '-d'], '9:8')).toEqual(['compose', 'up', '-d']);
    expect(run(['compose', 'run', 'web'], '9:8')).toEqual(['compose', 'run', 'web']);
    expect(run(['container', 'ls'], '9:8')).toEqual(['container', 'ls']);
    expect(run(['context', 'create', 'local'], '9:8')).toEqual(['context', 'create', 'local']);
    expect(run(['run', 'alpine'])).toEqual(['run', 'alpine']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

test('the runner sets its owner on test processes and keeps an inherited owner', () => {
  const start = processStartTime(process.pid);
  const assigned = reapOwnerEnvironment({ PATH: process.env.PATH, REZICS_REAL_DOCKER: '/usr/bin/docker' });
  expect(assigned.REZICS_REAP_OWNER).toBe(`${process.pid}:${start}`);
  expect(assigned.PATH?.startsWith(`${dockerShimDirectory()}:`)).toBe(true);
  expect(assigned.REZICS_REAL_DOCKER).toBe('/usr/bin/docker');
  const inherited = reapOwnerEnvironment({ ...assigned, REZICS_REAP_OWNER: '42:99' });
  expect(inherited.REZICS_REAP_OWNER).toBe('42:99');
  expect(inherited.PATH?.startsWith(`${dockerShimDirectory()}:`)).toBe(true);

  const directory = mkdtempSync(join(root, '.temp', 'reap-runner-'));
  const probe = join(directory, 'owner.test.ts');
  writeFileSync(probe, `import { test } from 'bun:test';
test('owner', () => {
  console.log('REAP_OWNER=' + process.env.REZICS_REAP_OWNER);
  console.log('REAP_PATH=' + (process.env.PATH ?? '').split(':')[0]);
});
`);
  const env = { ...process.env };
  delete env.REZICS_REAP_OWNER;
  try {
    const result = command(root, 'bun', ['test', probe], 30_000, env);
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain(`REAP_OWNER=${process.pid}:${start}`);
    expect(result.output).toContain(`REAP_PATH=${dockerShimDirectory()}`);
    const kept = command(root, 'bun', ['test', probe], 30_000, { ...env, REZICS_REAP_OWNER: '42:99' });
    expect(kept.ok, kept.output).toBe(true);
    expect(kept.output).toContain('REAP_OWNER=42:99');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
