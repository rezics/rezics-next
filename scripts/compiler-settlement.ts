import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import type { RemoteCheckSettlement } from './remote-check.ts';

/** Metadata from the existing physical custodian; stdout never establishes remote cleanup. */
export type CompilerSettlement = {
  version: 1;
  invocation: string;
  settlement: RemoteCheckSettlement;
};

export function compilerSettlementReceiver(
  env: NodeJS.ProcessEnv,
): ((value: RemoteCheckSettlement) => void) | undefined {
  const file = env.REZICS_COMPILER_SETTLEMENT_FILE;
  const invocation = env.REZICS_COMPILER_SETTLEMENT_ID;
  if (!file || !invocation) return undefined;
  return (settlement) => {
    const value: CompilerSettlement = { version: 1, invocation, settlement };
    writeFileSync(`${file}.pending`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${file}.pending`, file);
  };
}

export function readCompilerSettlement(file: string, invocation: string): CompilerSettlement | undefined {
  let raw: string;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
      throw new Error('Invalid compiler settlement file');
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as CompilerSettlement;
  const run = value.settlement;
  if (
    value.version !== 1 ||
    value.invocation !== invocation ||
    run?.schema !== 1 ||
    typeof run.host !== 'string' ||
    typeof run.run !== 'string' ||
    run.cleanup?.schema !== 1 ||
    run.cleanup.host !== run.host ||
    run.cleanup.run !== run.run ||
    !['verified', 'unknown'].includes(run.cleanup.status) ||
    !Array.isArray(run.cleanup.failures) ||
    !run.cleanup.failures.every((item) => typeof item === 'string') ||
    typeof run.transportChildReaped !== 'boolean' ||
    (run.native !== null &&
      (run.native?.schema !== 1 ||
        run.native.host !== run.host ||
        run.native.run !== run.run ||
        !Number.isInteger(run.native.exitCode)))
  )
    throw new Error('Invalid compiler settlement identity');
  return value;
}

export function compilerSettlementFailure(value: CompilerSettlement): string | undefined {
  const run = value.settlement;
  const cleanup = run.cleanup;
  const resources = run.native?.resources;
  if (
    resources?.schema !== 1 ||
    resources.host !== run.host ||
    resources.run !== run.run ||
    typeof resources.boot !== 'string' ||
    !Number.isSafeInteger(resources.supervisor?.pid) ||
    !Number.isSafeInteger(resources.supervisor?.group) ||
    !/^\d+$/.test(resources.supervisor?.start ?? '') ||
    !run.native ||
    !run.transportChildReaped ||
    cleanup.status !== 'verified' ||
    cleanup.supervisorStopped !== true ||
    cleanup.commandGroupTerminal !== true ||
    cleanup.containersRemoved !== true ||
    cleanup.runDirectoryRemoved !== true ||
    cleanup.failures.length
  )
    return `Compiler database cleanup could not be proven on ${run.host} run ${run.run}: ${cleanup.failures.join('; ') || 'physical settlement incomplete'}; original command exit ${run.native?.exitCode ?? 'unknown'}`;
  return undefined;
}
