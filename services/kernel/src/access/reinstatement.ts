import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandOutcome } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { continuationEntryDigest, insertDeletionContinuation } from './committed-continuations.ts';
import fenceSource from './committed-continuation-fence-source.sql';
import { GrantDeniedError } from './resource-access-errors.ts';
import fenceClear from './lifecycle-fence-clear.sql';
import { resourceAuthorization } from './resource-authorization.ts';
import reinstateStatement from './reinstatement-update.sql';

export type ReinstatementContext = AccessContext & { actor: Actor };
export type ReinstatementInput = { accountId: string; key: string; reason?: string };
export type ReinstatementValue = {
  accountId: string;
  state: 'active';
  minimumAuthnEpoch: string;
  receiptId: string;
};

/** The account is not suspended, so the reversal does not apply. */
export class ReinstatementNotAppliedError extends Error {
  constructor() {
    super('Account reinstatement was not applied');
    this.name = 'ReinstatementNotAppliedError';
  }
}

function fenceCleared(result: unknown): boolean {
  return Array.isArray(result) ? result.length > 0 : result != null;
}

export const reinstatementDeclaration = Object.freeze({
  action: 'account:reinstate',
  operationId: 'account.reinstate',
} as const);

export function reinstatementRequestDigest(
  actor: Extract<Actor, { kind: 'account' }>,
  input: ReinstatementInput,
): Buffer {
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  return createHash('sha256')
    .update(canonicalize([routeOf(input.accountId), input.accountId, basis, input.reason ?? null])!)
    .digest();
}

/** Suspended accounts only. Authorization uses the Global Context, then releases
 * it before target checkout. Every attempt, including receipt replay, admits the
 * current actor and checks the same action before reading the subject partition's
 * receipt.
 *
 * One transaction locks that account while it is suspended, sets it active,
 * clears the suspension reason, and lowers the authentication fence through
 * lifecycle-fence-clear.sql. The floor stays where suspension put it. No other
 * fence or hold is touched. An immutable root reverses the suspended operator's
 * own fanout in bounded committed pages.
 *
 * Cost: one actor admission seek and the native Global Context formula cost
 * O((1 + K) log G), K <= 1000. The subject transaction locks one account and
 * updates that row, O(log R), R = N + U*t + M. One exact suspension-root
 * lookup and at most one continuation insert add O(log R).
 */
export function createReinstatementCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async reinstate(
      context: ReinstatementContext,
      body: ReinstatementInput,
    ): Promise<CommandOutcome<ReinstatementValue>> {
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
        (input.reason !== undefined &&
          (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 2000)) ||
        Object.keys(input).some((key) => !['accountId', 'key', 'reason'].includes(key))
      )
        throw new GrantDeniedError();
      const partition = partitionOf(route);
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      const digest = reinstatementRequestDigest(actor, input);
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: reinstatementDeclaration.action,
        anchor: {
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
          receipt: { actorAccountId: actor.accountId, kind: 'access.account.reinstate', key: input.key, digest },
        },
        async (tx, { transactionId }) => {
          const receiptId = derivedId(PLATFORM_RESOURCE.id, `${transactionId}:reinstatement`, route);
          const [restored] = await reinstateStatement.run(tx, {
            route,
            account_id: input.accountId,
            transaction_id: transactionId,
          });
          if (!restored?.fenceReceiptId) throw new ReinstatementNotAppliedError();
          const cleared = await fenceClear.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: restored.fenceReceiptId,
            minimum_authn_epoch: restored.minimumAuthnEpoch,
            authn_epoch: restored.minimumAuthnEpoch,
            transaction_id: transactionId,
          });
          if (!fenceCleared(cleared)) throw new ReinstatementNotAppliedError();
          const value: ReinstatementValue = {
            accountId: input.accountId,
            state: 'active',
            minimumAuthnEpoch: restored.minimumAuthnEpoch,
            receiptId,
          };
          let continuationOperationKey: string | undefined;
          const source = await fenceSource.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: restored.fenceReceiptId,
          });
          if (source) {
            const binding = {
              operationKey: `reinstate:${receiptId}`,
              operationDigest: digest.toString('hex'),
              commandKeyPrefix: `wf:${createHash('sha256').update(receiptId).digest('hex')}`,
            };
            const allowlist = [
              {
                step: 'operator-unfence-page',
                target: input.accountId,
                key: `${binding.commandKeyPrefix}:operator-unfence-page`,
              },
              { step: 'operator-fence-source', target: source.continuationId, key: source.commandKeyPrefix },
            ].map((entry) => ({ ...entry, digest: continuationEntryDigest(entry) }));
            await insertDeletionContinuation(tx, {
              accountId: input.accountId,
              handle: null,
              operatorAccountId: null,
              reservationId: null,
              binding,
              barrierReceiptId: receiptId,
              minimumAuthnEpoch: restored.minimumAuthnEpoch,
              transactionId,
              allowlist,
            });
            continuationOperationKey = binding.operationKey;
          }
          return {
            value,
            events: [
              {
                type: 'com.rezics.access.account.reinstated.v1',
                subject: input.accountId,
                data: continuationOperationKey ? { ...value, continuationOperationKey } : value,
              },
            ],
          };
        },
      );
    },
  };
}
