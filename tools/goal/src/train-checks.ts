import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gateRunner, processGroupRunner, type GateResult, type GateRunner } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import type { AffectedTestResult } from './types.ts';

/** Kernel summaries, FAIL lines and heading-scoped (fail) name files; passing headings, Bun's repeated summary and stack frames do not. */
export function failingTestFiles(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const files = new Set<string>();
  const add = (file: string) => files.add(file.replace(/^\.\//, ''));
  let summarized = false;
  for (const summary of clean.matchAll(/tests failed for (\d+) file\(s\):\r?\n([^]*?)(?=\n\s*at |$)/gi)) {
    summarized = true;
    files.clear(); // The final summary excludes files that passed the check's own rerun.
    for (const line of summary[2]!.split(/\r?\n/).slice(0, Number(summary[1]))) {
      const file = line.trim();
      if (file) add(file);
    }
  }
  if (summarized) return [...files].sort();
  for (const match of clean.matchAll(
    /^\s*(?:FAIL\s+([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)|([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?):[^\n]*(?:fail|error))/gim,
  ))
    add((match[1] ?? match[2])!);
  let currentFile: string | undefined;
  for (const line of clean.split(/\r?\n/)) {
    const heading = line.match(/^([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/);
    if (heading) currentFile = heading[1];
    else if (/^\d+ tests? failed:/.test(line.trim())) currentFile = undefined;
    else if (currentFile && /^\s*\(fail\)/.test(line)) add(currentFile);
  }
  return [...files].sort();
}

export function checkTransportFailed(output: string): boolean {
  return (
    CHECK_HOST_TRANSPORT.test(output) ||
    /remote-check: (?:connection to .+ failed during .+ before a result|no check host answered)/.test(output)
  );
}

function checkEnvironmentFailed(output: string): boolean {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  return /^kernel check: environment failure: database storage full \(SQLSTATE 53100\)(?: on .*)?$/m.test(clean);
}

/** A rejected owned command cannot release its siblings' worktree or leases early. */
export async function settleOwnedCommands<T>(commands: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(commands);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** No wall timeout: a check waiting for a shared host slot is still queued. */
export async function runAffectedTest(
  command: readonly string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
  options?: { signal: AbortSignal },
  policy = defaultPolicy,
): Promise<AffectedTestResult> {
  const started = Date.now();
  let output = '';
  let passed = false;
  let transportUnverified = false;
  let environmentUnverified = false;
  for (let retry = 0; retry < policy.integration.affectedTransportAttempts; retry++) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const result = await processGroupRunner(
      undefined,
      undefined,
      env,
      false,
      policy.merge,
    )(command, cwd, logPath, options);
    output = result.output;
    passed = result.passed;
    environmentUnverified = checkEnvironmentFailed(output);
    transportUnverified = !passed && checkTransportFailed(output);
    if (!transportUnverified) break;
    if (retry + 1 < policy.integration.affectedTransportAttempts)
      appendFileSync(
        logPath,
        policy.integration.affectedTransportAttempts === 2
          ? 'Check-host transport failed; retrying once\n'
          : 'Check-host transport failed; retrying on the same source\n',
      );
  }
  const selectionUnverified = /^Affected mode: unverified, 0 of \d+ test files selected \(.+\)$/m.test(output);
  const unverified = transportUnverified || environmentUnverified || (passed && selectionUnverified);
  const status = unverified ? 'unverified' : passed ? 'passed' : 'failed';
  const durationMs = Date.now() - started;
  appendFileSync(logPath, `Affected test: ${status} in ${durationMs} ms\n`);
  return {
    command: [...command],
    status,
    failingFiles: passed || unverified ? [] : failingTestFiles(output),
    durationMs,
    output,
  };
}

export async function runIntegrationChecks(
  commands: readonly (readonly string[])[],
  cwd: string,
  logPath: string,
  execute: GateRunner = gateRunner(defaultPolicy.integration.checkTimeoutMs),
): Promise<GateResult & { failedCommand?: readonly string[] }> {
  // Web's recorded-response check regenerates the web client first, which takes about two minutes on a loaded host.
  let output = '';
  let passed = true,
    timedOut = false;
  let failedCommand: readonly string[] | undefined;
  const record = (command: readonly string[], result: GateResult, started: number) => {
    output += result.output;
    if (!result.passed && !failedCommand) failedCommand = [...command];
    passed &&= result.passed;
    timedOut ||= result.timedOut;
    appendFileSync(
      logPath,
      `(${command.join(' ')}: ${result.passed ? 'passed' : 'failed'} in ${Math.round((Date.now() - started) / 1000)} s)\n`,
    );
  };
  // Every check runs: a later check may be the only one that exercises its own errors. Installing
  // dependencies changes the tree the others read, so it runs first and alone; the remaining checks only read the tree
  // and run at once, each into its own log section, which keeps the landing as long as its slowest check.
  // A check that installs or generates writes the tree, so those run one at a time, before and after the read-only
  // group.
  const writes = (command: readonly string[]) => / install\b|\bgenerate\b/.test(` ${command.join(' ')}`);
  const install = commands.filter((command) => command[0] === 'bun' && command[1] === 'install');
  const rest = commands.filter((command) => !install.includes(command) && !writes(command));
  const after = commands.filter((command) => !install.includes(command) && writes(command));
  for (const command of install) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const started = Date.now();
    record(command, await execute(command, cwd, logPath), started);
  }
  const parallel = await Promise.allSettled(
    rest.map(async (command, index) => {
      const own = `${logPath}.check-${index}`;
      writeFileSync(own, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
      const started = Date.now();
      const result = await execute(command, cwd, own);
      return { command, result, started, own };
    }),
  );
  for (const settled of parallel) {
    // Rejected commands keep their exact section log. Every sibling has settled before custody can be released.
    if (settled.status === 'rejected') continue;
    const { command, result, started, own } = settled.value;
    appendFileSync(logPath, readFileSync(own, 'utf8'));
    rmSync(own, { force: true });
    record(command, result, started);
  }
  const rejected = parallel.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  for (const command of after) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const started = Date.now();
    record(command, await execute(command, cwd, logPath), started);
  }
  return { passed, output, timedOut, ...(failedCommand ? { failedCommand } : {}) };
}
