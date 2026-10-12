/** Only transport evidence can make an owner comparison retryable. */
// pg gives these uncoded transport errors no code, so their exact messages are
// the only driver evidence available. Sources: node_modules/pg/lib/client.js:204,
// node_modules/pg/lib/client.js:170, node_modules/pg/lib/client.js:749,
// node_modules/pg/lib/client.js:707, node_modules/pg-pool/index.js:224,
// node_modules/pg-pool/index.js:276. client.js:204 also emits `Connection terminated`
// for a deliberate client end; that message is excluded.
export const DRIVER_TRANSPORT_FAILURES = Object.freeze([
  'Connection terminated unexpectedly',
  'timeout expired',
  'Client has encountered a connection error and is not queryable',
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
] as const);

export function isOwnerTransientFailure(error: unknown): boolean {
  const seen = new Set<object>();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const failure = error as {
      code?: unknown;
      name?: unknown;
      status?: unknown;
      constructor?: { name?: unknown };
      cause?: unknown;
      message?: unknown;
    };
    if (failure.name === 'TimeoutError') return true;
    if (failure.constructor?.name === 'CommandOutcomeUnknown') return true;
    if (typeof failure.status === 'number' && (failure.status === 408 || failure.status === 429
      || Number.isInteger(failure.status) && failure.status >= 500 && failure.status <= 599))
      return true;
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
    if (
      failure.name === 'Error' &&
      failure.code === undefined &&
      typeof failure.message === 'string' &&
      DRIVER_TRANSPORT_FAILURES.some(message => message === failure.message)
    )
      return true;
    error = failure.cause;
  }
  return false;
}
