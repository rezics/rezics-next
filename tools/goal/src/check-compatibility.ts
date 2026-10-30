import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = fileURLToPath(new URL('../contracts/check-scripts.json', import.meta.url));
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_LIMIT = 32 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;

type ContractOption = {
  flag: string;
  value: string;
  consumer: string;
  repeatable?: boolean;
};

export type CheckCompatibilityContract = {
  contract: string;
  version: number;
  workerCheck: {
    script: string;
    startArgv: string[];
    startOutput: string;
    foregroundArgv: string[];
    foregroundOutput: string[];
    resultPath: string;
    logPathPrefix: string;
    record: {
      identityFields: string[];
      sharedFields: string[];
      states: Record<string, { status: string; requiredFields: string[]; exitCode: string }>;
    };
    bun: {
      manifestField: string;
      versionPrefix: string;
      lookup: string;
      versionArgv: string[];
      revisionArgv: string[];
      versionMustMatchManifest: boolean;
    };
  };
  remoteCheck: {
    script: string;
    requiredEnvironment: Record<string, string>;
    optionalEnvironment: Record<string, string[]>;
    requiredOptions: ContractOption[];
    commandTail: string[];
  };
};

export type CompatibilityCheck = {
  field: string;
  status: 'compatible' | 'incompatible';
  command: string[];
  detail: string;
  evidence?: Record<string, unknown>;
};

export type CompatibilityReport = {
  contract: string;
  contractVersion: number;
  scriptsRoot: string;
  compatible: boolean;
  checks: CompatibilityCheck[];
  incompatibilities: Array<{ field: string; command: string[]; detail: string }>;
};

export const CHECK_COMPATIBILITY_CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as CheckCompatibilityContract;

