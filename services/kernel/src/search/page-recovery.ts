import type { SearchNativeRecoveryFamily } from './operation-outcomes.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerContext,
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicFilterConsumerRepair,
} from './public-filter-consumer-contract.ts';

export type SearchPageRecoveryTransition = 'preparing' | 'retry' | 'restart' | 'ready' | 'destination-return';

/** Page recovery after rebuild, outage or identity change. A changed generation restarts the executed query. */
export function searchPageRecoveryTransition(input: {
  preparing?: boolean;
  generationChanged?: boolean;
  identityChanged?: boolean;
  returning?: boolean;
}): SearchPageRecoveryTransition {
  if (input.generationChanged || input.identityChanged) return 'restart';
  if (input.returning) return 'destination-return';
  if (input.preparing) return 'preparing';
  return 'ready';
}

/** A locator-only delivery boundary. The host supplies its existing durable work
 * enqueue operation; no local queue, job store or replacement frontier is created.
 */
export type DeliverSearchRepair = (job: PublicFilterConsumerJob, context: PublicFilterConsumerContext) => Promise<void>;

/** Enqueue only actual native work. Missing dependencies cannot mint a preparing job. */
export async function deliverSearchRecovery(
  capture: PublicFilterConsumerCapture,
  deliver: DeliverSearchRepair,
  context: PublicFilterConsumerContext,
): Promise<void> {
  if (capture.status === 'preparing') await deliver(capture.repair, context);
}

/** One bounded producer step, suitable for the existing durable worker. A settled
 * diagnostic is deliberately returned unchanged: it is neither ready data nor ACK.
 * Retrying this exact locator after a crash uses the producer's retained frontier.
 */
export async function advanceSearchRecovery(
  operations: PublicFilterConsumerOperations,
  job: PublicFilterConsumerJob,
  context: PublicFilterConsumerContext,
): Promise<PublicFilterConsumerRepair> {
  return operations.repairStep(job, context);
}

/** Generation or identity change restarts; preparation is never a successful empty page. */
export function searchNativePageTransition(input: {
  family: SearchNativeRecoveryFamily;
  generationChanged?: boolean;
  identityChanged?: boolean;
}): SearchPageRecoveryTransition {
  if (input.generationChanged || input.identityChanged || input.family === 'restart') return 'restart';
  if (input.family === 'index-not-ready' || input.family === 'source-not-ready') return 'preparing';
  if (input.family === 'ready') return 'ready';
  return 'retry';
}
