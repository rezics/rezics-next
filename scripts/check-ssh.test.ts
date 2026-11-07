import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireHostControl,
  activeHostControlCount,
  clearPlacementProbeTimeout,
  controlSocketDirectoryPath,
  DEFAULT_CONTROL_PROBE_TIMEOUT_MS,
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

test('a cold control probe waits past ConnectTimeout so banner and key exchange can finish', () => {
  expect(DEFAULT_CONTROL_PROBE_TIMEOUT_MS).toBe(90_000);
});

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
  if (await Bun.file(state).text() === 'stale') { console.error('Connection refused'); process.exit(255); }
  process.exit(0);
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

test('a socket left by a killed master is removed before the probe, so the next master can bind the path', async () => {
  const directory = fixture();
  const control = join(directory, 'ssh-control');
  const socketPath = sshControlOptions(host('a'), control)
    .find((option) => option.startsWith('ControlPath='))!
    .slice('ControlPath='.length);
  // A listener that exits without cleanup leaves its socket file behind, as a killed OpenSSH master does.
  const listener = Bun.spawnSync([
    process.execPath,
    '-e',
    `Bun.listen({ unix: ${JSON.stringify(socketPath)}, socket: { data() {} } }); process.exit(0);`,
  ]);
  expect(listener.exitCode).toBe(0);
  expect(lstatSync(socketPath).isSocket()).toBe(true);
  const log = join(directory, 'ssh.log');
  writeFileSync(log, '');
  const bin = writeFakeSsh(
    directory,
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in ControlPath=*) path=\${argument#ControlPath=} ;; esac
done
printf '%s\n' "$*" >> "$SSH_LOG"
case " $* " in
  *" check "*)
    if [ -S "$path" ]; then echo "Control socket connect($path): Connection refused" >&2; else echo "Control socket connect($path): No such file or directory" >&2; fi
    exit 255 ;;
esac
case "$*" in *REMOTE_CHECK_CONTROL_PROBE*) echo REMOTE_CHECK_CONTROL_OK; exit 0 ;; esac
exit 2
`,
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.SSH_LOG = log;
  try {
    const lease = await acquireHostControl(host('a'), control);
    fixtures.push(lease.directory);
    expect(lease.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(false);
    const calls = readFileSync(log, 'utf8');
    expect(calls.indexOf('-O check')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('-O check')).toBeLessThan(calls.indexOf('REMOTE_CHECK_CONTROL_PROBE'));
    await releaseHostControl(lease);
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a failed probe reports the ssh failure, not the stale-socket warning OpenSSH prints before it', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/bin/sh
case "$*" in
  *REMOTE_CHECK_CONTROL_PROBE*)
    echo "ControlSocket /run/user/1000/rezics-ssh/a already exists, disabling multiplexing" >&2
    echo "ops@a.test: Permission denied (publickey)." >&2
    exit 255 ;;
esac
exit 0
`,
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const failure = await acquireHostControl(host('a'), join(directory, 'ssh-control')).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(failure).toContain('Permission denied (publickey).');
    expect(failure).not.toContain('disabling multiplexing');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('a failed probe against a live master never stops that master, since -O exit would cut every run multiplexed through it', async () => {
  const directory = fixture();
  const control = join(directory, 'ssh-control');
  const socketPath = sshControlOptions(host('a'), control)
    .find((option) => option.startsWith('ControlPath='))!
    .slice('ControlPath='.length);
  // A live master keeps its listener; the fake ssh answers `-O check` for it.
  const master = Bun.spawn([
    process.execPath,
    '-e',
    `Bun.listen({ unix: ${JSON.stringify(socketPath)}, socket: { data() {} } }); setInterval(() => {}, 1000);`,
  ]);
  try {
    for (let waited = 0; !existsSync(socketPath) && waited < 100; waited++) await Bun.sleep(20);
    const log = join(directory, 'ssh.log');
    const count = join(directory, 'probes');
    writeFileSync(log, '');
    writeFileSync(count, '0');
    const bin = writeFakeSsh(
      directory,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$SSH_LOG"
case " $* " in
  *" check "*) echo "Master running (pid=1)" >&2; exit 0 ;;
  *" exit "*) echo "Exit request sent." >&2; exit 0 ;;
esac
case "$*" in
  *REMOTE_CHECK_CONTROL_PROBE*)
    n=$(cat "$SSH_COUNT"); n=$((n + 1)); echo "$n" > "$SSH_COUNT"
    if [ "$n" -eq 1 ]; then echo "kex_exchange_identification: read: Connection reset by peer" >&2; exit 255; fi
    echo REMOTE_CHECK_CONTROL_OK; exit 0 ;;
esac
exit 2
`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.SSH_LOG = log;
    process.env.SSH_COUNT = count;
    try {
      const lease = await acquireHostControl(host('a'), control);
      fixtures.push(lease.directory);
      expect(readFileSync(count, 'utf8').trim()).toBe('2');
      expect(readFileSync(log, 'utf8')).not.toContain('-O exit');
      await releaseHostControl(lease);
    } finally {
      delete process.env.SSH_LOG;
      delete process.env.SSH_COUNT;
      process.env.PATH = previousPath;
    }
  } finally {
    master.kill();
    await master.exited;
  }
});

test('an affirmatively dead master with no lease is recovered with -O exit at most once per minute', async () => {
  const directory = fixture();
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.SSH_LOG!;
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) { console.error('Connection refused'); process.exit(255); }
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
if (args.includes('-O')) { if (args.includes('check')) console.error('Connection refused'); process.exit(args.includes('check') ? 255 : 0); }
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
    expect(readFileSync(log, 'utf8')).toContain('REMOTE_CHECK_CONTROL_PROBE');
    expect(readFileSync(log, 'utf8')).not.toMatch(/-O exit/);
    await releaseHostControl(lease);
    expect(hostControlLeaseIsHeld(lease.directory, 'a')).toBe(false);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toContain('-O exit');
  } finally {
    delete process.env.SSH_LOG;
    process.env.PATH = previousPath;
  }
});

test('a dead master cannot be retired until its active run lease is released', async () => {
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
  if ((await Bun.file(state).text()) !== 'live') { console.error('Connection refused'); process.exit(255); }
  process.exit(0);
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
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toContain('-O exit');
    await releaseHostControl(lease);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now())).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('-O exit');
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

test('a delayed answering master remains uncertain after its check deadline, with and without an active lease', async () => {
  const directory = fixture();
  const log = join(directory, 'ssh.log');
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.SSH_LOG!, args.join(' ') + '\\n');
if (args.includes('-O') && args.includes('check')) { await Bun.sleep(200); process.exit(0); }
if (args.includes('-O')) process.exit(0);
console.log('REMOTE_CHECK_CONTROL_OK');
`,
  );
  const previous = { ...process.env };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SSH_LOG = log;
  try {
    const lease = await acquireHostControl(host('a'), join(directory, 'control'));
    fixtures.push(lease.directory);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now(), 20)).toBe(false);
    await releaseHostControl(lease);
    expect(await recoverHungHostMaster(host('a'), lease.directory, Date.now(), 20)).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toContain('-O exit');
  } finally {
    process.env = previous;
  }
});

