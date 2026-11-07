import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const script = join(repository, 'scripts/provision-check-host.sh');
const bunExecutable = process.execPath;

type Event = { command: string; args: string[] };
type ScenarioOptions = {
  address?: string;
  installed?: string[];
  osRelease?: string;
  existingSshdConfig?: string;
  playwrightVersion?: string;
  legacyWalkState?: boolean;
};

let root: string;
let counter = 0;
const canRecoverAsNobody =
  process.getuid?.() === 0 &&
  spawnSync('runuser', ['-u', 'nobody', '--', 'test', '-r', join(repository, 'scripts/stack-lease.ts')]).status === 0 &&
  spawnSync('runuser', ['-u', 'nobody', '--', 'test', '-x', process.execPath]).status === 0;

beforeAll(() => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  root = mkdtempSync(join(repository, '.temp/provision-check-host-test-'));
  chmodSync(root, 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function scenario(options: ScenarioOptions = {}) {
  const directory = join(root, `scenario-${counter++}`);
  const bin = join(directory, 'bin');
  const temporaryDirectory = join(directory, 'tmp');
  const sshdConfigDirectory = join(directory, 'etc/ssh/sshd_config.d');
  const sshdConfig = join(sshdConfigDirectory, '90-rezics-checks.conf');
  const log = join(directory, 'events.jsonl');
  const received = join(directory, 'received-remote-script');
  const osRelease = join(directory, 'os-release');
  const identity = join(directory, 'identity');
  const scenarioScript = join(directory, 'provision-check-host.sh');
  const walkDirectory = join(directory, 'tmp/rezics-walk-stacks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  chmodSync(directory, 0o755);
  mkdirSync(join(directory, 'etc/systemd/system'), { recursive: true });
  mkdirSync(sshdConfigDirectory, { recursive: true });
  writeFileSync(identity, 'fake identity');
  writeFileSync(osRelease, options.osRelease ?? 'ID=fedora\nID_LIKE="rhel fedora"\n');
  if (options.existingSshdConfig !== undefined) writeFileSync(sshdConfig, options.existingSshdConfig);
  if (options.playwrightVersion !== undefined) {
    const source = readFileSync(script, 'utf8');
    const quotedVersion = `'${options.playwrightVersion.replaceAll("'", "'\\''")}'`;
    writeFileSync(scenarioScript, source.replace('playwright_version=1.64.1', `playwright_version=${quotedVersion}`));
  }
  if (options.legacyWalkState) {
    mkdirSync(walkDirectory, { recursive: true, mode: 0o755 });
    chmodSync(walkDirectory, 0o755);
    for (const [name, contents] of Object.entries({
      'queue.lock': '',
      sequence: '41',
      'sequence.next': '42',
      'slot-1.lock': '',
      'ticket-40': '',
    })) {
      const file = join(walkDirectory, name);
      writeFileSync(file, contents);
      chmodSync(file, 0o644);
    }
  }

  const fakeSsh = `#!${bunExecutable}
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const original = await Bun.stdin.text();
writeFileSync(process.env.PROVISION_RECEIVED!, original);
const replacements: Array<[string, string]> = [
  ['/tmp/rezics-walk-stacks', process.env.PROVISION_DIRECTORY + '/tmp/rezics-walk-stacks'],
  ['/etc/os-release', process.env.PROVISION_OS_RELEASE!],
  ['/srv/rezics-check', process.env.PROVISION_DIRECTORY + '/srv/rezics-check'],
  ['/etc/systemd/system', process.env.PROVISION_DIRECTORY + '/etc/systemd/system'],
  ['/etc/ssh/sshd_config.d', process.env.PROVISION_DIRECTORY + '/etc/ssh/sshd_config.d'],
  ['/root/.bun/install/cache/@t@', process.env.PROVISION_DIRECTORY + '/root/.bun/install/cache/@t@'],
  ['/usr/local/bin:$PATH', process.env.PROVISION_BIN + ':$PATH'],
  ['/usr/local/bin/bun', process.env.PROVISION_BIN + '/bun'],
  ['/usr/local/bin/node', process.env.PROVISION_BIN + '/node'],
];
let remote = original;
for (const [from, to] of replacements) remote = remote.split(from).join(to);
const args = process.argv.slice(2);
const destination = args.findIndex((arg) => /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(arg));
if (destination < 0) throw new Error('expected ssh destination');
const remoteCommand = args.slice(destination + 1).join(' ');
const result = spawnSync('bash', ['-c', remoteCommand], {
  env: process.env,
  input: remote,
  encoding: 'utf8',
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`;
  const fakeCommand = `#!${bunExecutable}
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const command = basename(process.argv[1]!);
const args = process.argv.slice(2);
const event = { command, args };
appendFileSync(process.env.PROVISION_LOG!, JSON.stringify(event) + '\\n');
const installed: string[] = JSON.parse(process.env.PROVISION_INSTALLED!);
if (command === 'rpm') process.exit(installed.includes(args[1]!) ? 0 : 1);
if (command === 'dpkg') process.exit(installed.includes(args[1]!) ? 0 : 1);
if (command === 'bun' && args[0] === '--version') {
  console.log('1.4.3');
  process.exit(0);
}
if (command === 'bun') process.exit(0);
if (command === 'node' && args[0] === '--version') {
  console.log('v26.13.0');
  process.exit(0);
}
if (command === 'node') process.exit(0);
`;
  const commands = {
    ssh: fakeSsh,
    rpm: fakeCommand,
    dnf: fakeCommand,
    dpkg: fakeCommand,
    'apt-get': fakeCommand,
    bun: fakeCommand,
    node: fakeCommand,
    sshd: fakeCommand,
    systemctl: fakeCommand,
  };
  for (const [name, contents] of Object.entries(commands)) {
    const command = join(bin, name);
    writeFileSync(command, contents);
    chmodSync(command, 0o755);
  }

  const events = (): Event[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const run = (address = options.address ?? 'root@check.test') =>
    spawnSync(
      'bash',
      [options.playwrightVersion === undefined ? script : scenarioScript, address, identity, '16', '800'],
      {
        cwd: repository,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PROVISION_BIN: bin,
          PROVISION_DIRECTORY: directory,
          PROVISION_INSTALLED: JSON.stringify(options.installed ?? []),
          PROVISION_LOG: log,
          PROVISION_OS_RELEASE: osRelease,
          PROVISION_RECEIVED: received,
          TMPDIR: temporaryDirectory,
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );

  return { directory, events, received, run, sshdConfig, walkDirectory };
}

function recoverAsNobody(directory: string) {
  const args = [
    '-u',
    'nobody',
    '--',
    process.execPath,
    join(repository, 'scripts/stack-lease.ts'),
    'provision-recovery',
    '--',
    process.execPath,
    '-e',
    'console.log("non-root acquired");',
  ];
  return spawnSync('runuser', args, {
    cwd: repository,
    env: { ...process.env, REZICS_STACK_LEASE_DIR: directory, REZICS_STACK_SLOTS: '1' },
    encoding: 'utf8',
  });
}

test('a Fedora host installs missing packages with dnf', () => {
  const fixture = scenario({ osRelease: 'ID=fedora\nID_LIKE="rhel fedora"\n' });

  const result = fixture.run();

  expect(result.status, result.stderr).toBe(0);
  const events = fixture.events();
  const packages = ['git', 'rsync', 'unzip', 'xz', 'curl', 'ca-certificates', 'util-linux'];
  expect(events.filter((event) => event.command === 'rpm').map((event) => event.args)).toEqual(
    packages.map((name) => ['-q', name]),
  );
  expect(events.find((event) => event.command === 'dnf')?.args).toEqual(['install', '-y', ...packages]);
  expect(events.find((event) => event.command === 'systemctl' && event.args[0] === 'reload')?.args).toEqual([
    'reload',
    'sshd.service',
  ]);
  expect(events.some((event) => event.command === 'apt-get')).toBe(false);
});

if (canRecoverAsNobody) {
  test('provision repairs root-created walk admission state and admits a non-root caller', () => {
    const fixture = scenario({ address: 'root@127.0.0.1', legacyWalkState: true });
    const oldQueueInode = statSync(join(fixture.walkDirectory, 'queue.lock')).ino;
    const oldSlotInode = statSync(join(fixture.walkDirectory, 'slot-1.lock')).ino;
    const oldTicketInode = statSync(join(fixture.walkDirectory, 'ticket-40')).ino;

    const provision = fixture.run();

    expect(provision.status, provision.stderr).toBe(0);
    expect(statSync(fixture.walkDirectory).mode & 0o7777).toBe(0o1777);
    expect(statSync(join(fixture.walkDirectory, 'tickets')).mode & 0o777).toBe(0o777);
    for (const name of ['queue.lock', 'sequence', 'sequence.next', 'slot-1.lock'])
      expect(statSync(join(fixture.walkDirectory, name)).mode & 0o777).toBe(0o666);
    expect(statSync(join(fixture.walkDirectory, 'queue.lock')).ino).toBe(oldQueueInode);
    expect(statSync(join(fixture.walkDirectory, 'slot-1.lock')).ino).toBe(oldSlotInode);
    expect(statSync(join(fixture.walkDirectory, 'tickets/ticket-40')).ino).toBe(oldTicketInode);
    expect(readFileSync(join(fixture.walkDirectory, 'sequence'), 'utf8')).toBe('41');

    const recovery = recoverAsNobody(fixture.walkDirectory);
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(recovery.stdout).toBe('non-root acquired\n');
  });
} else {
  test.skip('provision repairs root-created walk admission state and admits a non-root caller', () => {});
}

test('a Debian host still installs missing packages with apt', () => {
  const fixture = scenario({ osRelease: 'ID=debian\nID_LIKE="debian"\n' });

  const result = fixture.run();

  expect(result.status, result.stderr).toBe(0);
  const events = fixture.events();
  const packages = ['git', 'rsync', 'unzip', 'xz-utils', 'curl', 'ca-certificates', 'util-linux'];
  expect(events.filter((event) => event.command === 'dpkg').map((event) => event.args)).toEqual(
    packages.map((name) => ['-s', name]),
  );
  expect(events.find((event) => event.command === 'apt-get')?.args).toEqual(['update', '-qq']);
  expect(events.find((event) => event.command === 'apt-get' && event.args[0] === 'install')?.args).toEqual([
    'install',
    '-y',
    '-qq',
    '--no-install-recommends',
    ...packages,
  ]);
  expect(events.find((event) => event.command === 'bun' && event.args[0] === 'x')?.args).toEqual([
    'x',
    'playwright@1.64.1',
    'install',
    '--with-deps',
    'chromium',
  ]);
  expect(events.find((event) => event.command === 'systemctl' && event.args[0] === 'reload')?.args).toEqual([
    'reload',
    'ssh.service',
  ]);
  expect(events.some((event) => event.command === 'dnf')).toBe(false);
});

test('loopback hosts without an exemption argument leave sshd unchanged through ssh word splitting', () => {
  for (const address of ['root@127.0.0.1', 'root@::1', 'root@localhost']) {
    const previous = 'Maintainer sshd settings\n';
    const fixture = scenario({ address, existingSshdConfig: previous });

    const result = fixture.run();

    expect(result.status, `${address}: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('provision: loopback host, sshd left unchanged');
    expect(readFileSync(fixture.sshdConfig, 'utf8')).toBe(previous);
    const events = fixture.events();
    expect(events.some((event) => event.command === 'sshd')).toBe(false);
    expect(events.some((event) => event.command === 'systemctl' && event.args[0] === 'reload')).toBe(false);
  }
});

test('a remote host keeps existing exemptions without an exemption argument through ssh word splitting', () => {
  const existing =
    'MaxStartups 10:30:100\nPerSourcePenaltyExemptList 192.0.2.0/24,2001:db8::/32\n# preserve nothing else\n';
  const fixture = scenario({
    osRelease: 'ID=debian\nID_LIKE="debian"\n',
    existingSshdConfig: existing,
  });
  const expected = 'MaxStartups 100:30:300\nMaxSessions 64\nPerSourcePenaltyExemptList 192.0.2.0/24,2001:db8::/32\n';

  const result = fixture.run();

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(fixture.sshdConfig, 'utf8')).toBe(expected);
  expect(fixture.events().find((event) => event.command === 'systemctl' && event.args[0] === 'reload')?.args).toEqual([
    'reload',
    'ssh.service',
  ]);
});

test('arguments with spaces and shell characters reach the remote script unchanged', () => {
  const sentinel = join(repository, `provision-shell-was-evaluated-${process.pid}`);
  const specialArgument = `space value; $(touch provision-shell-was-evaluated-${process.pid})`;
  const fixture = scenario({ playwrightVersion: specialArgument });

  const result = fixture.run();

  expect(result.status, result.stderr).toBe(0);
  expect(fixture.events().find((event) => event.command === 'bun' && event.args[0] === 'x')?.args).toEqual([
    'x',
    `playwright@${specialArgument}`,
    'install',
    'chromium',
  ]);
  expect(existsSync(sentinel)).toBe(false);
});

test('a Fedora host installs the Playwright browser without the apt dependency installer', () => {
  const fixture = scenario({ osRelease: 'ID=fedora\nID_LIKE="rhel fedora"\n' });

  const result = fixture.run();

  expect(result.status, result.stderr).toBe(0);
  const browserInstall = fixture.events().find((event) => event.command === 'bun' && event.args[0] === 'x');
  expect(browserInstall?.args).toEqual(['x', 'playwright@1.64.1', 'install', 'chromium']);
  expect(fixture.events().some((event) => event.command === 'apt-get')).toBe(false);
});

test('a rhel-like host uses dnf and an unsupported host reports its ID', () => {
  const rhel = scenario({ osRelease: 'ID=rocky\nID_LIKE="rhel centos fedora"\n' });
  const rhelResult = rhel.run();
  expect(rhelResult.status, rhelResult.stderr).toBe(0);
  expect(rhel.events().some((event) => event.command === 'dnf')).toBe(true);

  const unsupported = scenario({ osRelease: 'ID=alpine\nID_LIKE=""\n' });
  const unsupportedResult = unsupported.run();
  expect(unsupportedResult.status).toBe(1);
  expect(unsupportedResult.stderr).toContain("unsupported operating system ID 'alpine'");
  expect(unsupported.events()).toEqual([]);
});