type RunResult = {
  command: string[];
  cwd: string;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type WorkerRecord = Record<string, unknown>;

function commandExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): RunResult {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
  });
  return {
    command,
    cwd,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function displayResult(result: RunResult): Record<string, unknown> {
  return {
    cwd: result.cwd,
    exitCode: result.status,
    stdout: result.stdout.slice(0, OUTPUT_LIMIT),
    stderr: result.stderr.slice(0, OUTPUT_LIMIT),
    ...(result.error ? { error: result.error } : {}),
  };
}

function pushCheck(
  checks: CompatibilityCheck[],
  field: string,
  command: string[],
  ok: boolean,
  detail: string,
  evidence?: Record<string, unknown>,
): void {
  checks.push({ field, status: ok ? 'compatible' : 'incompatible', command, detail, ...(evidence ? { evidence } : {}) });
}

function runtimeCheck(
  scriptsRoot: string,
  expectedPin: string,
  executable: string,
  contract: CheckCompatibilityContract,
): CompatibilityCheck[] {
  const checks: CompatibilityCheck[] = [];
  const versionArgs = contract.workerCheck.bun.versionArgv;
  const revisionArgs = contract.workerCheck.bun.revisionArgv;
  const versionCommand = [executable, ...versionArgs];
  const revisionCommand = [executable, ...revisionArgs];
  const version = run(versionCommand, scriptsRoot);
  const actualVersion = version.stdout.trim();
  const pinShapeOk = expectedPin.startsWith(contract.workerCheck.bun.versionPrefix) &&
    expectedPin.slice(contract.workerCheck.bun.versionPrefix.length).length > 0;
  const expectedVersion = pinShapeOk ? expectedPin.slice(contract.workerCheck.bun.versionPrefix.length) : '';
  const versionOk = version.status === 0 && !version.error && (!contract.workerCheck.bun.versionMustMatchManifest || actualVersion === expectedVersion);
  pushCheck(
    checks,
    'workerCheck.bun.version',
    versionCommand,
    versionOk,
    versionOk
      ? `Pinned Bun ${actualVersion} matches ${contract.workerCheck.bun.manifestField}.`
      : !pinShapeOk
        ? `${contract.workerCheck.bun.manifestField} must start with ${contract.workerCheck.bun.versionPrefix} and include a version; received ${JSON.stringify(expectedPin)}.`
        : version.status !== 0 || version.error
          ? `Could not execute the pinned Bun version probe at ${executable}.`
          : `Pinned Bun reports ${JSON.stringify(actualVersion)} but ${contract.workerCheck.bun.manifestField} requires ${JSON.stringify(expectedVersion)}.`,
    { expected: expectedVersion || null, actual: actualVersion || null, ...displayResult(version) },
  );

  const revision = run(revisionCommand, scriptsRoot);
  const actualRevision = revision.stdout.trim();
  const revisionOk = revision.status === 0 && !revision.error && actualRevision.length > 0;
  pushCheck(
    checks,
    'workerCheck.bun.revision',
    revisionCommand,
    revisionOk,
    revisionOk ? `Pinned Bun revision probe returned ${actualRevision}.` : `Could not read Bun.revision from ${executable}.`,
    { actual: actualRevision || null, ...displayResult(revision) },
  );
  return checks;
}

/** Execute the package-manager pin checks used by compatibility reports. */
export function checkPinnedBunRuntime(
  scriptsRoot: string,
  expectedPin: string,
  executable: string,
  contract = CHECK_COMPATIBILITY_CONTRACT,
): CompatibilityCheck[] {
  if (!isAbsolute(executable)) executable = resolve(scriptsRoot, executable);
  return runtimeCheck(resolve(scriptsRoot), expectedPin, executable, contract);
}

function validateWorkerRecord(
  record: WorkerRecord,
  expected: { id: string; root: string; argv: string[]; state: 'running' | 'finished'; exitCode?: number },
  contract: CheckCompatibilityContract,
  checkLiveness: boolean,
): Array<{ field: string; detail: string }> {
  const errors: Array<{ field: string; detail: string }> = [];
  const states = contract.workerCheck.record.states;
  const state = expected.state === 'running' ? states.running : states.completed;
  const require = (field: string, condition: boolean, detail: string): void => {
    if (!condition) errors.push({ field: `workerCheck.record.${field}`, detail });
  };
  for (const field of state.requiredFields) {
    require(field, Object.hasOwn(record, field), `Record is missing required ${field} field.`);
  }
  require('id', record.id === expected.id && UUID.test(String(record.id)), 'Record id must be the UUID printed by the start form.');
  require('cwd', record.cwd === expected.root && isAbsolute(String(record.cwd)), 'Record cwd must identify the isolated worktree root.');
  require(
    'argv',
    Array.isArray(record.argv) && record.argv.every((part) => typeof part === 'string') && JSON.stringify(record.argv) === JSON.stringify(expected.argv),
    'Record argv must preserve the child command passed to worker-check.',
  );
  require('status', record.status === state.status, `Record state must be ${state.status}; received ${String(record.status)}.`);
  require(
    'runnerPid',
    Number.isSafeInteger(record.runnerPid) && Number(record.runnerPid) > 0,
    'Record runnerPid must be a positive safe integer.',
  );
  require('runnerHost', typeof record.runnerHost === 'string' && record.runnerHost.length > 0, 'Record runnerHost must be a non-empty string.');
  require(
    'log',
    typeof record.log === 'string' &&
      !isAbsolute(record.log) &&
      !record.log.split(/[\\/]/).includes('..') &&
      record.log.split(/[\\/]/).join('/').startsWith(contract.workerCheck.logPathPrefix),
    `Record log must be worktree-relative under ${contract.workerCheck.logPathPrefix}.`,
  );
  if (typeof record.log === 'string') {
    const logPath = resolve(expected.root, record.log);
    require('log', relative(expected.root, logPath) !== '..' && !relative(expected.root, logPath).startsWith(`..${sep}`) && existsSync(logPath), 'Record log must name an existing log inside the isolated worktree.');
  }

  if (expected.state === 'running') {
    require('exitCode', !Object.hasOwn(record, 'exitCode'), 'A running record must not claim a completed exit code.');
    if (
      checkLiveness &&
      record.runnerHost === hostname() &&
      Number.isSafeInteger(record.runnerPid) &&
      Number(record.runnerPid) > 0
    ) {
      let alive = true;
      try {
        process.kill(Number(record.runnerPid), 0);
      } catch {
        alive = false;
      }
      require('runnerPid', alive, 'The incomplete record must refer to a live local runner.');
    }
  } else {
    require('exitCode', Number.isSafeInteger(record.exitCode) && record.exitCode === expected.exitCode, `Completed record exitCode must be ${expected.exitCode}.`);
  }
  return errors;
}

function readWorkerRecord(root: string, id: string, contract: CheckCompatibilityContract): WorkerRecord | undefined {
  const resultPath = resolve(root, contract.workerCheck.resultPath.replace('<id>', id));
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8')) as WorkerRecord;
  } catch {
    return undefined;
  }
}