test('cross-process acquisition waits until the exclusive recovery check and retirement have settled', async () => {
  const directory = fixture();
  const checking = join(directory, 'checking');
  const gate = join(directory, 'gate');
  const acquired = join(directory, 'acquired');
  const control = join(directory, 'control');
  fixtures.push(sshControlDirectory(directory, { REMOTE_CHECK_SSH_CONTROL_DIR: control }));
  const bin = writeFakeSsh(
    directory,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-O') && args.includes('check')) {
  writeFileSync(${JSON.stringify(checking)}, 'checking');
  while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
  console.error('Connection refused'); process.exit(255);
}
if (args.includes('-O')) process.exit(0);
console.log('REMOTE_CHECK_CONTROL_OK');
`,
  );
  const previous = { ...process.env };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let recovery: Promise<boolean> | undefined;
  try {
    recovery = recoverHungHostMaster(host('a'), control, Date.now(), 2_000);
    for (let count = 0; count < 200 && !existsSync(checking); count++) await Bun.sleep(5);
    expect(existsSync(checking)).toBe(true);
    child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { acquireHostControl, releaseHostControl } from ${JSON.stringify(resolve(repository, 'scripts/check-ssh.ts'))};
      import { writeFileSync } from 'node:fs';
      const lease = await acquireHostControl(${JSON.stringify(host('a'))}, ${JSON.stringify(control)});
      process.on('SIGTERM', async () => { await releaseHostControl(lease); process.exit(0); });
      writeFileSync(${JSON.stringify(acquired)}, 'acquired');
      await new Promise(() => setInterval(() => {}, 1000));
    `,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: process.env },
    );
    await Bun.sleep(100);
    expect(existsSync(acquired)).toBe(false);
    writeFileSync(gate, 'continue');
    expect(await recovery).toBe(true);
    for (let count = 0; count < 200 && !existsSync(acquired); count++) await Bun.sleep(5);
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    expect(existsSync(acquired)).toBe(true);
    expect(hostControlLeaseIsHeld(control, 'a')).toBe(true);
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(hostControlLeaseIsHeld(control, 'a')).toBe(false);
  } finally {
    writeFileSync(gate, 'continue');
    await recovery;
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    process.env = previous;
  }
});
