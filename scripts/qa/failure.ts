/** Stable, additive result vocabulary shared by QA artifacts and recorded jobs. */
export const failureClasses = ['assertion', 'timeout', 'environment', 'harness'] as const;
export type FailureClass = typeof failureClasses[number];
export type JobResultClass = FailureClass | 'passed';

export function recordedFailure(output: string): FailureClass | undefined {
  return /^QA failure class: (assertion|timeout|environment|harness)\b/m.exec(output)?.[1] as FailureClass | undefined;
}

/** Explicit setup phases win over incidental diagnostics; a spent budget always means timeout. */
export function qaFailure(result: { timedOut?: boolean; output?: string },
  phase: 'test' | 'environment' | 'harness', testsFailed = false): FailureClass {
  if (result.timedOut) return 'timeout';
  if (phase !== 'test') return phase;
  if (/\b(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET)\b|missing prepared corpus|retained source.*(?:missing|unavailable)|preflight refus/i.test(result.output ?? '')) return 'environment';
  return testsFailed ? 'assertion' : 'harness';
}

/** Emit at the failure site so an interrupted run still gives its owning job a class. */
export function recordQaFailure(failureClass: FailureClass, message: string,
  print: (line: string) => void = console.error): string {
  print(`QA failure class: ${failureClass}`);
  return `${failureClass}: ${message}`;
}

interface FailedTestEvidence {
  failed: boolean; name: string; detail?: string; timeout?: boolean; preparationFailure?: boolean;
}

/** Use failing-case evidence, so an expected connection error in a passing case cannot change the cause. */
export function testFailureClass(result: { timedOut?: boolean; output?: string }, tests: readonly FailedTestEvidence[]): FailureClass {
  if (result.timedOut) return 'timeout';
  const failed = tests.filter(test => test.failed);
  if (failed.some(test => test.timeout)) return 'timeout';
  if (failed.some(test => test.preparationFailure)) return 'environment';
  const ran = failed.filter(test => test.name !== 'QA file did not complete');
  return qaFailure({ output: ran.length ? ran.map(test => test.detail ?? '').join('\n') : result.output }, 'test', ran.length > 0);
}
