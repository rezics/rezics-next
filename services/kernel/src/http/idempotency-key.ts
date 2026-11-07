/** Structured header decoding shared by command route adapters. */
import { parseItem } from 'structured-headers';
import { ProblemError } from './problem-error.ts';
import { normalizeCommandKey, type CommandPrincipal } from '../command/command.ts';

export function idempotencyKeyOf(header: string | null | undefined, principal?: CommandPrincipal): string {
  if (typeof header !== 'string')
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a structured field string.' });

  let value: unknown;
  try {
    [value] = parseItem(header);
  } catch {
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a structured field string.' });
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 255)
    throw new ProblemError('invalid_request', { detail: 'Idempotency-Key must be a string of 1 to 255 characters.' });
  try {
    return principal ? normalizeCommandKey(principal, value) : value;
  } catch {
    throw new ProblemError('invalid_request', {
      detail: 'Anonymous commands require a client-generated UUIDv4 Idempotency-Key.',
    });
  }
}