function writeChildCode(gatePath?: string, exitCode = 0): string {
  if (gatePath) {
    return [
      `const fs = await import('node:fs');`,
      `const gate = ${JSON.stringify(gatePath)};`,
      `while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);`,
      `process.exit(${exitCode});`,
    ].join('\n');
  }
  return `process.exit(${exitCode});`;
}

function commandResultCheck(
  checks: CompatibilityCheck[],
  field: string,
  command: string[],
  result: RunResult,
  ok: boolean,
  detail: string,
  evidence: Record<string, unknown> = {},
): void {
  pushCheck(checks, field, command, ok, detail, { ...displayResult(result), ...evidence });
}

function addRecordChecks(
  checks: CompatibilityCheck[],
  id: string,
  root: string,
  argv: string[],
  state: 'running' | 'finished',
  exitCode: number | undefined,
  command: string[],
  record: WorkerRecord | undefined,
  contract: CheckCompatibilityContract,
  checkLiveness: boolean,
): void {
  const resultPath = resolve(root, contract.workerCheck.resultPath.replace('<id>', id));
  if (!record) {
    pushCheck(checks, 'workerCheck.record', command, false, `No readable result record exists at ${resultPath}.`, { resultPath });
    return;
  }
  const errors = validateWorkerRecord(record, { id, root, argv, state, ...(exitCode === undefined ? {} : { exitCode }) }, contract, checkLiveness);
  if (!errors.length) {
    pushCheck(checks, `workerCheck.record.${state}`, command, true, `The ${state} result record satisfies the consumer contract.`, {
      resultPath,
      record,
    });
    return;
  }
  for (const error of errors) pushCheck(checks, error.field, command, false, error.detail, { resultPath, record });
}

function startWorkerCheck(
  checks: CompatibilityCheck[],
  workerScript: string,
  scratchRoot: string,
  exitCode: number,
  contract: CheckCompatibilityContract,
  waitForRelease: boolean,
): { id?: string; childArgv: string[]; recordArgv: string[]; gatePath?: string } {
  const gatePath = waitForRelease ? join(scratchRoot, 'release-child') : undefined;
  if (gatePath) rmSync(gatePath, { force: true });
  const code = writeChildCode(gatePath, exitCode);
  const childArgv = [process.execPath, '-e', code];
  const startArgs = [...contract.workerCheck.startArgv.slice(0, -1), '--local', ...childArgv];
  const command = [process.execPath, workerScript, ...startArgs];
  const env = {
    ...process.env,
    REZICS_CHECK_MEMORY: 'off',
    REZICS_CHECK_MEMORY_GIB: '1',
    REZICS_CHECK_MEMORY_DIR: join(scratchRoot, 'memory'),
    REZICS_CHECK_SCOPE: 'off',
    REZICS_STACK_LEASE: 'off',
    REZICS_STACK_LEASE_DIR: join(scratchRoot, 'stack-lease'),
    TMPDIR: scratchRoot,
  };
  delete env.KERNEL_CHECK_REMOTE;
  delete env.REMOTE_CHECK_PRIORITY;
  delete env.GOAL_CHECK_WAIT_FILE;
  delete env.GOAL_TASK_ID;
  const result = run(command, scratchRoot, env);
  const ids = [...result.stdout.matchAll(/^check: id ([0-9a-f-]{36})$/gm)].map((match) => match[1]!);
  const id = ids[0];
  const validId = ids.length === 1 && UUID.test(id ?? '');
  commandResultCheck(
    checks,
    waitForRelease ? 'workerCheck.start' : 'workerCheck.failureStart',
    command,
    result,
    result.status === 0 && validId,
    result.status === 0 && validId
      ? 'The actual worker-check start form returned a UUID.'
      : `Expected a successful start command to print a UUID; received exit ${String(result.status)}.`,
    { id: id ?? null, idIsUuid: validId },
  );
  return { ...(validId ? { id } : {}), childArgv, recordArgv: ['--local', ...childArgv], ...(gatePath ? { gatePath } : {}) };
}

