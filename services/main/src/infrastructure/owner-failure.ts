/** Only transport evidence can make an owner comparison retryable. */
export function isOwnerTransientFailure(error: unknown): boolean {
  const seen = new Set<object>();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const failure = error as {
      code?: unknown;
      cause?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    if (
      typeof failure.code === 'string' &&
      (/^08[0-9A-Z]{3}$/.test(failure.code) ||
        [
          '57P01',
          '57P02',
          '57P03',
          '40001',
          '40P01',
          '53300',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EPIPE',
        ].includes(failure.code))
    )
      return true;
    // pg-pool's uncoded checkout timeout has a driver-owned signature. A
    // domain error mentioning a connection or timeout is never retry evidence.
    if (
      error instanceof Error &&
      failure.code === undefined &&
      typeof failure.stack === 'string' &&
      /\n\s+at [^\n]*[/\\]pg-pool[/\\]index\.js:\d+:\d+/.test(failure.stack) &&
      (failure.message === 'timeout exceeded when trying to connect' ||
        failure.message === 'Connection terminated due to connection timeout')
    )
      return true;
    error = failure.cause;
  }
  return false;
}
