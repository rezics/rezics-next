import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireHostControl,
  activeHostControlCount,
  dropStaleHostMaster,
  ensureSshControlDirectory,
  hostControlSocketPath,
  hostMasterIsLive,
  releaseHostControl,
  resetHostControlLeases,
  rsyncRemoteShell,
  sshControlArgv,
  sshControlDirectory,
  sshControlOptions,
  sshExecutable,
} from './check-ssh.ts';

const repository = resolve(import.meta.dir, '..');
const fixtures: string[] = [];

function fixture(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/check-ssh-'));
  fixtures.push(directory);
  return directory;
}

afterEach(() => {
  resetHostControlLeases();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function host(name: string) {
  return { name, address: `ops@${name}.test`, identity: `/keys/${name}` };
}

function writeFakeSsh(directory: string, script: string): string {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, script);
  chmodSync(ssh, 0o755);
  return bin;
}

test('each configured host has one control socket under the workspace .temp directory', () => {
  const workspace = fixture();
  const directory = sshControlDirectory(workspace);
  expect(directory).toBe(join(workspace, '.temp', 'ssh-control'));
  expect(hostControlSocketPath(directory, 'a')).toBe(join(directory, 'a'));
  expect(hostControlSocketPath(directory, 'b')).toBe(join(directory, 'b'));
  expect(hostControlSocketPath(directory, 'a')).not.toBe(hostControlSocketPath(directory, 'b'));
  const options = sshControlOptions(host('a'), directory);
  expect(options).toContain('ControlMaster=auto');
  expect(options).toContain('ControlPersist=10m');
  expect(options).toContain(`ControlPath=${join(directory, 'a')}`);
  expect(options.filter((option) => option.startsWith('ControlPath='))).toHaveLength(1);
  expect(rsyncRemoteShell(host('a'), directory)).toContain(`ControlPath=${join(directory, 'a')}`);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});

test('REMOTE_CHECK_SSH_CONTROL_DIR overrides the workspace socket directory', () => {
  const directory = join(fixture(), 'explicit-control');
  expect(sshControlDirectory('/unused', { REMOTE_CHECK_SSH_CONTROL_DIR: directory })).toBe(directory);
  ensureSshControlDirectory(directory);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});

test('ssh control argv keeps -o/-O paired and never uses ControlPath=none', () => {
  const directory = join(fixture(), 'ssh-control');
  const probe = sshControlArgv(host('a'), directory, undefined, "printf 'ok\\n'");
  expect(probe[0]).toEndWith('/ssh');
  for (let index = 1; index < probe.length; index += 1) {
    if (probe[index] === '-o' || probe[index] === '-i' || probe[index] === '-O') {
      const value = probe[index + 1];
      expect(value).toBeDefined();
      expect(value).not.toStartWith('-');
      index += 1;
    }
  }
  expect(probe).not.toContain('ControlMaster=no');
  expect(probe).not.toContain('ControlPath=none');
  const check = sshControlArgv(host('a'), directory, 'check');
  expect(check[0]).toEndWith('/ssh');
  expect(check.slice(1, 3)).toEqual(['-O', 'check']);
  expect(check.at(-1)).toBe('ops@a.test');
});

test('concurrent callers share one host master and a completed run leaves the other lease held', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) process.exit(255);
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  process.stdout.write('REMOTE_CHECK_CONTROL_OK\\n');
  process.exit(0);
}
process.exit(0);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const control = join(directory, 'ssh-control');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_LOG = log;
  try {
    const first = await acquireHostControl(host('a'), control);
    const second = await acquireHostControl(host('a'), control);
    expect(first.socketPath).toBe(second.socketPath);
    expect(first.socketPath).toBe(join(control, 'a'));
    expect(activeHostControlCount(control, 'a')).toBe(2);
    releaseHostControl(first);
    expect(activeHostControlCount(control, 'a')).toBe(1);
    expect(readFileSync(log, 'utf8')).not.toMatch(/-O exit/);
    releaseHostControl(second);
    expect(activeHostControlCount(control, 'a')).toBe(0);
    expect(readFileSync(log, 'utf8')).not.toMatch(/-O exit/);
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a lost master is dropped with -O exit and the next acquire reconnects', async () => {
  const directory = fixture();
  const state = join(directory, 'state');
  writeFileSync(state, 'stale');
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const state = process.env.SSH_STATE!;
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) {
  process.exit(await Bun.file(state).text() === 'stale' ? 255 : 0);
}
if (args.includes('-O') && args.includes('exit')) {
  await Bun.write(state, 'cleared');
  process.exit(0);
}
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  if (await Bun.file(state).text() === 'stale') process.exit(255);
  process.stdout.write('REMOTE_CHECK_CONTROL_OK\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_STATE = state;
  process.env.SSH_LOG = log;
  try {
    expect(await hostMasterIsLive(host('b'), join(directory, 'ssh-control'))).toBe(false);
    await dropStaleHostMaster(host('b'), join(directory, 'ssh-control'));
    const lease = await acquireHostControl(host('b'), join(directory, 'ssh-control'));
    expect(lease.host.name).toBe('b');
    expect(readFileSync(log, 'utf8')).toContain('-O exit');
    expect(readFileSync(log, 'utf8')).toContain('REMOTE_CHECK_CONTROL_PROBE');
    releaseHostControl(lease);
  } finally {
    delete process.env.SSH_STATE;
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('sshExecutable walks PATH at call time so a fake ssh is used', () => {
  const directory = fixture();
  const bin = writeFakeSsh(directory, '#!/bin/sh\nexit 0\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    expect(sshExecutable()).toBe(join(bin, 'ssh'));
  } finally {
    process.env.PATH = previousPath;
  }
});
