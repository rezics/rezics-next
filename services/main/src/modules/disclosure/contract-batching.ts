import { DisclosureUnavailable } from './read.ts';
import { DISCLOSURE_COST, DISCLOSURE_SUBMISSION_LIMIT } from './contract-cost.ts';
export { DISCLOSURE_SUBMISSION_LIMIT } from './contract-cost.ts';

export interface DisclosureSubmission<T> {
  results: readonly T[];
  /** Actual statement/probe counters supplied by the bounded operation. */
  cost: Readonly<Record<string, number>>;
}

/** Every contract entry submits at most 2,048 inputs as ceil(N/64) sequential
 * bounded operations. Preserve order and duplicates; cuts belong to each
 * capture, and the final fence must recheck every captured chunk. The operation
 * retains its snapshot/client rules. No partial result escapes a failed chunk.
 * Costs sum the counters measured by the operation, never inferred estimates. */
export async function chunkDisclosureSubmission<T, R>(
  inputs: readonly T[],
  run: (chunk: readonly T[], offset: number) => Promise<DisclosureSubmission<R>>,
): Promise<DisclosureSubmission<R> & { submissions: number }> {
  if (inputs.length > DISCLOSURE_SUBMISSION_LIMIT) {
    throw new DisclosureUnavailable('Disclosure submission exceeds 2,048 targets');
  }
  // A callback cannot extend the accepted input after the pre-work limit check.
  const accepted = [...inputs];
  const results: R[] = [];
  const cost: Record<string, number> = {};
  let submissions = 0;
  try {
    for (let offset = 0; offset < accepted.length; offset += DISCLOSURE_COST.batch) {
      const chunk = Object.freeze(accepted.slice(offset, offset + DISCLOSURE_COST.batch));
      const submission = await run(chunk, offset);
      if (submission.results.length !== chunk.length) {
        throw new DisclosureUnavailable('Disclosure chunk result is incomplete');
      }
      for (const [counter, count] of Object.entries(submission.cost)) {
        const total = (Object.hasOwn(cost, counter) ? cost[counter]! : 0) + count;
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total)) {
          throw new DisclosureUnavailable('Disclosure chunk cost is invalid');
        }
        Object.defineProperty(cost, counter, { value: total, enumerable: true, configurable: true });
      }
      results.push(...submission.results);
      submissions++;
    }
    return { results: Object.freeze(results), cost: Object.freeze(cost), submissions };
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure submission is unavailable', { cause });
  }
}
