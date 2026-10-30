import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import {
  CHECK_COMPATIBILITY_CONTRACT,
  checkPinnedBunRuntime,
  checkScriptCompatibility,
  parseCompatibilityArgs,
} from './check-compatibility.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const realScriptPaths = [
  'scripts/worker-check.ts',
  'scripts/remote-check.ts',
  'scripts/check-ledger.ts',
  'scripts/stack-lease.ts',
  'scripts/check-memory.ts',
  'scripts/check-host/docker',
];

function temporaryDirectory(): string {
  const base = join(repositoryRoot, '.temp/goal');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'check-compatibility-test-'));
}

function devFile(path: string): string {
  const result = spawnSync('git', ['show', `dev:${path}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git show dev:${path} failed`);
  return result.stdout;
}

function scriptsRoot(
  directory: string,
  changed: Partial<Record<string, (source: string) => string>> = {},
  packageManager = (JSON.parse(devFile('package.json')) as { packageManager: string }).packageManager,
): string {
  const root = join(directory, 'scripts-root');
  for (const path of realScriptPaths) {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    let source = devFile(path);
    if (changed[path]) source = changed[path]!(source);
    writeFileSync(file, source);
  }
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'check-compatibility-fixture', private: true, packageManager }, null, 2)}\n`,
  );
  return root;
}

function reportCheck(report: ReturnType<typeof checkScriptCompatibility>, field: string) {
  return report.checks.filter((check) => check.field === field);
}

test('main consumer exercises actual dev worker-check forms, validates records and probes remote options', () => {
  const directory = temporaryDirectory();
  try {
    const root = scriptsRoot(directory);
    const args = parseCompatibilityArgs(['--scripts-root', root]);
    expect(args).toEqual({ scriptsRoot: root });

    const cli = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'tools/goal/scripts/check-compatibility.ts'), '--scripts-root', root],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const report = JSON.parse(cli.stdout) as ReturnType<typeof checkScriptCompatibility>;

    expect(CHECK_COMPATIBILITY_CONTRACT.contract).toBe('rezics.check-scripts');
    expect(CHECK_COMPATIBILITY_CONTRACT.version).toBe(1);
    expect(report.contractVersion).toBe(1);
    expect(report.scriptsRoot).toBe(root);
    expect(cli.status).toBe(1);
    expect(report.compatible).toBe(false);
    expect(reportCheck(report, 'workerCheck.bun.lookup').map((check) => check.status)).toEqual(['incompatible']);

    for (const field of [
      'workerCheck.script',
      'workerCheck.start',
      'workerCheck.record.running',
      'workerCheck.foreground',
      'workerCheck.failureStart',
      'workerCheck.failureForeground',
      'remoteCheck.script',
      'remoteCheck.options.--memory-gib',
      'remoteCheck.options.--returns',
    ]) {
      const checks = reportCheck(report, field);
      if (!checks.some((check) => check.status === 'compatible'))
        throw new Error(
          `Expected ${field} to be compatible; received ${JSON.stringify({ checks, records: report.checks.filter((check) => check.field.startsWith('workerCheck.record')) })}.`,
        );
    }

    const recordChecks = reportCheck(report, 'workerCheck.record.finished');
    expect(recordChecks).toHaveLength(2);
    expect(recordChecks.map((check) => (check.evidence?.record as { exitCode: number }).exitCode).sort()).toEqual([0, 7]);
    expect(reportCheck(report, 'workerCheck.start')[0]!.evidence?.idIsUuid).toBe(true);
    expect(reportCheck(report, 'workerCheck.foreground')[0]!.evidence?.exitCode).toBe(0);

    for (const option of ['--memory-gib', '--returns']) {
      const probe = reportCheck(report, `remoteCheck.options.${option}`)[0]!;
      expect(probe.evidence?.parseReachedHosts).toBe(true);
      expect(probe.evidence?.commandWasNotAdmitted).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pinned Bun version and revision probes execute against the manifest pin', () => {
  const directory = temporaryDirectory();
  try {
    const devPin = (JSON.parse(devFile('package.json')) as { packageManager: string }).packageManager;
    const good = checkPinnedBunRuntime(directory, `bun@${Bun.version}`, process.execPath);
    expect(good.map((check) => check.status)).toEqual(['compatible', 'compatible']);
    expect(good[0]!.evidence?.actual).toBe(Bun.version);
    expect(good[1]!.evidence?.actual).toBe(Bun.revision);

    const actualDevPin = checkPinnedBunRuntime(directory, devPin, process.execPath);
    expect(actualDevPin.find((check) => check.field === 'workerCheck.bun.version')?.status).toBe(
      devPin === `bun@${Bun.version}` ? 'compatible' : 'incompatible',
    );
    const mismatch = checkPinnedBunRuntime(directory, 'bun@0.0.0-incompatible', process.execPath);
    expect(mismatch.find((check) => check.field === 'workerCheck.bun.version')?.status).toBe('incompatible');
    expect(mismatch.find((check) => check.field === 'workerCheck.bun.revision')?.status).toBe('compatible');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('incompatible worker result fields and missing remote options identify the exact contract fields', () => {
  const directory = temporaryDirectory();
  try {
    const root = scriptsRoot(directory, {
      'scripts/worker-check.ts': (source) => {
        const incompatible = source.replaceAll('record.runnerHost = hostname();\n', '');
        if (incompatible === source) throw new Error('Could not construct the incompatible worker-check fixture.');
        return incompatible;
      },
      'scripts/remote-check.ts': (source) => {
        const incompatible = source.replace("if (flag === '--returns') {", "if (flag === '--returns-incompatible') {");
        if (incompatible === source) throw new Error('Could not construct the incompatible remote-check fixture.');
        return incompatible;
      },
    });

    const report = checkScriptCompatibility(root);
    expect(report.contractVersion).toBe(CHECK_COMPATIBILITY_CONTRACT.version);
    const runnerHost = reportCheck(report, 'workerCheck.record.runnerHost');
    if (!runnerHost.some((check) => check.status === 'incompatible'))
      throw new Error(`Expected workerCheck.record.runnerHost to be incompatible; received ${JSON.stringify(report.checks)}.`);
    const missingReturns = reportCheck(report, 'remoteCheck.options.--returns');
    if (!missingReturns.some((check) => check.status === 'incompatible'))
      throw new Error(`Expected remoteCheck.options.--returns to be incompatible; received ${JSON.stringify(missingReturns)}.`);
    expect(reportCheck(report, 'remoteCheck.options.--memory-gib').some((check) => check.status === 'compatible')).toBe(true);
    expect(report.incompatibilities.every((issue) => issue.field.length > 0 && issue.command.length > 0)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing worker-check and remote-check scripts are reported as incompatible commands', () => {
  const directory = temporaryDirectory();
  try {
    const missingWorkerRoot = scriptsRoot(join(directory, 'worker'));
    rmSync(join(missingWorkerRoot, 'scripts/worker-check.ts'));
    const missingWorker = checkScriptCompatibility(missingWorkerRoot);
    expect(reportCheck(missingWorker, 'workerCheck.script').map((check) => check.status)).toEqual(['incompatible']);
    expect(missingWorker.incompatibilities.find((issue) => issue.field === 'workerCheck.script')?.command).toContain(
      join(missingWorkerRoot, 'scripts/worker-check.ts'),
    );

    const missingRemoteRoot = scriptsRoot(join(directory, 'remote'));
    rmSync(join(missingRemoteRoot, 'scripts/remote-check.ts'));
    const missingRemote = checkScriptCompatibility(missingRemoteRoot);
    expect(reportCheck(missingRemote, 'remoteCheck.script').map((check) => check.status)).toEqual(['incompatible']);
    expect(missingRemote.incompatibilities.find((issue) => issue.field === 'remoteCheck.script')?.command).toContain(
      join(missingRemoteRoot, 'scripts/remote-check.ts'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { checkPinnedBunInstallation } from './check-compatibility.ts';

/** Provision authentic immutable npm artifacts, never a shim reporting a desired positive version. */
function pinnedArtifact(packageName: string, url: string, integrity: string): string {
  const cache = join(repositoryRoot, '.temp/check-compatibility-artifacts');
  const directory = join(cache, packageName);
  const archive = join(cache, `${packageName}.tgz`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(archive)) {
    const download = spawnSync(
      'curl',
      [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--connect-timeout',
        '20',
        '--max-time',
        '600',
        url,
        '-o',
        archive,
      ],
      {
        encoding: 'utf8',
        timeout: 610_000,
      },
    );
    if (download.status !== 0) throw new Error(download.stderr || `Artifact download failed: ${url}`);
  }
  expect(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`).toBe(integrity);
  if (!existsSync(join(directory, 'package/package.json'))) {
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(unpack.stderr || `Artifact extraction failed: ${archive}`);
  }
  return join(directory, 'package');
}

