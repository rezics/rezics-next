import type { DiscoveryConsumerQuery } from './discovery.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicFilterConsumerCapture,
  PublicFilterConsumerContext,
  PublicFilterConsumerOperations,
  PublicFilterConsumerQuery,
  PublicFilterConsumerRefill,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';

/** Request-local access to the SAME native consumer. This object is never serialized
 * or accepted as permission: every transition resolves the original native rows.
 */
export type PublicFilterCoveragePage = Readonly<{
  capture(plan: PublicCanonicalCaptureInput, snapshot: 'pit' | 'prepared'): Promise<PublicFilterConsumerCapture>;
  query(
    queried: PublicFilterQueriedObservation,
    refill?: PublicFilterConsumerRefill,
  ): Promise<PublicFilterConsumerQuery>;
  queryDiscovery(
    queried: PublicFilterQueriedObservation,
    refill?: PublicFilterConsumerRefill,
  ): Promise<DiscoveryConsumerQuery>;
  /** Persist the actual raw prefix consumed by owner hydration before refill or sealing. */
  consume(execution: string, consumed: number): Promise<void>;
  /** After all dependent reads, metadata and cursor construction, including empty exhaustion. */
  finish(): Promise<void>;
  /** Abandons admission; it cannot stand in for finish or certify an uncertain child. */
  dispose(): Promise<void>;
  /** Translate native refusal without treating an unknown serving error as authority. */
  failure(error: unknown): PublicFilterConsumerUnavailable;
}>;

type Opener = (
  context: PublicFilterConsumerContext,
  capture?: Extract<PublicFilterConsumerCapture, { status: 'captured' }>,
) => PublicFilterCoveragePage;
const openers = new WeakMap<PublicFilterConsumerOperations, Opener>();
const starts = new WeakMap<PublicFilterConsumerContext, string>();

/** Installed only by the real consumer factory, including its resource-owner wrapper. */
export function installPublicFilterCoveragePage(operations: PublicFilterConsumerOperations, open: Opener): void {
  if (openers.has(operations)) throw new TypeError('Coverage page factory already installed');
  openers.set(operations, open);
}

export function forwardPublicFilterCoveragePage(
  original: PublicFilterConsumerOperations,
  wrapper: PublicFilterConsumerOperations,
): void {
  const open = openers.get(original);
  if (open) installPublicFilterCoveragePage(wrapper, open);
}

export function openPublicFilterCoveragePage(
  operations: PublicFilterConsumerOperations,
  context: PublicFilterConsumerContext,
  capture?: Extract<PublicFilterConsumerCapture, { status: 'captured' }>,
): PublicFilterCoveragePage {
  const open = openers.get(operations);
  if (!open) throw new TypeError('Native coverage page factory is unavailable');
  // Only the native factory can recognize its actual capture result. A copied or
  // deserialized result cannot carry a meter, change a cut or transfer ownership.
  return open(Object.freeze({ deadline: context.deadline }), capture);
}

/** Internal role binding only. The UUID must already name a closed native plan;
 * the Source statement checks its observation, definition, owner and deadline.
 */
export async function withPublicFilterCoverageStart<T>(
  context: PublicFilterConsumerContext,
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  if (starts.has(context)) throw new TypeError('Concurrent native coverage starts');
  starts.set(context, id);
  try {
    return await run();
  } finally {
    starts.delete(context);
  }
}

export function publicFilterCoverageStart(context: PublicFilterConsumerContext): string | null {
  return starts.get(context) ?? null;
}
