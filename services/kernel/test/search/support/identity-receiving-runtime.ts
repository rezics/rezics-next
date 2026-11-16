import { composeLibraryDomain } from '../../../src/composition/library.ts';
import { composeSemanticAdapters } from '../../../src/composition/semantic.ts';
import { composeSearchNativePorts } from '../../../src/composition/search-native.ts';
import { systemClock } from '../../../src/clock.ts';
import type { Access } from '../../../src/request/access.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../../../src/search/identity-epoch-participant.ts';
import { createSearchIdentityWriterPreparation } from '../../../src/search/identity-search-writer-preparation.ts';
import { SEARCH_IDENTITY_WRITER_REQUEST } from '../../../src/semantic/contract/identity-epoch-ports.ts';
import { IdentityEpochStoreError } from '../../../src/semantic/contract/identity-errors.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';
import type { IdentityJobRef, IdentityStepProgress } from '../../../src/semantic/identity-epoch-contract.ts';
import { searchReceivingProductionDeclaration } from '../../../src/semantic/identity-search-receiving-statements.ts';
import { withIdentitySourceConsumerMaintenance } from '../../../src/semantic/identity-source-consumer-maintenance.ts';
import type { Pool } from 'pg';

composeLibraryDomain();
composeSemanticAdapters();
const identitySourceSupportReaderFactory = composeSearchNativePorts().createIdentitySourceSupportReader;

/** Production Search receiving for native identity suites: same-Pool Access, clock, generation-1
 * composition and the live Source maintenance frame. A bare `{search,prefix,routeKey}` constructor
 * is not an installed participant. Collection source setup uses the composed Library domain.
 */
export function createSearchIdentityReceivingStep(options: {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  routeKey: Uint8Array;
  access: Access;
}) {
  const receiving = searchIdentityReceivingComposition({
    pool: options.pool,
    search: options.search,
    prefix: options.prefix,
    routeKey: options.routeKey,
    access: options.access,
    clock: systemClock,
    identitySourceSupportReaderFactory,
    work: searchReceivingProductionDeclaration(),
  });
  return {
    step: createSearchIdentityEpochParticipant({ ...options, receiving }),
    prepare: createSearchIdentityWriterPreparation(receiving, {}),
  };
}

/** Run one participant step inside Semantic's funded Source maintenance frame. */
export async function runSearchIdentityReceivingStep(
  pool: Pool,
  { step, prepare }: ReturnType<typeof createSearchIdentityReceivingStep>,
  job: IdentityJobRef,
  deadlineMs = 30_000,
): Promise<IdentityStepProgress> {
  const progress = await withIdentitySourceConsumerMaintenance(
    { pool, env: {} },
    { deadline: Date.now() + deadlineMs },
    () => step(pool, job),
  );
  if (
    progress.state === 'more' &&
    progress.frontier.after[3] === SEARCH_IDENTITY_WRITER_REQUEST &&
    (await prepare(pool, progress.receipt)) !== 'prepared'
  )
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search still needs a committed original plan');
  return progress;
}