function completeScriptsRoot(directory: string) {
  const root = scriptsRoot(directory);
  // Preserve the actual dev manifest and lockfile, including canary label and lockfile integrity.
  writeFileSync(join(root, 'package.json'), devFile('package.json'));
  writeFileSync(join(root, 'bun.lock'), devFile('bun.lock'));
  const pin = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager: string })
    .packageManager;
  const artifact = CHECK_COMPATIBILITY_CONTRACT.workerCheck.bun.artifacts[pin];
  if (!artifact) throw new Error(`No trusted identity for actual dev pin ${pin}`);
  const platform = artifact.platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`No trusted platform artifact for ${process.platform}-${process.arch}`);
  const wrapper = pinnedArtifact('bun', artifact.packageTarball, artifact.packageIntegrity);
  const native = pinnedArtifact(`${process.platform}-${process.arch}`, platform.tarball, platform.integrity);
  const executable = join(native, platform.executable);
  expect(createHash('sha256').update(readFileSync(executable)).digest('hex')).toBe(platform.executableSha256);

  // Install private package links with the same executable and .bin lookup as the real npm package.
  // Physical package files live outside node_modules; no shared cache files are modified.
  const installation = join(directory, 'installation');
  mkdirSync(join(installation, '.bin'), { recursive: true });
  mkdirSync(join(installation, 'bun/bin'), { recursive: true });
  mkdirSync(join(installation, '@oven'), { recursive: true });
  writeFileSync(join(installation, 'bun/package.json'), readFileSync(join(wrapper, 'package.json')));
  symlinkSync(executable, join(installation, 'bun/bin/bun.exe'));
  symlinkSync(native, join(installation, platform.package), 'dir');
  const lookup = join(installation, '.bin/bun');
  symlinkSync('../bun/bin/bun.exe', lookup);
  symlinkSync(installation, join(root, 'node_modules'), 'dir');
  return { root, installation, lookup, executable, pin, artifact };
}

