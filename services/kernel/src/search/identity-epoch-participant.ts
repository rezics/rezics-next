import { ConfigError } from '../commerce/config.ts';
import type { IdentityEpochStep } from '../semantic/identity-epoch-contract.ts';
import { identityEpochStore, IdentityEpochStoreError } from '../semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { subjectAlias } from './indices.ts';
import type { OpenSearch } from './opensearch.ts';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

/** Trusted constructor and exact adopted callable; no participant is installed in the default worker.
 * Until the native owner support/receiving bridge exists, fail before any engine or completion effect.
 */
export function createSearchIdentityEpochParticipant(options: {
  search: OpenSearch;
  prefix: string;
  routeKey: Uint8Array;
}): IdentityEpochStep {
  subjectAlias(options.prefix);
  if (!(options.routeKey instanceof Uint8Array) || options.routeKey.byteLength !== 32)
    throw new ConfigError('KERNEL_ROUTE_KEY');
  return async (pool, job) => {
    const ref = { jobId: job.jobId, epoch: job.epoch };
    if (typeof ref.epoch !== 'bigint' || ref.epoch <= 0n) throw new TypeError('Invalid native identity epoch');
    const saved = await withReadTransaction(pool, (tx) => identityEpochStore.readJob(tx, ref));
    if (!saved || saved.state !== 'pending') throw unavailable('Search requires an exact admitted pending native job');
    if (saved.mapping?.state !== 'complete') throw unavailable('Search requires authoritative native mapping custody');
    throw unavailable(
      'Missing native complete-support/pre-publication Source bridge and planned/accepted-producer receiving handoff; see identity-epoch-participant.md',
    );
  };
}
