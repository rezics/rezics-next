export const SESSION_UNAVAILABLE_CODE = 'session_unavailable';

/** Recognize only the session boundary's explicit dependency failure through server-function wrappers. */
export function isSessionUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.name === 'SessionUnavailableError' || record.code === SESSION_UNAVAILABLE_CODE) return true;
    for (const key of ['problem', 'data', 'cause']) pending.push(record[key]);
  }

  return false;
}
