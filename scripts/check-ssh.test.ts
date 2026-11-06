import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireHostControl,
  activeHostControlCount,
  clearPlacementProbeTimeout,
  controlSocketDirectoryPath,
  dropStaleHostMaster,
  ensureSshControlDirectory,
  hostControlLeaseIsHeld,
  hostControlSocketPath,
  hostMasterIsLive,
  MASTER_RECOVERY_INTERVAL_MS,
  notePlacementProbeTimeout,
  PLACEMENT_PROBE_TIMEOUT_EVENT_MS,
  placementProbeTimeoutEvent,
  recoverHungHostMaster,
  releaseHostControl,
  resetHostControlLeases,
  rsyncRemoteShell,
  sshControlArgv,
  sshControlDirectory,
  sshControlOptions,
  sshExecutable,
  unixListenerFits,
  UNIX_LISTENER_PATH_LIMIT,
  UNIX_LISTENER_TMP_SUFFIX,
} from './check-ssh.ts';

const repository = resolve(import.meta.dir, '..');
const fixtures: string[] = [];

function fixture(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/check-ssh-'));
  fixtures.push(directory);
  return directory;
}

afterEach(async () => {
  await resetHostControlLeases();
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

test('each configured host has one short control socket independent of worktree path length', () => {
  const workspace = fixture();
  const runtime = mkdtempSync('/tmp/rzssh-');
  fixtures.push(runtime);
  const directory = sshControlDirectory(workspace, { XDG_RUNTIME_DIR: runtime });
  expect(directory).toBe(join(runtime, 'rezics-ssh'));
  expect(directory).toBe(controlSocketDirectoryPath(runtime, process.getuid?.() ?? 0));
  expect(unixListenerFits(join(directory, 'a'))).toBe(true);
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

test('a ControlPath under a long worktree relocates so OpenSSH unix_listener still fits', () => {
  const long = join(fixture(), 'x'.repeat(80), 'ssh-control');
  expect(unixListenerFits(join(long, 'a'))).toBe(false);
  const directory = sshControlDirectory('/unused', { REMOTE_CHECK_SSH_CONTROL_DIR: long });
  expect(directory.startsWith('/tmp/rs')).toBe(true);
  expect(unixListenerFits(join(directory, 'a'))).toBe(true);
  expect(unixListenerFits(join(directory, 'h'.repeat(64)))).toBe(true);
  expect(Buffer.byteLength(join(directory, 'a')) + UNIX_LISTENER_TMP_SUFFIX).toBeLessThan(UNIX_LISTENER_PATH_LIMIT);
  ensureSshControlDirectory(directory);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  fixtures.push(directory);
});

test('REMOTE_CHECK_SSH_CONTROL_DIR keeps a short override', () => {
  const directory = mkdtempSync('/tmp/rzssh-');
  fixtures.push(directory);
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
    fixtures.push(first.directory);
    const second = await acquireHostControl(host('a'), control);
    expect(first.socketPath).toBe(second.socketPath);
    expect(unixListenerFits(first.socketPath)).toBe(true);
    expect(activeHostControlCount(first.directory, 'a')).toBe(2);
    await releaseHostControl(first);
    expect(activeHostControlCount(first.directory, 'a')).toBe(1);
    expect(readFileSync(log, 'utf8')).not.toMatch(/-O exit/);
    await releaseHostControl(second);
    expect(activeHostControlCount(first.directory, 'a')).toBe(0);
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
    fixtures.push(lease.directory);
    expect(lease.host.name).toBe('b');
    expect(readFileSync(log, 'utf8')).toContain('-O exit');
    expect(readFileSync(log, 'utf8')).toContain('REMOTE_CHECK_CONTROL_PROBE');
    await releaseHostControl(lease);
  } finally {
    delete process.env.SSH_STATE;
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a failed control probe reports the ssh error, including unix_listener overflow', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  process.stderr.write('unix_listener: temporary suffix exceeds the Unix socket path limit\\n');
  process.exit(255);
}
process.exit(0);
`,
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    await expect(acquireHostControl(host('a'), join(directory, 'ssh-control'))).rejects.toThrow(
      'unix_listener: temporary suffix exceeds the Unix socket path limit',
    );
  } finally {
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

test('a hung master with no live lease is recovered with -O exit at most once per minute', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) process.exit(0);
if (args.includes('-O') && args.includes('exit')) process.exit(0);
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  process.stdout.write('REMOTE_CHECK_CONTROL_OK\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const control = join(directory, 'ssh-control');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_LOG = log;
  try {
    const now = 1_700_000_000_000;
    expect(await recoverHungHostMaster(host('b'), control, now)).toBe(true);
    fixtures.push(control);
    expect(await recoverHungHostMaster(host('b'), control, now)).toBe(false);
    expect(await recoverHungHostMaster(host('b'), control, now + MASTER_RECOVERY_INTERVAL_MS - 1)).toBe(false);
    expect(await recoverHungHostMaster(host('b'), control, now + MASTER_RECOVERY_INTERVAL_MS)).toBe(true);
    const seen = readFileSync(log, 'utf8');
    expect(seen.match(/-O check/g)).toHaveLength(2);
    expect(seen.match(/-O exit/g)).toHaveLength(2);
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('concurrent recoveries of one host take -O exit once per minute', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O')) process.exit(args.includes('check') ? 255 : 0);
process.exit(2);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const control = join(directory, 'ssh-control');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_LOG = log;
  try {
    const now = 1_700_000_000_000;
    const results = await Promise.all([
      recoverHungHostMaster(host('c'), control, now),
      recoverHungHostMaster(host('c'), control, now),
      recoverHungHostMaster(host('c'), control, now),
    ]);
    fixtures.push(control);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readFileSync(log, 'utf8').match(/-O exit/g)).toHaveLength(1);
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a live master is not recovered while a run holds its lease', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) process.exit(0);
if (args.includes('-O') && args.includes('exit')) process.exit(0);
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  process.stdout.write('REMOTE_CHECK_CONTROL_OK\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const control = join(directory, 'ssh-control');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_LOG = log;
  try {
    const lease = await acquireHostControl(host('a'), control);
    fixtures.push(lease.directory);
    expect(hostControlLeaseIsHeld(lease.directory, 'a')).toBe(true);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(false);
    expect(readFileSync(log, 'utf8')).toContain('-O check');
    expect(readFileSync(log, 'utf8')).not.toMatch(/-O exit/);
    await releaseHostControl(lease);
    expect(hostControlLeaseIsHeld(lease.directory, 'a')).toBe(false);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('-O exit');
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a dead master is recovered even while a run holds its lease', async () => {
  const directory = fixture();
  const state = join(directory, 'state');
  writeFileSync(state, 'live');
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const state = process.env.SSH_STATE!;
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) {
  process.exit((await Bun.file(state).text()) === 'live' ? 0 : 255);
}
if (args.includes('-O') && args.includes('exit')) process.exit(0);
if (args.some((argument) => argument.includes('REMOTE_CHECK_CONTROL_PROBE'))) {
  process.stdout.write('REMOTE_CHECK_CONTROL_OK\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const control = join(directory, 'ssh-control');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_STATE = state;
  process.env.SSH_LOG = log;
  try {
    const lease = await acquireHostControl(host('a'), control);
    fixtures.push(lease.directory);
    writeFileSync(state, 'dead');
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('-O exit');
    await releaseHostControl(lease);
  } finally {
    delete process.env.SSH_STATE;
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('five minutes of consecutive probe timeouts report one environment event naming the host', async () => {
  const directory = fixture();
  const control = join(directory, 'ssh-control');
  ensureSshControlDirectory(control);
  fixtures.push(control);
  const started = 1_700_000_000_000;
  expect(await notePlacementProbeTimeout(control, 'b', 'probe timed out', started)).toBeNull();
  expect(
    await notePlacementProbeTimeout(control, 'b', 'probe timed out', started + PLACEMENT_PROBE_TIMEOUT_EVENT_MS - 1),
  ).toBeNull();
  expect(
    await notePlacementProbeTimeout(control, 'b', 'probe timed out', started + PLACEMENT_PROBE_TIMEOUT_EVENT_MS),
  ).toBe(placementProbeTimeoutEvent('b', 'probe timed out'));
  expect(
    await notePlacementProbeTimeout(control, 'b', 'probe timed out', started + PLACEMENT_PROBE_TIMEOUT_EVENT_MS + 1),
  ).toBeNull();
  await clearPlacementProbeTimeout(control, 'b');
  expect(await notePlacementProbeTimeout(control, 'b', 'Master running', started + 6 * 60_000)).toBeNull();
  expect(
    await notePlacementProbeTimeout(
      control,
      'b',
      'connection timed out',
      started + 6 * 60_000 + PLACEMENT_PROBE_TIMEOUT_EVENT_MS,
    ),
  ).toBe(placementProbeTimeoutEvent('b', 'connection timed out'));
});
