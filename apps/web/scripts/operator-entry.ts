import { hasWebCheckCustody } from './check-placement.ts';

/** An explicit local operator entry never changes admission for finite worker commands. */
export function operatorEntry(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  inCheck: () => boolean = hasWebCheckCustody,
): { operator: boolean; args: string[] } {
  const operator = argv.includes('--operator');
  if (operator && (env.GOAL_TASK_ID || env.REZICS_TEST_RUNTIME === '1' || inCheck())) {
    throw new Error('--operator is available only outside worker checks and test runtime.');
  }
  return { operator, args: argv.filter((arg) => arg !== '--operator') };
}