test('complete executable contract accepts actual dev scripts and genuine manifest-pinned Bun with real success and failure records', () => {
  const directory = temporaryDirectory();
  try {
    const { root, executable, pin, artifact } = completeScriptsRoot(directory);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(devFile('package.json'));
    expect(pin).toBe('bun@1.4.4-canary.20261027.1');
    const cli = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'tools/goal/scripts/check-compatibility.ts'), '--scripts-root', root],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (cli.status !== 0) throw new Error(`Contract CLI exit ${cli.status}: ${cli.stdout}\n${cli.stderr}`);
    const report = JSON.parse(cli.stdout) as ReturnType<typeof checkScriptCompatibility>;
    expect(cli.status).toBe(0);
    expect(report.compatible).toBe(true);
    expect(report.incompatibilities).toEqual([]);
    expect(report.checks.every((check) => check.status === 'compatible')).toBe(true);
    for (const field of [
      'workerCheck.bun.manifest',
      'workerCheck.bun.lookup',
      'workerCheck.bun.artifact',
      'workerCheck.bun.platform',
      'workerCheck.bun.lock',
      'workerCheck.bun.packages',
      'workerCheck.bun.executable',
      'workerCheck.bun.version',
      'workerCheck.bun.revision',
      'workerCheck.script',
      'workerCheck.start',
      'workerCheck.record.running',
      'workerCheck.foreground',
      'workerCheck.failureStart',
      'workerCheck.failureForeground',
      'remoteCheck.script',
      'remoteCheck.options.--memory-gib',
      'remoteCheck.options.--returns',
    ]) {
      expect(reportCheck(report, field).map((check) => check.status)).toEqual(['compatible']);
    }
    const finished = reportCheck(report, 'workerCheck.record.finished');
    expect(finished).toHaveLength(2);
    expect(finished.map((check) => (check.evidence?.record as { exitCode: number }).exitCode).sort()).toEqual([0, 7]);
    const childRuntime = reportCheck(report, 'workerCheck.bun.childRuntime');
    expect(childRuntime).toHaveLength(2);
    expect(childRuntime.map((check) => check.evidence?.exitCode).sort()).toEqual([0, 7]);
    for (const check of childRuntime) {
      expect(check.evidence?.version).toBe(artifact.runtimeVersion);
      expect(check.evidence?.revision).toBe(artifact.runtimeRevision);
      expect(realpathSync(String(check.evidence?.executable))).toBe(realpathSync(executable));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 1_300_000); // Two bounded artifact downloads on a cold cache, then the ordinary CLI deadline.

test('unchanged canary package label rejects wrong runtime version and wrong revision independently', () => {
  const directory = temporaryDirectory();
  try {
    const { root, lookup, executable, pin, artifact } = completeScriptsRoot(directory);
    const shim = join(directory, 'incompatible-runtime');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    rmSync(lookup);
    symlinkSync(shim, lookup);
    for (const [argument, wrongOutput, failedField, goodField] of [
      ['--version', '0.0.0-incompatible', 'workerCheck.bun.version', 'workerCheck.bun.revision'],
      ['--eval', '0000000000000000000000000000000000000000', 'workerCheck.bun.revision', 'workerCheck.bun.version'],
    ]) {
      writeFileSync(
        shim,
        `#!/bin/sh\nif [ "$1" = ${quote(argument!)} ]; then printf '%s\\n' ${quote(wrongOutput!)}; else exec ${quote(executable)} "$@"; fi\n`,
      );
      chmodSync(shim, 0o700);
      const checks = checkPinnedBunInstallation(root);
      expect(
        (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager: string }).packageManager,
      ).toBe(pin);
      expect(checks.find((check) => check.field === failedField)?.status).toBe('incompatible');
      expect(checks.find((check) => check.field === goodField)?.status).toBe('compatible');
      expect(checks.find((check) => check.field === 'workerCheck.bun.packages')?.status).toBe('compatible');
      expect(checks.find((check) => check.field === 'workerCheck.bun.executable')?.status).toBe('incompatible');
    }
    // Correct version and revision strings alone cannot establish artifact custody.
    writeFileSync(shim, `#!/bin/sh\nexec ${quote(executable)} "$@"\n`);
    const impersonator = checkPinnedBunInstallation(root);
    expect(impersonator.find((check) => check.field === 'workerCheck.bun.version')?.evidence?.actual).toBe(
      artifact.runtimeVersion,
    );
    expect(impersonator.find((check) => check.field === 'workerCheck.bun.revision')?.evidence?.actual).toBe(
      artifact.runtimeRevision,
    );
    expect(impersonator.find((check) => check.field === 'workerCheck.bun.executable')?.status).toBe('incompatible');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact custody fails closed for changed lock integrity, installed package identity and unknown pins', () => {
  const directory = temporaryDirectory();
  try {
    const { root, installation, pin, artifact } = completeScriptsRoot(directory);
    const originalLock = readFileSync(join(root, 'bun.lock'), 'utf8');
    expect(originalLock).toContain(artifact.packageIntegrity);
    writeFileSync(join(root, 'bun.lock'), originalLock.replace(artifact.packageIntegrity, 'sha512-incompatible'));
    const changedLock = checkPinnedBunInstallation(root);
    expect(changedLock.find((check) => check.field === 'workerCheck.bun.lock')?.status).toBe('incompatible');
    expect(changedLock.find((check) => check.field === 'workerCheck.bun.version')?.status).toBe('compatible');
    expect(changedLock.find((check) => check.field === 'workerCheck.bun.revision')?.status).toBe('compatible');
    writeFileSync(join(root, 'bun.lock'), originalLock);

    const installedManifest = join(installation, 'bun/package.json');
    const originalPackage = readFileSync(installedManifest, 'utf8');
    const changedPackage = JSON.parse(originalPackage) as { version: string };
    changedPackage.version = '0.0.0-incompatible';
    writeFileSync(installedManifest, JSON.stringify(changedPackage));
    expect(checkPinnedBunInstallation(root).find((check) => check.field === 'workerCheck.bun.packages')?.status).toBe(
      'incompatible',
    );
    writeFileSync(installedManifest, originalPackage);

    const manifest = readFileSync(join(root, 'package.json'), 'utf8');
    expect(manifest).toContain(pin);
    writeFileSync(join(root, 'package.json'), manifest.replace(pin, 'bun@0.0.0-unknown'));
    expect(checkPinnedBunInstallation(root).find((check) => check.field === 'workerCheck.bun.artifact')?.status).toBe(
      'incompatible',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
