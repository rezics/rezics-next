import { QueryObserver, type QueryClient, type QueryKey, type QueryObserverOptions } from '@tanstack/react-query';

export type SubjectCanonicalQueryOptions<T> = QueryObserverOptions<T, Error, T, T, QueryKey>;

/** Stop this route from waiting without cancelling another observer of the same query. */
export function readSubjectCanonicalQuery<T>(
  client: QueryClient,
  options: SubjectCanonicalQueryOptions<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const observer = new QueryObserver(client, options);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const onResult = (result: ReturnType<typeof observer.getCurrentResult>) => {
      if (signal.aborted) return onAbort();
      if (result.isError && !result.isFetching && result.fetchStatus === 'idle')
        return finish(() => reject(result.error));
      if (result.isSuccess && !result.isFetching && result.fetchStatus === 'idle')
        return finish(() => resolve(result.data));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribe = observer.subscribe(onResult);
    if (settled) unsubscribe();
    else onResult(observer.getCurrentResult());
  });
}

/** Fence route results and errors even when the server function or native transport ignores abort. */
export function awaitSubjectRoute<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));

    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return read();
      })
      .then(
        (value) => {
          if (signal.aborted) onAbort();
          else finish(() => resolve(value));
        },
        (error: unknown) => {
          if (signal.aborted) onAbort();
          else finish(() => reject(error));
        },
      );
  });
}
