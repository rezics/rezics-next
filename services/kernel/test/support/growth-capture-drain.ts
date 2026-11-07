import { GROWTH_FAILURE_CAUSE_LIMIT } from './growth-failure-evidence.ts';

export type CaptureDrainResult = Readonly<{
  errors: readonly unknown[];
  omittedErrors: number;
}>;

/** Waits for registered capture work, including tasks added while an earlier task settles. */
export async function drainCaptureWork(...workSets: readonly Set<Promise<void>>[]): Promise<CaptureDrainResult> {
  const failures: unknown[] = [];
  let omittedErrors = 0;

  while (true) {
    const pending = new Set(workSets.flatMap((work) => [...work]));
    if (pending.size === 0) return { errors: failures, omittedErrors };

    const settled = await Promise.allSettled(pending);
    let index = 0;
    for (const task of pending) {
      for (const work of workSets) work.delete(task);
      const result = settled[index++]!;
      if (result.status === 'rejected') {
        if (failures.length < GROWTH_FAILURE_CAUSE_LIMIT) failures.push(result.reason);
        else omittedErrors++;
      }
    }
  }
}
