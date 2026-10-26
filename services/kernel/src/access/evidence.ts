import { ProblemError, PROBLEMS } from '../http/problem.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { throwAccessUnavailable } from './unavailable.ts';

// Existing owning-module denial contracts have no common base class. Keep their
// closed set of names here instead of importing domains into Access.
const moduleDenials = new Set([
  'ContentNotFoundError',
  'ContentForbiddenError',
  'RevisionPreconditionError',
  'ReportUnavailableError',
]);
const failures = new WeakSet<Error>();

/** Preserve a callback's denial across Access's enclosing fail-closed catches. */
export function throwEvidenceFailure(error: unknown): void {
  if (error instanceof Error && failures.has(error)) throw error;
}

/** The sole boundary for trusted owning-module resource evidence callbacks. */
export async function accessEvidence<T>(
  callback: () => T | Promise<T>,
  denied: () => Error,
  deadline?: number,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throwEvidenceFailure(error);
    const denial = denied();
    if (
      error instanceof Error &&
      (error instanceof GrantDeniedError ||
        (denial.constructor !== Error && error.constructor === denial.constructor) ||
        moduleDenials.has(error.name) ||
        (error instanceof ProblemError && PROBLEMS[error.code].status < 500))
    ) {
      failures.add(error);
      throw error;
    }
    // The kernel logger retains the cause; responses receive only the denial.
    console.error(new Error('Access evidence callback failed', { cause: error }));
    failures.add(denial);
    throw denial;
  }
}
