/** Coalesce concurrent creation of the same Access proof, retrying a failed attempt. */
export async function onceForKey(cache: Map<string, Promise<void>>, key: string,
  create: () => Promise<void>): Promise<void> {
  let pending = cache.get(key);
  if (!pending) {
    pending = create();
    cache.set(key, pending);
  }
  try {
    await pending;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}

/** Assign each index once; stop allocating on failure and drain already-started work. */
export async function runBoundedIndices(count: number, workers: number,
  run: (index: number) => Promise<void>, progress: (completed: number) => void): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 0
    || !Number.isSafeInteger(workers) || workers < 1 || workers > 4) {
    throw new Error('invalid bounded seed allocation');
  }
  let next = 0;
  let completed = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < count) {
      const index = next++;
      try {
        await run(index);
        completed++;
        if (completed % 100 === 0 || completed === count) progress(completed);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, count) }, worker));
  if (failed) throw failure;
}
