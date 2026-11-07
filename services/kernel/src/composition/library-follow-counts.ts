/** Default Follow composition: owners supply account, Space and identity behavior. */
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { readAccount, classifyUnavailability } from '../access/adapters/index.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { ACCESS_EVENTS } from '../access/events.ts';
import { readPublicAccountByAgent } from '../access/public-identity.ts';
import type { AccessFollowCountProducer } from '../access/contract/index.ts';
import { readSpace } from '../community/adapters/index.ts';
import type { CommunityFollowCountProducer } from '../community/contract/index.ts';
import type { Access, AccessClient } from '../request/access.ts';
import type { CommandTransaction } from '../command/command.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { routeOf } from '../route/route.ts';
import { createNativeFollowCountReads } from '../library/adapters/index.ts';
import {
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  type FollowCountRuntime,
  type CountDestination,
  type FollowCountTarget,
} from '../library/contract/index.ts';

export function nativeFollowCountRuntime(): FollowCountRuntime {
  const accounts: AccessFollowCountProducer<AccessClient, Pool> = {
    account: readAccount,
    async accountForAgent(pool, id) {
      return (await readPublicAccountByAgent(pool, id))[0]?.id ?? null;
    },
  };
  const spaces: CommunityFollowCountProducer<AccessClient> = {
    async exists(client, id, at) {
      return (await readSpace(client, id, at)) !== null;
    },
  };
  async function destination(pool: object, target: FollowCountTarget): Promise<CountDestination> {
    let targetId = target.targetId,
      epoch: bigint | null = null;
    if (target.targetType === 'subject') {
      const mapping = await identityEpochStore().readMapping(pool as Pool, targetId);
      if (mapping.state === 'absent') throw new FollowCountTargetAbsentError();
      if (mapping.state !== 'mapped') throw new FollowCountUnavailableError('Current count identity is unavailable');
      targetId = mapping.terminal;
      epoch = mapping.epoch;
    }
    const route = routeOf(targetId);
    if (route === null) throw new TypeError('Follow count locator requires a routed ID');
    return { targetId, route, epoch };
  }
  return {
    reads(pool, access) {
      return createNativeFollowCountReads(pool as Pool, access as Access, {
        account: accounts.account,
        accountForAgent: accounts.accountForAgent,
        spaceExists: spaces.exists,
        deadlineClient,
        within,
        destination,
        isUnavailable: (error) => !!classifyUnavailability(error),
      });
    },
    destination,
    async admitIdentity(tx, input) {
      await identityEpochStore().admitHomeEffect(tx as CommandTransaction, { kind: 'follow-count', ...input });
    },
    validAccountEvent(type, data) {
      return Value.Check(ACCESS_EVENTS()[type], data);
    },
  };
}