function checkWorkerCheckLifecycle(
  checks: CompatibilityCheck[],
  scriptsRoot: string,
  scratchRoot: string,
  contract: CheckCompatibilityContract,
): void {
  const workerScript = resolve(scriptsRoot, contract.workerCheck.script);
  if (!commandExists(workerScript)) {
    pushCheck(checks, 'workerCheck.script', [process.execPath, workerScript], false, `Required script is missing: ${workerScript}.`);
    return;
  }
  pushCheck(checks, 'workerCheck.script', [process.execPath, workerScript], true, 'Required worker-check script exists.');

  const pending = startWorkerCheck(checks, workerScript, scratchRoot, 0, contract, true);
  if (!pending.id) {
    if (pending.gatePath) writeFileSync(pending.gatePath, 'release after malformed start output\n');
    return;
  }
  const running = readWorkerRecord(scratchRoot, pending.id, contract);
  const startCommand = [
    process.execPath,
    workerScript,
    ...contract.workerCheck.startArgv.slice(0, -1),
    '--local',
    ...pending.childArgv,
  ];
  addRecordChecks(checks, pending.id, scratchRoot, pending.recordArgv, 'running', undefined, startCommand, running, contract, true);
  const gatePath = pending.gatePath!;
  writeFileSync(gatePath, 'continue\n');
  const waitArgs = contract.workerCheck.foregroundArgv.map((part) => part === '<id>' ? pending.id! : part);
  const waitCommand = [process.execPath, workerScript, ...waitArgs];
  const pendingWait = run(waitCommand, scratchRoot, process.env);
  const pendingRecord = readWorkerRecord(scratchRoot, pending.id, contract);
  const pendingLog = pendingWait.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('check: log '))
    ?.slice('check: log '.length);
  const pendingWaitOk =
    pendingWait.status === 0 &&
    pendingWait.stdout.split(/\r?\n/).includes('check: exit status 0') &&
    pendingLog?.replaceAll('\\', '/').startsWith(contract.workerCheck.logPathPrefix) === true;
  commandResultCheck(
    checks,
    'workerCheck.foreground',
    waitCommand,
    pendingWait,
    pendingWaitOk,
    pendingWaitOk ? 'The foreground wait form completed the still-running check successfully.' : 'The foreground wait form did not report the successful result and log path.',
    { id: pending.id },
  );
  addRecordChecks(checks, pending.id, scratchRoot, pending.recordArgv, 'finished', 0, waitCommand, pendingRecord, contract, false);

  const failure = startWorkerCheck(checks, workerScript, scratchRoot, 7, contract, false);
  if (!failure.id) return;
  const failureWaitArgs = contract.workerCheck.foregroundArgv.map((part) => part === '<id>' ? failure.id! : part);
  const failureWaitCommand = [process.execPath, workerScript, ...failureWaitArgs];
  const failureWait = run(failureWaitCommand, scratchRoot, process.env);
  const failureRecord = readWorkerRecord(scratchRoot, failure.id, contract);
  const failureLog = failureWait.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('check: log '))
    ?.slice('check: log '.length);
  const failureWaitOk =
    failureWait.status === 7 &&
    failureWait.stdout.split(/\r?\n/).includes('check: exit status 7') &&
    failureLog?.replaceAll('\\', '/').startsWith(contract.workerCheck.logPathPrefix) === true;
  commandResultCheck(
    checks,
    'workerCheck.failureForeground',
    failureWaitCommand,
    failureWait,
    failureWaitOk,
    failureWaitOk ? 'The foreground wait form preserved a failing child exit status.' : 'The foreground wait form did not report the failing result and log path.',
    { id: failure.id },
  );
  addRecordChecks(checks, failure.id, scratchRoot, failure.recordArgv, 'finished', 7, failureWaitCommand, failureRecord, contract, false);
}

