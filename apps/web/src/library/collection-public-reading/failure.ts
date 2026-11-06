type NativeFailure = {
  status: number;
  code: string;
  retryAfter?: string;
};
export type CollectionReadFailure = { kind: 'collection-read-failed'; failure: NativeFailure };

/** Owner failures retain their HTTP meaning without putting native bodies or credentials in hydration. */
export class CollectionReadError extends Error {
  readonly name = 'CollectionReadError';
  readonly statusCode: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  readonly retryable = true;
  constructor(readonly failure: NativeFailure) {
    super(failure.code);
    this.statusCode = failure.status;
    this.code = failure.code;
    this.headers = {
      'cache-control': 'private, no-store',
      ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
    };
  }
  get status() {
    return this.failure.status;
  }
}

export async function captureCollectionRead<T>(read: () => Promise<T>): Promise<T | CollectionReadFailure> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof CollectionReadError)) throw error;
    return { kind: 'collection-read-failed', failure: error.failure };
  }
}

export function admitCollectionRead<T extends object>(result: T | CollectionReadFailure): T {
  if ('kind' in result && result.kind === 'collection-read-failed' && 'failure' in result)
    throw new CollectionReadError((result as CollectionReadFailure).failure);
  return result as T;
}
