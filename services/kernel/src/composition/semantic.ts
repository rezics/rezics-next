import type { Pool } from 'pg';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { stepLibraryIdentityEpoch } from '../library/identity-epoch-participant.ts';
import { createOpenSearch } from '../search/opensearch.ts';
import { createSearchIdentityEpochParticipant } from '../search/identity-epoch-participant.ts';
import { readSearchConfig } from '../search/work.ts';
import { createIdentityEpochParticipants } from '../semantic/application/identity-epoch-participants.ts';
import type { IdentityEpochParticipantPorts } from '../semantic/contract/identity-epoch-ports.ts';
import {
  bindOrdinaryContentLifecycle,
  createNativeSemanticDomain,
  nativeContentLifecycle,
  nativeRatingReview,
  type NativeSemanticDomain,
} from '../semantic/adapters/index.ts';

/** Real fixed identity participants for the default worker: Search currentness and Library custody, bound to the
 * worker pool. Returns null when Search configuration or the membership route key is absent, so the coordinator is
 * unavailable instead of defaulted. Reads only the worker environment, which every WorkContext carries.
 */
export function composeSemanticIdentityParticipants(context: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): IdentityEpochParticipantPorts<Pool> | null {
  const config = readSearchConfig(context.env);
  const routeKey = config && context.env.KERNEL_ROUTE_KEY ? readMembershipRouteKey(context.env) : null;
  if (!config || !routeKey) return null;
  return createIdentityEpochParticipants<Pool>({
    version: 1,
    'search-canonical-index': createSearchIdentityEpochParticipant({
      search: createOpenSearch(config.url),
      prefix: config.prefix,
      routeKey,
    }),
    'library-private-follow-counts': stepLibraryIdentityEpoch,
  });
}

/** Native Content cover and tuple routing, bound even when identity participants are unavailable. */
export function composeSemanticAdapters(): void {
  bindOrdinaryContentLifecycle(nativeContentLifecycle());
}

/** Ordinary process composition: identity participants plus Rating review and Content lifecycle adapters. */
export function composeSemanticDomain(context: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): NativeSemanticDomain | null {
  composeSemanticAdapters();
  const participants = composeSemanticIdentityParticipants(context);
  if (!participants) return null;
  return createNativeSemanticDomain(participants, {
    libraryCustody: Object.freeze({
      stepIdentityEpoch: participants['library-private-follow-counts'],
      readSourcePage: (native, job) => participants['library-private-follow-counts'](native, job),
    }),
    searchCurrentness: Object.freeze({
      stepCanonicalIndex: participants['search-canonical-index'],
    }),
    ratingReview: nativeRatingReview(),
    contentLifecycle: nativeContentLifecycle(),
  });
}
