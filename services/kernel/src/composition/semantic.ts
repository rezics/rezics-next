import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { stepLibraryIdentityEpoch } from '../library/identity-epoch-participant.ts';
import type { Access } from '../request/access.ts';
import { createOpenSearch } from '../search/opensearch.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../search/identity-epoch-participant.ts';
import { readSearchConfig } from '../search/work.ts';
import { createIdentityEpochParticipants } from '../semantic/application/identity-epoch-participants.ts';
import type { IdentityEpochParticipantPorts } from '../semantic/contract/identity-epoch-ports.ts';
import { searchReceivingProductionDeclaration } from '../semantic/identity-search-receiving-statements.ts';

/** Real fixed identity participants for the default worker: Search currentness and Library custody, bound to the
 * worker pool. Returns null when Search configuration or the membership route key is absent, so the coordinator is
 * unavailable instead of defaulted. Reads only the worker environment, which every WorkContext carries.
 * When pool, clock and Access are present, Search also receives the same-Pool generation-1 receiving composition.
 */
export function composeSemanticIdentityParticipants(context: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pool?: Pool;
  readonly clock?: KernelClock;
  getAuthorization?(): { readonly access: Access };
}): IdentityEpochParticipantPorts<Pool> | null {
  const config = readSearchConfig(context.env);
  const routeKey = config && context.env.KERNEL_ROUTE_KEY ? readMembershipRouteKey(context.env) : null;
  if (!config || !routeKey) return null;
  const search = createOpenSearch(config.url);
  const access = context.getAuthorization?.().access;
  const receiving =
    context.pool && context.clock && access
      ? searchIdentityReceivingComposition({
          pool: context.pool,
          search,
          prefix: config.prefix,
          routeKey,
          access,
          clock: context.clock,
          work: searchReceivingProductionDeclaration(),
        })
      : undefined;
  return createIdentityEpochParticipants<Pool>({
    version: 1,
    'search-canonical-index': createSearchIdentityEpochParticipant({
      search,
      prefix: config.prefix,
      routeKey,
      ...(receiving ? { receiving } : {}),
    }),
    'library-private-follow-counts': stepLibraryIdentityEpoch,
  });
}