function parsePackageManager(scriptsRoot: string, checks: CompatibilityCheck[], contract: CheckCompatibilityContract): string | undefined {
  const manifestPath = join(scriptsRoot, 'package.json');
  const command = ['read', manifestPath, contract.workerCheck.bun.manifestField];
  if (!commandExists(manifestPath)) {
    pushCheck(checks, 'workerCheck.bun.manifest', command, false, `Required package manifest is missing: ${manifestPath}.`);
    return undefined;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packageManager?: unknown };
    if (typeof manifest.packageManager !== 'string') {
      pushCheck(checks, 'workerCheck.bun.manifest', command, false, `${contract.workerCheck.bun.manifestField} must pin Bun.`);
      return undefined;
    }
    const pin = manifest.packageManager;
    const valid = pin.startsWith(contract.workerCheck.bun.versionPrefix) && pin.slice(contract.workerCheck.bun.versionPrefix.length).length > 0;
    pushCheck(checks, 'workerCheck.bun.manifest', command, valid, valid ? `${contract.workerCheck.bun.manifestField} pins ${pin}.` : `${contract.workerCheck.bun.manifestField} must start with ${contract.workerCheck.bun.versionPrefix}; received ${JSON.stringify(pin)}.`, { packageManager: pin });
    return pin;
  } catch (error) {
    pushCheck(checks, 'workerCheck.bun.manifest', command, false, `Could not read ${manifestPath}: ${String(error)}.`);
    return undefined;
  }
}

function checkBunPin(
  checks: CompatibilityCheck[],
  scriptsRoot: string,
  contract: CheckCompatibilityContract,
): void {
  const pin = parsePackageManager(scriptsRoot, checks, contract);
  const lookup = resolve(scriptsRoot, contract.workerCheck.bun.lookup);
  if (!commandExists(lookup)) {
    pushCheck(
      checks,
      'workerCheck.bun.lookup',
      [lookup, ...contract.workerCheck.bun.versionArgv],
      false,
      `Pinned Bun executable is missing at the required lookup path ${lookup}.`,
      { lookup },
    );
    return;
  }
  if (pin === undefined) return;
  for (const check of runtimeCheck(scriptsRoot, pin, lookup, contract)) checks.push(check);
  pushCheck(checks, 'workerCheck.bun.lookup', [lookup, ...contract.workerCheck.bun.versionArgv], true, `Pinned Bun was found at ${lookup}.`, { lookup });
}

function optionArgs(option: ContractOption): string[] {
  const value = option.flag === '--memory-gib' ? '1' : option.flag === '--returns' ? 'compatibility-return.txt' : 'value';
  return [option.flag, value, ...(option.repeatable ? [option.flag, 'second-return.txt'] : [])];
}

