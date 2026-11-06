/** Authorization adapter. Access implements Library's admission port at composition. */

import { deadlineClient, within } from '../../access/authenticate.ts';
import { durableInitiatorCommitment, fenceOperationalAccount } from '../../access/index.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../../request/access.ts';
import type { AuthorizationCapability } from '../contract/index.ts';
import { grantCapable } from '../core/index.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createAuthorizationAdapter(access?: Access): AuthorizationCapability {
  return {
    async admitCollectionRead(input) {
      if (!access) return { authorized: input.actor.kind === 'account' && input.privateOwner };
      if (input.visibility !== 'private' && !input.privateOwner) return { authorized: true };
      if (input.actor.kind !== 'account') return { authorized: false };
      return {
        authorized: grantCapable(
          {
            route: input.route,
            accountId: input.actor.accountId,
            kind: 'actor',
            state: 'active',
            fenced: false,
            minimumAuthnEpoch: 0n,
          },
          input.actor,
        ),
      };
    },
    async fenceAccount(tx, accountId) {
      await fenceOperationalAccount(tx as Parameters<typeof fenceOperationalAccount>[0], accountId);
    },
    isLifecycleDenied(error) {
      return error instanceof Error && error.name === 'LifecycleDeniedError';
    },
    commandAuthorization(...args) {
      return (accessCommandAuthorization as (...values: readonly unknown[]) => Promise<unknown>)(...args);
    },
    deadlineClient(client, deadline) {
      return deadlineClient(client as Parameters<typeof deadlineClient>[0], deadline) as typeof client;
    },
    within(deadline, work) {
      return within(deadline, work);
    },
  };
}

export { durableInitiatorCommitment };
export type { LibraryActor, Actor };
