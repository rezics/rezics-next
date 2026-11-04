import type { RenameAttempt, RenameContinuation, RenameRead, RenameTarget } from './account-rename';
import { sameRenameContinuation } from './account-rename';

/** Mounted history contains no descriptor or private label and is never persisted. */
export type RenameHistory = 'none' | 'unknown' | 'acknowledged';

export function sameRenameSession(left: RenameTarget, right: RenameTarget): boolean {
  return (
    left.accountId === right.accountId &&
    left.clientId === right.clientId &&
    left.authnEpoch === right.authnEpoch &&
    left.authTime === right.authTime &&
    JSON.stringify(left.scopes ?? []) === JSON.stringify(right.scopes ?? []) &&
    JSON.stringify(left.amr ?? []) === JSON.stringify(right.amr ?? [])
  );
}

/** Current advice can restore review, never establish an execution outcome.
 * A reference belongs only to the still-active, unchanged session and descriptor. */
export function recoverRenameAttempt(
  current: RenameRead,
  saved: RenameContinuation | null,
  live: RenameAttempt | null,
  previous: RenameTarget | null,
): RenameAttempt | null {
  const descriptor = saved ?? live;
  if (current.kind !== 'ready' || !descriptor || descriptor.accountId !== current.target.accountId) return null;
  if (!descriptor.submitted && descriptor.operation.expectedHandle !== current.target.handle) return null;
  if (live && sameRenameContinuation(live, descriptor) && previous && sameRenameSession(previous, current.target))
    return live;
  return saved;
}
