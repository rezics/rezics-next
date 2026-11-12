import { firstFailure } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { isTransportTimeout } from './check-failure.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import {
  extractVerifierDiagnostics,
  extractTestFileOutcomes,
  isAuthDatabasePlacementFailure,
  isPrecommandRemoteTransport,
  isCleanupFailureLine,
  isCompilerDiagnosticLine,
  isRsyncTelemetry,
} from './dev-verifier-diagnostics.ts';
import type { DevVerifierCause, DevVerifierEvidence, DevVerifierResult } from './types.ts';

export function infraFailure(output: string, timedOut: boolean): boolean {
  return (
    timedOut ||
    CHECK_HOST_TRANSPORT.test(output) ||
    isTransportTimeout(output) ||
    isPrecommandRemoteTransport(output) ||
    /remote-check: no check host answered/i.test(output)
  );
}

export function unavailableFailure(output: string): boolean {
  return (
    /(?:Web|Focused) check unavailable:|Web host selection was not discovered:|Web test selector must resolve inside apps\/web:/i.test(
      output,
    ) ||
    /(?:generate|route generation|dependency optimization) failed with status \d+/i.test(output) ||
    /(?:command|executable|script|module|package|dependency).{0,50}(?:not found|missing|cannot be found|not configured|unknown)|cannot find (?:module|package)|module not found|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|no such file or directory|ENOENT|permission denied|not recognized as an internal or external command/i.test(
      output,
    ) ||
    /pinned Bun: absent installed (?:package|binary)/i.test(output)
  );
}

export function truncatedOutput(output: string): boolean {
  return /(?:output|log|result).{0,40}truncated|truncated.{0,40}(?:output|log|result)|\[TRUNCATED\]|<truncated>/i.test(
    output,
  );
}

function ignoredAssertionLine(line: string): boolean {
  return (
    !line.trim() ||
    isRsyncTelemetry(line) ||
    isAuthDatabasePlacementFailure(line) ||
    CHECK_HOST_TRANSPORT.test(line) ||
    isTransportTimeout(line) ||
    isPrecommandRemoteTransport(line) ||
    /\b(?:unhandled error between tests|unhandled errors?|uncaught exception)\b/i.test(line) ||
    /\berror\s+TS\d+\s*:/i.test(line) ||
    isCompilerDiagnosticLine(line) ||
    isCleanupFailureLine(line)
  );
}

export function assertionLines(output: string): string[] {
  const finalAttempt = [...output.matchAll(/^--- verifier attempt \d+ \(final\) ---\n/gmu)].at(-1);
  const evidence = finalAttempt ? output.slice(finalAttempt.index + finalAttempt[0].length) : output;
  const assertion = firstFailure(evidence).assertion;
  if (!assertion || assertion === 'Gate exited unsuccessfully') return [];
  return [
    ...new Set(
      assertion
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !ignoredAssertionLine(line)),
    ),
  ];
}

export function stableAssertions(output: string, policy = defaultPolicy.verifier): string[] {
  return assertionLines(output).slice(0, policy.findingAssertions);
}

export function fileFailureAssertions(output: string, policy = defaultPolicy.verifier): string[] {
  return stableAssertions(output, policy).filter(
    (line) =>
      !isAuthDatabasePlacementFailure(line) &&
      !/^\((?:pass|fail)\)\s/i.test(line) &&
      !/^(?:FAIL|PASS)\s+<path>(?::\d+(?::\d+)?)?$/i.test(line) &&
      !/^<path>\s*:?$/i.test(line),
  );
}

export function tooManyAssertions(output: string, policy = defaultPolicy.verifier): boolean {
  return assertionLines(output).length > policy.findingAssertions;
}

export function verifierCauses(
  result: Pick<DevVerifierEvidence, 'timedOut' | 'output'>,
  policy = defaultPolicy.verifier,
): DevVerifierCause[] {
  const causes = new Set(extractVerifierDiagnostics(result).map(({ cause }) => cause));
  if (fileFailureAssertions(result.output, policy).length) causes.add('product-runtime');
  return [...causes];
}

export function classifyRun(
  result: Pick<DevVerifierEvidence, 'passed' | 'timedOut' | 'output'> &
    Partial<Pick<DevVerifierEvidence, 'result' | 'command' | 'cwd'>>,
  policy = defaultPolicy.verifier,
): DevVerifierResult {
  if (result.result === 'skipped' || result.result === 'unknown') return result.result;
  if (result.passed || result.result === 'pass') return 'pass';

  // A real compiler diagnostic is paid stage evidence even when later resource cleanup failed.
  if (extractVerifierDiagnostics(result).some(({ cause }) => cause === 'compiler')) return 'fail';
  const fileFailure = extractTestFileOutcomes(
    { command: result.command ?? [], ...(result.cwd ? { cwd: result.cwd } : {}) },
    { output: result.output },
    { ...(result.cwd ? { workspace: result.cwd } : {}) },
  ).outcomes.some(
    ({ result: fileResult, failureOutputs }) =>
      fileResult === 'fail' &&
      failureOutputs.some(
        (output) => !isAuthDatabasePlacementFailure(output) && fileFailureAssertions(output, policy).length > 0,
      ),
  );
  const setupFailure = extractVerifierDiagnostics(result).some(({ cause }) => cause === 'setup');
  if (
    infraFailure(result.output, result.timedOut) ||
    unavailableFailure(result.output) ||
    truncatedOutput(result.output) ||
    (setupFailure && !fileFailure) ||
    (tooManyAssertions(result.output, policy) && !fileFailure) ||
    (!stableAssertions(result.output, policy).length && !fileFailure)
  )
    return 'infrastructure';
  if (fileFailure) return 'fail';
  if (result.result === 'infrastructure') return 'infrastructure';
  if (result.result === 'fail') return 'fail';
  return 'fail';
}
