export const SESSION_UNAVAILABLE_CODE = 'session_unavailable';

/** Recognize only the session boundary's explicit dependency failure through server-function wrappers. */
export function isSessionUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (
      ('name' in value && value.name === 'SessionUnavailableError') ||
      ('code' in value && value.code === SESSION_UNAVAILABLE_CODE)
    )
      return true;
    pending.push(
      'problem' in value ? value.problem : undefined,
      'data' in value ? value.data : undefined,
      'cause' in value ? value.cause : undefined,
    );
  }

  return false;
}
