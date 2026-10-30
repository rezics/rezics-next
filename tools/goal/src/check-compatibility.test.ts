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
        throw new Error(`Expected ${field} to be compatible; received ${JSON.stringify(checks)}.`);
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
