export class ThreadPageCursorError extends Error {
  readonly code = 'invalid_cursor';
  readonly name = 'ThreadPageCursorError';
}

export function isThreadPageCursorError(error: unknown): boolean {
  return (
    error instanceof ThreadPageCursorError ||
    (!!error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'ThreadPageCursorError' &&
      'code' in error &&
      error.code === 'invalid_cursor')
  );
}
