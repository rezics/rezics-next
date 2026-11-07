import { managedReadTimeout, withScheduledDeadline } from './managed-read-deadline';
import type { SettingsTimer } from './ports/ambient';

/** A deadline bounds observation; aborting a PATCH does not establish its outcome. */
export async function withProfileDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  timer: SettingsTimer,
): Promise<T> {
  return withScheduledDeadline(request, caller, timer, managedReadTimeout, 'Profile request timed out');
}
