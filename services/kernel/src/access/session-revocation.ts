import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandOutcome } from '../command/command.ts';
import type { Access, AccessContext, AccountActor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { readAccount } from './account-data.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import {
  continuationEntryDigest,
  continuationCommandBinding,
  insertDeletionContinuation,
  validateContinuationBinding,
} from './committed-continuations.ts';
import type { ContinuationBinding } from './committed-continuations.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import revokeStatement from './session-revocation-update.sql';

export type SessionRevocationContext = AccessContext & { actor: AccountActor };
export type SessionRevocationInput = { accountId: string; key: string; continuation?: ContinuationBinding };
export type SessionRevocationValue = {
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  kind: 'fence';
  priorOperatorAccountId: null;
  continuationOperationKey?: string;
};

/** The one Auth step a revocation's continuation lists. */
export const REVOKE_AUTH_SESSIONS_STEP = 'revoke-auth-sessions';

/** Session revocation for one person. The subject itself acts under its own account management; nobody
 * else does except platform governance, which holds `account:suspend` on the Global Context. An organization's
 * owners and another account's managers hold neither, so they are refused. The subject must have authenticated
 * with its own credential: a session opened by an operator is not the person's own.
 *
 * One Access transaction advances the person's `minimum_authn_epoch`, raises the authentication fence, inserts the
 * fence receipt and, for a workflow, commits the continuation that lets Auth revoke the sessions afterwards. The
 * person stays `active`: Auth's recovery clears exactly this fence with a proof issued after it. A proof issued
 * before it names an older floor and cannot complete, lower the floor or clear the fence. Tokens and sessions issued
 * before the fence are refused from its commit, whether or not Auth has revoked anything yet.
 *
 * Every attempt, including receipt replay, admits the current actor and checks the same authority before reading
 * the subject partition's receipt. A subject whose own revocation advanced its floor is therefore refused on replay;
 * platform governance replays the stored answer.
 *
 * Cost: one actor admission seek and the native formula, O((1 + K) log G), K <= 1000. The subject transaction locks
 * one account, advances its floor and fence, inserts one fence receipt and at most one continuation row, O(log R),
 * R = N + U*t + M.
 */
export function createSessionRevocationCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async revoke(
      context: SessionRevocationContext,
      body: SessionRevocationInput,
    ): Promise<CommandOutcome<SessionRevocationValue>> {
      const input = structuredClone(body);
      const route = routeOf(input.accountId);
      const { actor } = context;
      if (
        actor.kind !== 'account' ||
        context.pool !== config.pool ||
        route === null ||
        typeof input.key !== 'string' ||
        input.key.length < 1 ||
        input.key.length > 255 ||
        Object.keys(input).some((key) => !['accountId', 'key', 'continuation'].includes(key))
      )
        throw new GrantDeniedError();
      if (input.continuation) validateContinuationBinding(input.continuation);
      const own = actor.accountId === input.accountId;
      if (own && actor.requestedBy !== null) throw new GrantDeniedError();
      const partition = partitionOf(route);
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      const digest = createHash('sha256')
        .update(canonicalize([route, input.accountId, basis, continuationCommandBinding(input.continuation)])!)
        .digest();
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: own ? 'account:manage' : 'account:suspend',
        anchor: own
          ? {
              resource: { route, id: input.accountId },
              async validate(client) {
                const account = await readAccount(client, route, input.accountId);
                return (
                  !!account &&
                  account.kind === 'actor' &&
                  account.state === 'active' &&
                  account.operatorAccountId === null
                );
              },
            }
          : {
              resource: PLATFORM_RESOURCE,
              async validate(client) {
                const global = await globalRead.run(client, {
                  route: PLATFORM_RESOURCE.route,
                  resource_id: PLATFORM_RESOURCE.id,
                });
                return global?.global === true;
              },
            },
        context: { pool: context.pool, deadline: context.deadline, partition },
      });
      return runCommand(
        config.pool,
        {
          partition,
          basis,
          deadline: context.deadline,
          clock: config.clock,
          authorization,
          receipt: { actorAccountId: actor.accountId, kind: 'access.account.revoke-sessions', key: input.key, digest },
        },
        async (tx, { transactionId }) => {
          const receiptId = derivedId(PLATFORM_RESOURCE.id, `${transactionId}:revocation`, route);
          const [fenced] = await revokeStatement.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: receiptId,
            transaction_id: transactionId,
          });
          if (!fenced) throw new GrantDeniedError();
          const receipt = {
            receiptId,
            accountId: input.accountId,
            minimumAuthnEpoch: fenced.minimumAuthnEpoch,
            kind: 'fence' as const,
            priorOperatorAccountId: null,
          };
          const value: SessionRevocationValue = { ...receipt };
          if (input.continuation) {
            const entry = {
              step: REVOKE_AUTH_SESSIONS_STEP,
              target: input.accountId,
              key: `${input.continuation.commandKeyPrefix}:${REVOKE_AUTH_SESSIONS_STEP}`,
            };
            await insertDeletionContinuation(tx, {
              accountId: input.accountId,
              handle: null,
              operatorAccountId: null,
              reservationId: null,
              binding: input.continuation,
              barrierReceiptId: receiptId,
              minimumAuthnEpoch: fenced.minimumAuthnEpoch,
              transactionId,
              allowlist: [{ ...entry, digest: continuationEntryDigest(entry) }],
            });
            value.continuationOperationKey = input.continuation.operationKey;
          }
          return {
            value,
            events: [{ type: 'com.rezics.access.authentication-fenced.v1', subject: input.accountId, data: receipt }],
          };
        },
      );
    },
  };
}
