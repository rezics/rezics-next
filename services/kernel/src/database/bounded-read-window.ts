/** Run independent reads with bounded concurrency while retaining input order.
 * A failed operation or before-dispatch check stops queued work immediately;
 * already-started operations settle before the original failure is rethrown. */
export async function boundedReadWindow<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>,
  beforeDispatch?: () => void,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  let stopped = false;
  let failed = false;
  let failure: unknown;
  const stop = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    stopped = true;
  };
  const worker = async () => {
    while (!stopped) {
      const index = next;
      if (index >= values.length) return;
      try {
        beforeDispatch?.();
      } catch (error) {
        stop(error);
        return;
      }
      next += 1;
      try {
        results[index] = await work(values[index]!, index);
      } catch (error) {
        stop(error);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (failed) throw failure;
  return results;
}
