import { ProblemError, PROBLEMS } from '../http/problem-error.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
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

/** The sole boundary for trusted owning-module resource evidence callbacks.
 * A false denial form lets the enclosing boolean check deny the whole request.
 */
export async function accessEvidence<T>(
  callback: () => T | Promise<T>,
  denied: (() => Error) | false,
  deadline?: number,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throwEvidenceFailure(error);
    const denial = denied === false ? new Error('Access evidence denied') : denied();
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
    // Boolean checks deny the entire check in their enclosing catch. Do not
    // preserve this internal signal as a module denial or reduce it to a false
    // eligibility floor, which would leave the independent grant branch open.
    if (denied !== false) failures.add(denial);
    throw denial;
  }
}
