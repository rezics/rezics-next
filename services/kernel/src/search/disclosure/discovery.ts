import { ProblemError } from '../../http/problem.ts';
import type { PublicFilterSource } from '../../semantic/public-filter-source-contract.ts';
import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerQuery,
  PublicFilterConsumerOperations,
} from '../public-filter-consumer-contract.ts';
import type { DiscoveryPage } from '../discovery.ts';

/** Use the canonical persisted execution's native start, never returned-hit witnesses or readStatus.
 * The native consumer must have retained the complete mixed AST/physical observation before enumeration.
 * This adapter adds only the final native read; query owns start and the caller owns observation custody.
 */
export async function finishDiscoveryDisclosure(
  source: PublicFilterSource,
  executions: readonly Pick<
    Extract<PublicFilterConsumerQuery, { status: 'queried' }>,
    'queried' | 'start' | 'execution'
  >[],
  context: PublicFilterConsumerContext,
  project: () => Promise<DiscoveryPage>,
  consumer: PublicFilterConsumerOperations,
): Promise<DiscoveryPage> {
  // Include summaries, avatars, verification targets, count witnesses and cursor construction in the envelope.
  const page = await project();
  if (executions.length < 1 || executions.length > 3)
    throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  for (const execution of executions) {
    const status = await consumer.readStatus({ queried: execution.queried, execution: execution.execution }, context);
    if (status.status !== 'observed' || status.blocking.length !== 0)
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    const final = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried: execution.queried,
      start: execution.start,
      execution: execution.execution,
      context,
    });
    if (
      final.status !== 'observed' ||
      final.coverage !== 'all_native_homes' ||
      !final.routingComplete ||
      final.blocking.length !== 0
    )
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  }
  // Nonblocking heads are classified as irrelevant by the actual Source, not by a caller's callback.
  return page;
}
