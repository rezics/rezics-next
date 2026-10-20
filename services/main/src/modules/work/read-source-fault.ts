import { WorkReadUnavailable } from './read-session.ts';

const sourceInvalid = Symbol('work-read-source-invalid');

/** Malformed retained inputs, rather than an unavailable owner or transport.
 * Public reads still refuse with 503; maintenance may quarantine the input only
 * after the enclosing read has closed its source and authority fences. */
export function invalidWorkReadSource(message: string) {
  return Object.assign(new WorkReadUnavailable(message), { [sourceInvalid]: true as const });
}

export function isWorkReadSourceInvalid(error: unknown): error is WorkReadUnavailable {
  return error instanceof WorkReadUnavailable && sourceInvalid in error;
}
