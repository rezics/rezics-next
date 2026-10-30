import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { resourceAuthorization } from '../access/index.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { realmParticipationAnchor } from './participation.ts';
import { realmReadEligibility, RealmInputError, type RealmDependencies, type RealmContext } from './realm.ts';
import read from './realm-continuity-read.sql';
import lock from './realm-continuity-lock.sql';
import insertRequest from './realm-continuity-request-insert.sql';
import readRequest from './realm-continuity-request-read.sql';

export type RealmContinuity = Readonly<{
  ownershipState: 'owned' | 'orphaned';
  orphanedAt: string | null;
  claimEligibleAt: string | null;
  governanceReadOnly: boolean;
}>;

export class RealmReadOnlyError extends ProblemError {
  constructor() {
    super('conflict', {
      detail: 'This Realm is orphaned and governance is read-only pending a platform ownership decision.',
    });
    this.name = 'RealmReadOnlyError';
  }
}

export function realmContinuityView(row: {
  ownership_state: string;
  orphaned_at: string | null;
  claim_eligible_at: string | null;
}): RealmContinuity {
  if (row.ownership_state !== 'owned' && row.ownership_state !== 'orphaned')
    throw new Error('Invalid native Realm ownership decision');
  return {
    ownershipState: row.ownership_state,
    orphanedAt: row.orphaned_at === null ? null : new Date(row.orphaned_at).toISOString(),
    claimEligibleAt: row.claim_eligible_at === null ? null : new Date(row.claim_eligible_at).toISOString(),
    governanceReadOnly: row.ownership_state === 'orphaned',
  };
}

/** The transaction rechecks and locks the same native identity before receipt replay
 * or a new write. A concurrent succession cannot slip between this check and commit.
 * This guard consumes ordinary Access authorization; it grants no action itself.
 */
export function realmGovernanceAuthorization(
  authorization: CommandAuthorization,
  resource: Resource,
): CommandAuthorization {
  return {
    ...authorization,
    async authorize(tx, attempt, proof) {
      const outcome = await authorization.authorize(tx, attempt, proof);
      const row = await lock.run(tx, {
        route: resource.route,
        id: resource.id,
        at: authoritativeTimeValue(attempt.time),
      });
      if (!row) throw new GrantDeniedError();
      if (row.ownership_state !== 'owned') throw new RealmReadOnlyError();
      return outcome;
    },
  };
}

export type RealmClaimRequest = Readonly<{
  realmId: string;
  requestId: string;
  state: 'pending';
  orphanedAt: string;
  claimEligibleAt: string;
  requestedAt: string;
}>;

/** Request review using the existing participation and read admission. Neither a
 * request nor expiry transfers a grant. Platform approval is a separate authority.
 */
export async function requestRealmClaim(deps: RealmDependencies, actor: Actor, realmId: string, context: RealmContext) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const route = routeOf(realmId);
  if (route === null) throw new RealmInputError();
  const resource = { route, id: realmId };
  const checks = new WeakMap<AuthoritativeTime, AccessCheck>();
  const access = deriveAccess(deps.access, {
    async prepare(principal, action, target, preparation) {
      const attempt = accessCommandAttempt(preparation);
      if (!attempt) throw new GrantDeniedError();
      const evidence = await deps.access.prepare?.(principal, action, target, preparation);
      checks.set(
        attempt.time,
        await accessCheck(
          deps.access,
          principal,
          'realm:read',
          {
            ...resource,
            eligibility: realmReadEligibility(resource),
          },
          preparation,
        ),
      );
      return evidence;
    },
  });
  const authorization = resourceAuthorization({
    access,
    actor,
    action: 'realm:participate',
    anchor: {
      resource: realmParticipationAnchor(resource).resource,
      async validate(client, time) {
        const check = checks.get(time);
        return !!check && check(client, time);
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  const identity = principalCommandIdentity(actor);
  const kind = 'community.realm.claim-request';
  return runCommand<RealmClaimRequest>(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, realmId])!)
          .digest(),
      },
      authorization: {
        ...authorization,
        async authorize(tx, attempt, proof) {
          const outcome = await authorization.authorize(tx, attempt, proof);
          const row = await lock.run(tx, { route, id: realmId, at: authoritativeTimeValue(attempt.time) });
          if (!row) throw new GrantDeniedError();
          if (row.ownership_state !== 'orphaned' || !row.claim_eligible)
            throw new ProblemError('conflict', {
              detail: 'A claim can be requested only after the original thirty-day orphan period.',
            });
          return outcome;
        },
      },
    },
    async (tx, command) => {
      const at = authoritativeTimeValue(command.time);
      const row = await read.run(tx, { route, id: realmId, at });
      if (!row?.orphaned_at || !row.claim_eligible_at) throw new GrantDeniedError();
      const key = { route, realm: realmId, account: actor.accountId, orphaned: row.orphaned_at };
      const inserted = await insertRequest.run(tx, { ...key, request: newId(route), at });
      const pending = inserted ?? (await readRequest.run(tx, key));
      if (!pending) throw new Error('Realm claim request disappeared');
      const value: RealmClaimRequest = {
        realmId,
        requestId: pending.request_id,
        state: 'pending',
        orphanedAt: row.orphaned_at,
        claimEligibleAt: row.claim_eligible_at,
        requestedAt: pending.requested_at,
      };
      if (!inserted) return noEffect(value);
      return {
        value,
        events: [{ type: 'com.rezics.community.realm.claim-requested.v1', subject: realmId, data: value }],
      };
    },
  );
}
