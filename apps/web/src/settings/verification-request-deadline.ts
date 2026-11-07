import { managedReadTimeout, withScheduledDeadline } from './managed-read-deadline';
import type { SettingsTimer } from './ports/ambient';

/** Observation ends after ten seconds; aborting a command never establishes its outcome. */
export async function withVerificationDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  timer: SettingsTimer,
): Promise<T> {
  return withScheduledDeadline(request, caller, timer, managedReadTimeout, 'Verification request timed out');
}
