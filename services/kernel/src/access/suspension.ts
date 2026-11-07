import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandOutcome } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { GrantDeniedError } from './resource-access-errors.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import suspendStatement from './suspension-update.sql';
import probe from './operator-fence-probe.sql';
import {
  continuationEntryDigest,
  continuationCommandBinding,
  insertDeletionContinuation,
  validateContinuationBinding,
  type ContinuationBinding,
} from './committed-continuations.ts';

export type SuspensionContext = AccessContext & { actor: Actor };
export type SuspensionInput = { accountId: string; key: string; reason?: string; continuation?: ContinuationBinding };
export type SuspensionValue = {
  accountId: string;
  state: 'suspended';
  minimumAuthnEpoch: string;
  receiptId: string;
  continuationOperationKey?: string;
};

export const suspensionDeclaration = Object.freeze({
  action: 'account:suspend',
  operationId: 'account.suspend',
} as const);

/** The private reader shares the complete native digest, including a supplied continuation binding. */
export function suspensionRequestDigest(actor: Extract<Actor, { kind: 'account' }>, input: SuspensionInput): Buffer {
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  return createHash('sha256')
    .update(
      canonicalize([
        routeOf(input.accountId),
        input.accountId,
        basis,
        input.reason ?? null,
        continuationCommandBinding(input.continuation),
      ])!,
    )
    .digest();
}

/** Active accounts only. A lifecycle coordination row, including an operator
 * responsibility, does not block this safety transition.
 * Authorization uses the Global Context, then releases it before target checkout.
 * Every attempt, including receipt replay, admits the current actor and checks
 * the same action before reading the subject partition's receipt.
 *
 * Cost: one actor admission seek and the native Global Context formula cost
 * O((1 + K) log G), K <= 1000. The subject transaction locks one account,
 * advances its floor and fence, and inserts one fence receipt, O(log R),
 * R = N + U*t + M. It adds one bounded responsibility probe and, for operators, one immutable
 * continuation insert in this same transaction.
 */
export function createSuspensionCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async suspend(context: SuspensionContext, body: SuspensionInput): Promise<CommandOutcome<SuspensionValue>> {
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
        Object.keys(input).some((key) => !['accountId', 'key', 'reason', 'continuation'].includes(key))
      )
        throw new GrantDeniedError();
      if (input.continuation) validateContinuationBinding(input.continuation);
      const partition = partitionOf(route);
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      const digest = suspensionRequestDigest(actor, input);
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: suspensionDeclaration.action,
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
          receipt: { actorAccountId: actor.accountId, kind: 'access.account.suspend', key: input.key, digest },
        },
        async (tx, { transactionId }) => {
          const receiptId = derivedId(PLATFORM_RESOURCE.id, `${transactionId}:suspension`, route);
          const [receipt] = await suspendStatement.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: receiptId,
            reason: input.reason ?? '',
            transaction_id: transactionId,
          });
          if (!receipt) throw new GrantDeniedError();
          const value: SuspensionValue = {
            accountId: input.accountId,
            state: 'suspended',
            minimumAuthnEpoch: receipt.minimumAuthnEpoch,
            receiptId,
          };
          const responsible = await probe.run(tx, { route, operator_id: input.accountId });
          if (responsible.responsible || input.continuation) {
            const binding = input.continuation ?? {
              operationKey: `suspend:${receiptId}`,
              operationDigest: digest.toString('hex'),
              commandKeyPrefix: `wf:${createHash('sha256').update(receiptId).digest('hex')}`,
            };
            const allowlist = ['revoke-auth-sessions', 'operator-responsibility-page'].map((step) => {
              const entry = { step, target: input.accountId, key: `${binding.commandKeyPrefix}:${step}` };
              return { ...entry, digest: continuationEntryDigest(entry) };
            });
            await insertDeletionContinuation(tx, {
              accountId: input.accountId,
              handle: null,
              operatorAccountId: null,
              reservationId: null,
              binding,
              barrierReceiptId: receiptId,
              minimumAuthnEpoch: receipt.minimumAuthnEpoch,
              transactionId,
              allowlist,
            });
            value.continuationOperationKey = binding.operationKey;
          }
          return {
            value,
            events: [{ type: 'com.rezics.access.account.suspended.v1', subject: input.accountId, data: value }],
          };
        },
      );
    },
  };
}
