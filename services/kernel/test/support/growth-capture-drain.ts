/** Waits for registered capture work, including tasks added while an earlier task settles. */
export async function drainCaptureWork(...workSets: readonly Set<Promise<void>>[]): Promise<unknown[]> {
  const failures: unknown[] = [];

  while (true) {
    const pending = new Set(workSets.flatMap((work) => [...work]));
    if (pending.size === 0) return failures;

    const settled = await Promise.allSettled(pending);
    let index = 0;
    for (const task of pending) {
      for (const work of workSets) work.delete(task);
      const result = settled[index++]!;
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
}
