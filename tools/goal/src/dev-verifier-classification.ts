import { firstFailure } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { isTransportTimeout } from './check-failure.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import type { DevVerifierEvidence, DevVerifierResult } from './types.ts';

export function infraFailure(output: string, timedOut: boolean): boolean {
  return timedOut || CHECK_HOST_TRANSPORT.test(output) || isTransportTimeout(output);
}

export function unavailableFailure(output: string): boolean {
  return (
    /(?:command|executable|script|module|package|dependency).{0,50}(?:not found|missing|cannot be found|not configured|unknown)|cannot find (?:module|package)|module not found|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|no such file or directory|ENOENT|permission denied|not recognized as an internal or external command/i.test(
      output,
    ) || /pinned Bun: absent installed (?:package|binary)/i.test(output)
  );
}

export function truncatedOutput(output: string): boolean {
  return /(?:output|log|result).{0,40}truncated|truncated.{0,40}(?:output|log|result)|\[TRUNCATED\]|<truncated>/i.test(
    output,
  );
}

export function assertionLines(output: string): string[] {
  const assertion = firstFailure(output).assertion;
  if (!assertion || assertion === 'Gate exited unsuccessfully') return [];
  return [
    ...new Set(
      assertion
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function stableAssertions(output: string, policy = defaultPolicy.verifier): string[] {
  return assertionLines(output).slice(0, policy.findingAssertions);
}

export function tooManyAssertions(output: string, policy = defaultPolicy.verifier): boolean {
  return assertionLines(output).length > policy.findingAssertions;
}

export function classifyRun(
  result: Pick<DevVerifierEvidence, 'passed' | 'timedOut' | 'output'>,
  policy = defaultPolicy.verifier,
): DevVerifierResult {
  if (result.passed) return 'pass';
  if (
    infraFailure(result.output, result.timedOut) ||
    unavailableFailure(result.output) ||
    truncatedOutput(result.output) ||
    tooManyAssertions(result.output, policy) ||
    !stableAssertions(result.output, policy).length
  )
    return 'infrastructure';
  return 'fail';
}
