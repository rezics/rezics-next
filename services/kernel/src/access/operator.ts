import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandOutcome, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCheck,
  type Access,
  type AccessClient,
  type AccountActor,
  type ActionCatalogue,
} from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';
import type { LifecycleRequest } from './lifecycle.ts';
import accountRead from './operator-account.sql';
import reservationRead from './operator-reservation.sql';
import reserve from './operator-reserve.sql';
import release from './operator-release.sql';
import pageRead from './operator-page.sql';
import safetyRead from './operator-safety.sql';
import slotRead from './operator-slot.sql';
import retire from './operator-retire.sql';
import link from './operator-link.sql';
import memberRead from './operator-member.sql';
import defaults from './operator-defaults.sql';
import openingInsert from './operator-opening-insert.sql';
import openingConsume from './operator-opening-consume.sql';

export const OPERATOR_RECEIPT_TTL_MS = 60_000;
const EVIDENCE_TTL_MS = 1000;
const NAMESPACE = '134e9749-1120-8a0c-97d0-71287a629cef';
const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
export class OperatorDeniedError extends Error {
  constructor() {
    super('Operator command denied');
    this.name = 'OperatorDeniedError';
  }
}
function requireAllowed(value: unknown): asserts value {
  if (!value) throw new OperatorDeniedError();
}
function route(id: string): number {
  const value = routeOf(id);
  requireAllowed(value !== null);
  return value;
}
function version(value: string) {
  requireAllowed(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
}
function eligible(account: AccountRow | null): account is AccountRow {
  return !!account && account.state === 'active' && !account.fenced && account.operatorAccountId === null;
}
function human(account: Account | null | undefined, actor: AccountActor): account is Account {
  return (
    !!account &&
    account.accountId === actor.accountId &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    !account.fenced &&
    account.operatorAccountId === null &&
    Number.isSafeInteger(actor.authnEpoch) &&
    actor.authnEpoch > 0 &&
    BigInt(actor.authnEpoch) >= account.minimumAuthnEpoch
  );
}
type AccountRow = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;
export type OperatorPurpose = 'session' | 'credential-management';
export type OperatorResponsibility = { operatorAccountId: string; subjectAccountId: string; reservationId: string };
export type OperatorRelation = OperatorResponsibility & { version: string };
export type OperatorOpening = OperatorRelation & {
  receiptId: string;
  actingHumanId: string;
  purpose: OperatorPurpose;
  clientId: string;
  scopes: string[];
  requestedBy: string | null;
  expiresAt: string;
};
export type OperatorConfig = {
  pool: Pool;
  access: Access;
  /** The mounted kernel catalogue, not an Access-maintained action registry. */
  actions: ActionCatalogue;
  /** Registered colon-form account/access permission protecting the operator resource. */
  managementAction: string;
};
type Mutation = { anchor: string; kind: string; key: string; input: unknown; actor?: AccountActor; deadline?: number };
function executor(pool: Pool) {
  return async function execute<T>(
    options: Mutation,
    body: (tx: CommandTransaction, transactionId: string) => Promise<T>,
  ): Promise<CommandOutcome<T>> {
    requireAllowed(typeof options.key === 'string' && options.key.length > 0 && options.key.length <= 256);
    const anchorRoute = route(options.anchor);
    const basis = {
      actorAccountId: options.actor?.accountId ?? SERVICE_ID,
      clientId: options.actor?.clientId ?? 'internal-access',
      requestedBy: options.actor?.requestedBy ?? null,
    };
    const digest = createHash('sha256')
      .update(canonicalize([options.anchor, options.kind, basis, options.actor ?? null, options.input])!)
      .digest();
    const outcome = await runCommand(
      pool,
      {
        partition: partitionOf(anchorRoute),
        basis,
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        receipt: {
          actorAccountId: basis.actorAccountId,
          kind: `access.operator.${options.kind}`,
          key: `${anchorRoute}:${options.key}`,
          digest,
        },
      },
      async (tx, { transactionId }) => {
        const value = await body(tx, transactionId);
        return {
          value,
          events: [{ type: `com.rezics.access.operator.${options.kind}.v1`, subject: options.anchor, data: value }],
        };
      },
    );
    return {
      ...outcome,
      get value() {
        return structuredClone(outcome.value);
      },
    };
  };
}
async function account(client: AccessClient, id: string) {
  return accountRead.run(client, { route: route(id), account_id: id });
}
async function locked(client: AccessClient, id: string) {
  const value = await account(client, id);
  requireAllowed(value);
  return value;
}
function request(context: LifecycleRequest): LifecycleRequest {
  requireAllowed(context.actor.kind === 'account' && human(context.account, context.actor));
  requireAllowed(Number.isFinite(context.deadline) && Date.now() < context.deadline);
  return {
    ...context,
    actor: { ...context.actor, scopes: [...context.actor.scopes] },
    account: structuredClone(context.account),
  };
}
function live(deadline: number) {
  requireAllowed(Date.now() < deadline);
}
function databaseDeadline(row: AccountRow, deadline: number) {
  return new Date(Date.parse(row.observedAt) + Math.max(0, deadline - Date.now())).toISOString();
}

/** Internal trusted application boundary, deliberately absent from public routes.
 * Each mutation runs the kernel executor on exactly one account anchor. No body
 * accepts actorId, clientId, scopes, authorization booleans or serialized evidence.
 * The coordinator supplies kernel-verified context to approval AND consumption.
 * Auth may issue for value.subjectAccountId only after successful consumption.
 */
export function createOperatorCommands(config: OperatorConfig) {
  const { pool, access, managementAction } = config;
  requireAllowed(
    /^(account|access):[a-z][a-z0-9_-]*$/.test(managementAction) &&
      config.actions.get(managementAction)?.anonymous === false,
  );
  const execute = executor(pool);
  const read = (id: string) => withConnection(pool, (client) => account(client, id));
  async function reservation(input: OperatorResponsibility) {
    return withConnection(pool, (client) =>
      reservationRead.run(client, {
        route: route(input.operatorAccountId),
        operator_id: input.operatorAccountId,
        reservation_id: input.reservationId,
      }),
    );
  }
  async function openingEvidence(
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose },
  ) {
    requireAllowed(input.purpose === 'session' || input.purpose === 'credential-management');
    const deadline = Math.min(context.deadline, Date.now() + EVIDENCE_TTL_MS);
    try {
      // Independent reads finish before the management-resource checkout. The
      // supplied request evidence is required; consumption additionally refreshes
      // the human so a durable receipt never preserves a stale login observation.
      const actualHuman = await withConnection(pool, (client) =>
        readAccount(client, route(context.actor.accountId), context.actor.accountId),
      );
      requireAllowed(human(actualHuman, context.actor));
      const operator = await read(input.operatorAccountId);
      requireAllowed(eligible(operator));
      const subject = await read(input.subjectAccountId);
      requireAllowed(
        subject &&
          subject.kind === 'actor' &&
          subject.state === 'active' &&
          !subject.fenced &&
          subject.operatorAccountId === input.operatorAccountId &&
          subject.reservationId !== null,
      );
      let membershipValid = '(,)';
      if (operator.kind === 'organization') {
        const members = await withConnection(pool, (client) =>
          memberRead.run(client, {
            route: route(input.operatorAccountId),
            organization_id: input.operatorAccountId,
            human_id: context.actor.accountId,
          }),
        );
        requireAllowed(members.length === 1 && members[0]);
        membershipValid = members[0].valid;
      } else {
        requireAllowed(operator.kind === 'actor' && operator.accountId === context.actor.accountId);
      }
      const permissionContext = { ...context, pool, account: actualHuman };
      const allowed = await accessCheck(
        access,
        context.actor,
        managementAction,
        { route: route(input.operatorAccountId), id: input.operatorAccountId },
        permissionContext,
      );
      live(deadline);
      return {
        actualHuman,
        operator,
        subject,
        membershipValid,
        deadline,
        databaseDeadline: databaseDeadline(operator, deadline),
        allowed,
      };
    } catch {
      throw new OperatorDeniedError();
    }
  }
  type OpeningEvidence = Awaited<ReturnType<typeof openingEvidence>>;
  async function finalOpening(
    tx: AccessClient,
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string },
    facts: OpeningEvidence,
  ) {
    live(facts.deadline);
    const current = await locked(tx, input.operatorAccountId);
    requireAllowed(eligible(current) && current.minimumAuthnEpoch === facts.operator.minimumAuthnEpoch);
    // This lookup is on this command's operator anchor. It is coordination only;
    // the separately anchored subject observation supplies relationship authority.
    const held = await reservationRead.run(tx, {
      route: route(input.operatorAccountId),
      operator_id: input.operatorAccountId,
      reservation_id: facts.subject.reservationId!,
    });
    requireAllowed(held?.subjectAccountId === input.subjectAccountId);
    requireAllowed(human(facts.actualHuman, context.actor) && (await facts.allowed(tx)));
    live(facts.deadline);
  }
  return {
    /** Explicit trusted registration/organization step. Not called by approval.
     * Owners exercise a normal owner-role grant, including ordinary denials and
     * client scope intersection. Revocation never gets repaired by a read path.
     */
    async provisionManagementDefaults(input: { operatorAccountId: string; key: string }) {
      input = { ...input };
      return execute(
        {
          anchor: input.operatorAccountId,
          kind: 'management-provisioned',
          key: input.key,
          input: { managementAction },
        },
        async (tx, transactionId) => {
          const operator = await locked(tx, input.operatorAccountId);
          requireAllowed(eligible(operator));
          await defaults.run(tx, {
            route: route(input.operatorAccountId),
            operator_id: input.operatorAccountId,
            role: operator.kind === 'organization' ? 'owner' : '',
            action: managementAction,
            transaction_id: transactionId,
          });
          return { operatorAccountId: input.operatorAccountId, action: managementAction };
        },
      );
    },
    /** Acquire before linking. Pending and live reservations are deliberately
     * indistinguishable; both indefinitely block deletion and automation through
     * lifecycle's existing guard. Membership/owner holds use that same guard.
     */
    async reserveResponsibility(input: { operatorAccountId: string; subjectAccountId: string; key: string }) {
      input = { ...input };
      requireAllowed(input.operatorAccountId !== input.subjectAccountId);
      route(input.subjectAccountId);
      return execute(
        { anchor: input.operatorAccountId, kind: 'responsibility-reserved', key: input.key, input },
        async (tx, transactionId) => {
          requireAllowed(eligible(await locked(tx, input.operatorAccountId)));
          const reservationId = derivedId(NAMESPACE, `${transactionId}:responsibility`, route(input.operatorAccountId));
          await reserve.run(tx, {
            route: route(input.operatorAccountId),
            operator_id: input.operatorAccountId,
            subject_id: input.subjectAccountId,
            reservation_id: reservationId,
            transaction_id: transactionId,
          });
          return {
            operatorAccountId: input.operatorAccountId,
            subjectAccountId: input.subjectAccountId,
            reservationId,
          };
        },
      );
    },
    /** Trusted coordinator step, including transfer. The new hold must already
     * exist; no command writes either operator partition. Old slot retirement is
     * atomic with the subject relation change. Resource grants are never touched.
     */
    async recordOperatorRelation(
      input: OperatorResponsibility & {
        expectedOperatorAccountId: string | null;
        expectedVersion: string;
        key: string;
      },
    ) {
      input = { ...input };
      version(input.expectedVersion);
      requireAllowed(
        input.operatorAccountId !== input.subjectAccountId &&
          input.operatorAccountId !== input.expectedOperatorAccountId,
      );
      if (input.expectedOperatorAccountId !== null) route(input.expectedOperatorAccountId);
      const deadline = Date.now() + EVIDENCE_TTL_MS;
      const held = await reservation(input);
      const operator = await read(input.operatorAccountId);
      const bound = operator ? databaseDeadline(operator, deadline) : '';
      return execute(
        { anchor: input.subjectAccountId, kind: 'relation-recorded', key: input.key, input },
        async (tx, transactionId) => {
          live(deadline);
          requireAllowed(held?.subjectAccountId === input.subjectAccountId && eligible(operator));
          const subject = await locked(tx, input.subjectAccountId);
          requireAllowed(
            subject.kind === 'actor' &&
              ['active', 'pending'].includes(subject.state) &&
              !subject.fenced &&
              subject.operatorAccountId === input.expectedOperatorAccountId &&
              subject.version === input.expectedVersion,
          );
          const safety = await safetyRead.run(tx, {
            route: route(input.subjectAccountId),
            account_id: input.subjectAccountId,
          });
          requireAllowed(safety && !safety.held);
          const slot = await slotRead.run(tx, {
            route: route(input.subjectAccountId),
            subject_id: input.subjectAccountId,
            reservation_id: input.reservationId,
          });
          requireAllowed(!slot || (!slot.terminal && slot.operatorAccountId === input.operatorAccountId));
          if (subject.reservationId && subject.operatorAccountId) {
            requireAllowed(
              (await retire.run(tx, {
                route: route(input.subjectAccountId),
                subject_id: input.subjectAccountId,
                reservation_id: subject.reservationId,
                operator_id: subject.operatorAccountId,
                transaction_id: transactionId,
              })) !== null,
            );
          }
          const changed = await link.run(tx, {
            route: route(input.subjectAccountId),
            subject_id: input.subjectAccountId,
            operator_id: input.operatorAccountId,
            reservation_id: input.reservationId,
            old_operator_id: input.expectedOperatorAccountId ?? '',
            version: input.expectedVersion,
            transaction_id: transactionId,
            deadline: bound,
          });
          requireAllowed(changed[0]);
          live(deadline);
          return {
            subjectAccountId: input.subjectAccountId,
            operatorAccountId: input.operatorAccountId,
            reservationId: input.reservationId,
            version: changed[0].version,
          };
        },
      );
    },
    /** Cancel a pending link, or confirm unlink/deletion, on the subject anchor.
     * A terminal slot makes a delayed link impossible. The coordinator must do
     * this BEFORE releasing the hold; absence of a relationship alone is unsafe.
     */
    async retireResponsibility(input: OperatorResponsibility & { key: string }) {
      input = { ...input };
      route(input.operatorAccountId);
      return execute(
        { anchor: input.subjectAccountId, kind: 'responsibility-retired', key: input.key, input },
        async (tx, transactionId) => {
          const subject = await account(tx, input.subjectAccountId);
          requireAllowed(
            !subject ||
              subject.operatorAccountId !== input.operatorAccountId ||
              subject.reservationId !== input.reservationId ||
              subject.state === 'deleted',
          );
          requireAllowed(
            (await retire.run(tx, {
              route: route(input.subjectAccountId),
              subject_id: input.subjectAccountId,
              reservation_id: input.reservationId,
              operator_id: input.operatorAccountId,
              transaction_id: transactionId,
            })) !== null,
          );
          return {
            operatorAccountId: input.operatorAccountId,
            subjectAccountId: input.subjectAccountId,
            reservationId: input.reservationId,
          };
        },
      );
    },
    /** Release only from permanent subject-local terminal evidence, never an
     * eventually consistent reverse scan or a timeout. The read ends before
     * operator checkout. Terminal slots can never be reopened by these commands.
     */
    async releaseResponsibility(input: OperatorResponsibility & { key: string }) {
      input = { ...input };
      const slot = await withConnection(pool, (client) =>
        slotRead.run(client, {
          route: route(input.subjectAccountId),
          subject_id: input.subjectAccountId,
          reservation_id: input.reservationId,
        }),
      );
      return execute(
        { anchor: input.operatorAccountId, kind: 'responsibility-released', key: input.key, input },
        async (tx) => {
          await locked(tx, input.operatorAccountId);
          requireAllowed(slot?.terminal && slot.operatorAccountId === input.operatorAccountId);
          requireAllowed(
            (await release.run(tx, {
              route: route(input.operatorAccountId),
              operator_id: input.operatorAccountId,
              subject_id: input.subjectAccountId,
              reservation_id: input.reservationId,
            })) !== null,
          );
          return {
            operatorAccountId: input.operatorAccountId,
            subjectAccountId: input.subjectAccountId,
            reservationId: input.reservationId,
          };
        },
      );
    },
    /** Bounded operator-local page for the later durable suspension fanout. It
     * includes pending reservations conservatively. It is not relation authority.
     */
    async responsibilityPage(input: { operatorAccountId: string; limit: number; after?: string }) {
      input = { ...input };
      requireAllowed(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100);
      if (input.after !== undefined) route(input.after);
      const rows = await withConnection(pool, (client) =>
        pageRead.run(client, {
          route: route(input.operatorAccountId),
          operator_id: input.operatorAccountId,
          after: input.after ?? '',
          limit: input.limit + 1,
        }),
      );
      const items = rows.slice(0, input.limit);
      return { items, next: rows.length > input.limit ? items.at(-1)!.reservationId : null };
    },
    /** Advisory local eligibility. The actual lifecycle tombstone rechecks holds
     * with the locked account and database guard, atomically with deletion.
     */
    async deletionEligibility(accountId: string) {
      return withConnection(pool, async (client) => {
        const current = await account(client, accountId);
        const safety = await safetyRead.run(client, { route: route(accountId), account_id: accountId });
        return {
          accountId,
          safe:
            !!current &&
            current.state !== 'deleted' &&
            !!safety &&
            !safety.held &&
            (current.kind !== 'organization' || !safety.owners),
        };
      });
    },
    async authorizeOpening(
      context: LifecycleRequest,
      input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose; key: string },
    ) {
      input = { ...input };
      context = request(context);
      const facts = await openingEvidence(context, input);
      return execute(
        {
          anchor: input.operatorAccountId,
          kind: 'opening-authorized',
          key: input.key,
          input: { ...input, managementAction },
          actor: context.actor,
          deadline: context.deadline,
        },
        async (tx, transactionId) => {
          await finalOpening(tx, context, input, facts);
          const receiptId = derivedId(NAMESPACE, `${transactionId}:opening`, route(input.operatorAccountId));
          const inserted = await openingInsert.run(tx, {
            ...receiptParameters(context, input, facts),
            receipt_id: receiptId,
            transaction_id: transactionId,
          });
          requireAllowed(inserted[0]);
          await finalOpening(tx, context, input, facts);
          return openingValue(context, input, facts, receiptId, inserted[0].expiresAt);
        },
      );
    },
    async consumeOpening(
      context: LifecycleRequest,
      input: {
        operatorAccountId: string;
        subjectAccountId: string;
        receiptId: string;
        purpose: OperatorPurpose;
        key: string;
      },
    ) {
      input = { ...input };
      route(input.receiptId);
      context = request(context);
      const facts = await openingEvidence(context, input);
      const outcome = await execute(
        {
          anchor: input.operatorAccountId,
          kind: 'opening-consumed',
          key: input.key,
          input: { ...input, managementAction },
          actor: context.actor,
          deadline: context.deadline,
        },
        async (tx, transactionId) => {
          await finalOpening(tx, context, input, facts);
          const consumed = await openingConsume.run(tx, {
            ...receiptParameters(context, input, facts),
            receipt_id: input.receiptId,
            transaction_id: transactionId,
          });
          requireAllowed(consumed[0]);
          await finalOpening(tx, context, input, facts);
          return openingValue(context, input, facts, input.receiptId, consumed[0].expiresAt);
        },
      );
      // A retry can observe the durable executor result but cannot mint a second
      // Auth issuance authorization. Lost acknowledgements fail closed. A later
      // Auth coordinator must bind its own issuance idempotency to this receipt.
      requireAllowed(!outcome.replayed);
      return outcome;
    },
  };
  function receiptParameters(
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose },
    facts: OpeningEvidence,
  ) {
    return {
      route: route(input.operatorAccountId),
      operator_id: input.operatorAccountId,
      subject_id: input.subjectAccountId,
      human_id: context.actor.accountId,
      purpose: input.purpose,
      action: managementAction,
      client_id: context.actor.clientId,
      scopes: [...context.actor.scopes],
      requested_by: context.actor.requestedBy ?? '',
      human_epoch: context.actor.authnEpoch,
      human_floor: facts.actualHuman.minimumAuthnEpoch.toString(),
      operator_floor: facts.operator.minimumAuthnEpoch,
      subject_floor: facts.subject.minimumAuthnEpoch,
      version: facts.subject.version,
      reservation_id: facts.subject.reservationId!,
      deadline: facts.databaseDeadline,
      membership_valid: facts.membershipValid,
    };
  }
  function openingValue(
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose },
    facts: OpeningEvidence,
    receiptId: string,
    expiresAt: string,
  ): OperatorOpening {
    return {
      operatorAccountId: input.operatorAccountId,
      subjectAccountId: input.subjectAccountId,
      reservationId: facts.subject.reservationId!,
      version: facts.subject.version,
      receiptId,
      actingHumanId: context.actor.accountId,
      purpose: input.purpose,
      clientId: context.actor.clientId,
      scopes: [...context.actor.scopes],
      requestedBy: context.actor.requestedBy,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}
