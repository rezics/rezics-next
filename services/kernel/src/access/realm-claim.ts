import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { principalCommandIdentity, runCommand, type CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { tryAccessApplication } from './adapters/bind.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalContext from './bootstrap-governance-read.sql';
import {
  RealmClaimDeniedError,
  type RealmClaimApprovalResult,
  type RealmCommandTransaction,
} from './contract/index.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import { grantRealmClaimOwner } from './realm-claim-grant.ts';

export type ApproveRealmClaimInput = Readonly<{ realmId: string; requestId: string }>;
export type ApproveRealmClaimContext = Readonly<{ deadline: number; idempotencyKey: string }>;
export type RealmClaimApproval = RealmClaimApprovalResult;

export async function approveRealmClaim(
  deps: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  actor: Actor,
  input: ApproveRealmClaimInput,
  context: ApproveRealmClaimContext,
): Promise<RealmClaimApproval> {
  const application = tryAccessApplication();
  if (!application) throw new GrantDeniedError();
  const realmId = input.realmId;
  const requestId = input.requestId;
  const route = routeOf(realmId);
  const deadline = context.deadline;
  const key = context.idempotencyKey;
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
    context: { pool: deps.pool, deadline, partition: partitionOf(route ?? 0) },
  });
  return application
    .approveRealmClaim({
      actor,
      realmId,
      requestId,
      deadline,
      idempotencyKey: key,
      grantOwner: (tx, realm, claimantAccountId, transactionId) =>
        grantRealmClaimOwner(tx as CommandTransaction, deps.access, realm, claimantAccountId, transactionId),
      async runCommand<T>(
        body: (tx: RealmCommandTransaction, command: { transactionId: string }) => Promise<T>,
      ): Promise<T> {
        const result = await runCommand<T>(
          deps.pool,
          {
            ...identity,
            partition: partitionOf(route ?? 0),
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
            const value = await body(tx as RealmCommandTransaction, command);
            return {
              value,
              events: [{ type: `com.rezics.${kind}.v1`, subject: realmId, data: value }],
            };
          },
        );
        return result.value;
      },
    })
    .catch((error: unknown) => {
      // Preserve the native refusal contract across the application boundary.
      if (error instanceof RealmClaimDeniedError) throw new GrantDeniedError();
      throw error;
    });
}
