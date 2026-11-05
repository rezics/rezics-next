import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { principalCommandIdentity, runCommand } from '../command/command.ts';
import { applyRealmClaimApproval, lockRealmClaimApprovalSource } from './realm-claim-approval.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalContext from './bootstrap-governance-read.sql';
import { GrantDeniedError } from './grant-commands.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import { grantRealmClaimOwner } from './realm-claim-grant.ts';

export type ApproveRealmClaimInput = Readonly<{ realmId: string; requestId: string }>;
export type ApproveRealmClaimContext = Readonly<{ deadline: number; idempotencyKey: string }>;
export type RealmClaimApproval = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  state: 'owned';
  orphanedAt: string;
  approvedAt: string;
}>;

export async function approveRealmClaim(
  deps: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  actor: Actor,
  input: ApproveRealmClaimInput,
  context: ApproveRealmClaimContext,
): Promise<RealmClaimApproval> {
  const realmId = input.realmId;
  const requestId = input.requestId;
  const route = routeOf(realmId);
  const deadline = context.deadline;
  const key = context.idempotencyKey;
  if (
    actor.kind !== 'account' ||
    route === null ||
    routeOf(requestId) !== route ||
    !Number.isFinite(deadline) ||
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > 255
  )
    throw new GrantDeniedError();
  const identity = principalCommandIdentity(actor);
  const kind = 'access.realm.claim.approve';
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'realm:approve_claim',
    anchor: {
      resource: PLATFORM_RESOURCE,
      async validate(client) {
        return (
          (
            await globalContext.run(client, {
              route: PLATFORM_RESOURCE.route,
              resource_id: PLATFORM_RESOURCE.id,
            })
          )?.global === true
        );
      },
    },
    context: { pool: deps.pool, deadline, partition: partitionOf(route) },
  });
  const result = await runCommand<RealmClaimApproval>(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline,
      clock: deps.clock ?? accessClock(deps.access),
      authorization,
      receipt: {
        kind,
        key,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, realmId, requestId])!)
          .digest(),
      },
    },
    async (tx, command) => {
      // runCommand has already admitted the exact current Global action and
      // handled receipt replay. Only a new effect acquires the native source.
      const source = await lockRealmClaimApprovalSource(tx, { realmId, requestId });
      if (!source) throw new GrantDeniedError();
      await grantRealmClaimOwner(
        tx,
        deps.access,
        { route, id: realmId },
        source.claimantAccountId,
        command.transactionId,
      );
      // Content consumes its opaque same-tx source and verifies the real native
      // grant before resolving the request/episode. Any failure rolls back both.
      const value = await applyRealmClaimApproval(tx, source);
      return {
        value,
        events: [{ type: `com.rezics.${kind}.v1`, subject: realmId, data: value }],
      };
    },
  );
  return result.value;
}
