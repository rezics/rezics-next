import { LIBRARY_PRESENTATION_CONCURRENCY } from '../contract/index.ts';

/** Settle all four workers before the caller releases its attempt. Preserve input order. */
export async function mapPresentationBounded<T, R>(values: readonly T[], work: (value: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const valuesOut: R[] = new Array(values.length);
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(LIBRARY_PRESENTATION_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        valuesOut[index] = await work(values[index]!);
      }
    }),
  );
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  return valuesOut;
}