function checkRemoteOptions(
  checks: CompatibilityCheck[],
  scriptsRoot: string,
  scratchRoot: string,
  contract: CheckCompatibilityContract,
): void {
  const remoteScript = resolve(scriptsRoot, contract.remoteCheck.script);
  if (!commandExists(remoteScript)) {
    pushCheck(checks, 'remoteCheck.script', [process.execPath, remoteScript], false, `Required script is missing: ${remoteScript}.`);
    return;
  }
  pushCheck(checks, 'remoteCheck.script', [process.execPath, remoteScript], true, 'Required remote-check script exists.');

  const hostsPath = join(scratchRoot, 'empty-hosts.json');
  const workspace = join(scratchRoot, 'remote-workspace');
  const marker = join(scratchRoot, 'remote-command-ran');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(hostsPath, JSON.stringify({ hosts: [] }));
  for (const option of contract.remoteCheck.requiredOptions) {
    const args = [
      ...optionArgs(option),
      workspace,
      '--',
      process.execPath,
      '-e',
      `await import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'))`,
    ];
    const command = [process.execPath, remoteScript, ...args];
    const env = { ...process.env, KERNEL_CHECK_REMOTE: hostsPath, REMOTE_CHECK_PRIORITY: 'landing' };
    const result = run(command, scratchRoot, env);
    const parseReachedHosts = result.status !== 0 && !result.error && result.stderr.includes('lists no hosts');
    const notAdmitted = !existsSync(marker);
    const ok = parseReachedHosts && notAdmitted;
    commandResultCheck(
      checks,
      `remoteCheck.options.${option.flag}`,
      command,
      result,
      ok,
      ok
        ? `${option.flag} parsed successfully; the empty-host fixture stopped before check-host admission.`
        : `${option.flag} did not reach the empty-host boundary without admitting a command.`,
      { environment: contract.remoteCheck.requiredEnvironment, parseReachedHosts, commandWasNotAdmitted: notAdmitted },
    );
    rmSync(marker, { force: true });
  }
}

function report(scriptsRoot: string, checks: CompatibilityCheck[], contract: CheckCompatibilityContract): CompatibilityReport {
  const incompatibilities = checks
    .filter((check) => check.status === 'incompatible')
    .map(({ field, command, detail }) => ({ field, command, detail }));
  return {
    contract: contract.contract,
    contractVersion: contract.version,
    scriptsRoot,
    compatible: incompatibilities.length === 0,
    checks,
    incompatibilities,
  };
}

/** Check a scripts checkout using real worker-check and remote-check child processes. */
export function checkScriptCompatibility(scriptsRoot: string): CompatibilityReport {
  const root = resolve(scriptsRoot);
  const checks: CompatibilityCheck[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    pushCheck(checks, 'scriptsRoot', ['inspect', root], false, `Scripts root is not a directory: ${root}.`);
    return report(root, checks, CHECK_COMPATIBILITY_CONTRACT);
  }

  const temporaryBase = join(REPOSITORY_ROOT, '.temp', 'goal');
  mkdirSync(temporaryBase, { recursive: true });
  const scratchRoot = mkdtempSync(join(temporaryBase, 'check-compatibility-'));
  try {
    checkBunPin(checks, root, CHECK_COMPATIBILITY_CONTRACT);
    checkWorkerCheckLifecycle(checks, root, scratchRoot, CHECK_COMPATIBILITY_CONTRACT);
    checkRemoteOptions(checks, root, scratchRoot, CHECK_COMPATIBILITY_CONTRACT);
  } catch (error) {
    pushCheck(checks, 'compatibility.checker', ['bun', 'tools/goal/scripts/check-compatibility.ts', '--scripts-root', root], false, String(error));
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  return report(root, checks, CHECK_COMPATIBILITY_CONTRACT);
}

export function compatibilityUsageError(args: string[]): CompatibilityReport {
  return report(
    '',
    [
      {
        field: 'arguments.scriptsRoot',
        status: 'incompatible',
        command: ['bun', 'tools/goal/scripts/check-compatibility.ts', '--scripts-root', '<checkout>'],
        detail: `Expected exactly --scripts-root <checkout>; received ${JSON.stringify(args)}.`,
      },
    ],
    CHECK_COMPATIBILITY_CONTRACT,
  );
}

export function parseCompatibilityArgs(args: string[]): { scriptsRoot: string } | undefined {
  if (args.length !== 2 || args[0] !== '--scripts-root' || !args[1]) return undefined;
  return { scriptsRoot: resolve(args[1]) };
}
