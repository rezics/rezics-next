import { DependencyUnavailablePage } from '../shell/dependency-recovery/page';
import { isSessionUnavailableError, SessionUnavailableError } from './unavailable';
import type { SessionAccess } from './guard';

/** Admit a private page only after the current session observation is signed in. */
export async function loadPrivatePage<T>(
  access: SessionAccess,
  read: () => T | Promise<T>,
): Promise<T> {
  if (access.state !== 'signed-in') throw new SessionUnavailableError();
  try {
    return await read();
  } catch (error) {
    if (isSessionUnavailableError(error)) throw new SessionUnavailableError();
    throw error;
  }
}

export function SessionUnavailablePrompt() {
  return <DependencyUnavailablePage />;
}
