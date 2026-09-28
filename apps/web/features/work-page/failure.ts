import type { ReadFailure } from './types.ts';

/** Why Main could not answer a Work page read, from its status; shared by server reads and browser actions. */
export function failureOf(status: number): ReadFailure {
  if (status === 404 || status === 410) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}
