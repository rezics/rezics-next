import { accessClock } from './access-clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import { requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import type { CredentialEffectBinding } from '@rezics/auth-contract';
import { verifiedBearerExpiry } from './approved-identity.ts';
import credentialBind from './operator-opening-credential-bind.sql';
import credentialConsume from './operator-opening-credential-consume.sql';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  runCommand,
  currentCommand,
  authoritativeTimeValue,
  type CommandAuthorization,
  type CommandAttempt,
  type CommandOutcome,
  type CommandTransaction,
  type CommandEvent,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  accessCheck,
  type Access,
  type AccessClient,
  type AccessContext,
  type AccountActor,
  type Actor,
  type ActionCatalogue,
} from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';
import { actingCommandAccount, commandAccessContext } from './command-admission.ts';
import type { LifecycleRequest, OpeningManagement } from './lifecycle.ts';
import { createAccess as createPermissionAccess } from './permission.ts';
import { ACCESS_EVIDENCE_TTL_MS, accessEvidenceDeadline } from './evidence-deadline.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
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
import fenceSubject from './operator-fence-subject.sql';
import nativeFence from './lifecycle-fence.sql';
import { lifecycleExecutor } from './lifecycle-20261025094010-command.ts';

export const OPERATOR_RECEIPT_TTL_MS = 60_000;
const NAMESPACE = '134e9749-1120-8a0c-97d0-71287a629cef';
const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
export class OperatorDeniedError extends Error {
  readonly status = 403;

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
function roleDigest(catalogue: NonNullable<ReturnType<typeof resourceRoleCatalogue>>) {
  const byKey = (left: [string, unknown], right: [string, unknown]) => (left[0] < right[0] ? -1 : 1);
  return canonicalize([[...catalogue.roles].sort(byKey), [...catalogue.types].sort(byKey)]);
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
/** Who decides that the human is still current and whether that human manages the operator. */
type Evaluation = {
  access: Access;
  admit(actor: AccountActor, context: AccessContext): Promise<Account | null>;
};
const managements = new WeakMap<Access, OpeningManagement>();
/** The management decision installed with the operator commands built on this Access, if any. */
export function openingManagement(access: Access): OpeningManagement | undefined {
  return managements.get(access);
}
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
  /** Trusted kernel clock; defaults to the clock installed on Access. */
  clock?: KernelClock;
  /** Trusted shared token keys; required only for responsibility pages. */
  cursorKeys?: KeyRing;
};
type Mutation = {
  anchor: string;
  kind: string;
  key: string;
  input: unknown;
  actor?: AccountActor;
  deadline?: number;
  authorization?: CommandAuthorization;
  counterChanged?: boolean;
};
function executor(pool: Pool, clock: () => Date) {
  return async function execute<T>(
    options: Mutation,
    body: (tx: CommandTransaction, transactionId: string) => Promise<T>,
  ): Promise<CommandOutcome<T>> {
    requireAllowed(typeof options.key === 'string' && options.key.length > 0 && options.key.length <= 256);
    requireAllowed(!options.actor || options.authorization);
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
        clock,
        authorization: options.authorization,
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
        const events: CommandEvent[] = [
          { type: `com.rezics.access.operator.${options.kind}.v1`, subject: options.anchor, data: value },
        ];
        if (options.counterChanged)
          events.push({
            type: 'com.rezics.access.rating-counter.changed.v1',
            subject: options.anchor,
            data: { accountId: options.anchor, at: authoritativeTimeValue(currentCommand(tx).time) },
          });
        return {
          value,
          events,
        };
      },
    ).catch((error: unknown) => {
      // Preserve Access unavailability across the command executor boundary.
      throwAccessUnavailable(error);
      throw error;
    });
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
/** Route then id order is shared with lifecycle coordination so two steps that
 * lock an operator and a subject cannot deadlock with suspension.
 */
async function lockOrdered(client: AccessClient, ids: readonly string[]): Promise<Map<string, AccountRow>> {
  const ordered = [...new Set(ids)].sort((left, right) => {
    const delta = route(left) - route(right);
    return delta === 0 ? (left < right ? -1 : left > right ? 1 : 0) : delta;
  });
  const rows = new Map<string, AccountRow>();
  for (const id of ordered) rows.set(id, await locked(client, id));
  return rows;
}
function request(context: LifecycleRequest): LifecycleRequest {
  requireAllowed(context.actor.kind === 'account' && human(context.account, context.actor));
  requireAccessDeadline(context.deadline);
  requireAllowed(Number.isFinite(context.deadline));
  return {
    ...context,
    actor: Object.isFrozen(context.actor) ? context.actor : { ...context.actor, scopes: [...context.actor.scopes] },
    account: structuredClone(context.account),
  };
}
function live(deadline: number) {
  requireAccessDeadline(deadline);
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
  const clock = config.clock ?? accessClock(access);
  const execute = executor(pool, clock);
  const read = (id: string) => withConnection(pool, (client) => account(client, id));
  const authenticated: Evaluation = {
    access,
    admit: (actor, context) => actingCommandAccount(access, actor, context),
  };
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
    attempt: CommandAttempt,
    evaluation: Evaluation = authenticated,
  ) {
    requireAllowed(input.purpose === 'session' || input.purpose === 'credential-management');
    const deadline = context.deadline;
    try {
      // Independent reads finish before the management-resource checkout. The
      // supplied request evidence is required; consumption additionally refreshes
      // the human so a durable receipt never preserves a stale login observation.
      const preparation = commandAccessContext({ ...context, pool }, attempt);
      const actualHuman = await evaluation.admit(context.actor, preparation);
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
            at: authoritativeTimeValue(attempt.time),
          }),
        );
        requireAllowed(members.length === 1 && members[0]);
        membershipValid = members[0].valid;
      } else {
        requireAllowed(operator.kind === 'actor' && operator.accountId === context.actor.accountId);
      }
      const permissionContext = Object.assign(preparation, { account: actualHuman });
      const allowed = await accessCheck(
        evaluation.access,
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
    } catch (error) {
      throwAccessUnavailable(error, deadline);
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
  // A bearer is not at hand when an opened session reduces its own consent. The opening recorded its principal,
  // so the same evidence and the same final check run with the shared permission evaluator over the mounted
  // action catalogue and that principal's account row. Realm group roles have no reader here and deny.
  let restored: Evaluation | undefined;
  function restoredEvaluation(): Evaluation {
    if (restored) return restored;
    const native = createPermissionAccess({
      actions: new Map([...config.actions, ['gate:any', { anonymous: false }]]),
      accountEvidence: (_actor, context) => context.account,
      clock,
    });
    // A role catalogue that differs from the mounted one would decide differently, so it decides nothing.
    const mounted = resourceRoleCatalogue(access);
    const own = resourceRoleCatalogue(native);
    requireAllowed(!mounted || (own && roleDigest(mounted) === roleDigest(own)));
    return (restored = {
      access: native,
      admit: (actor) => readAccount(pool, route(actor.accountId), actor.accountId),
    });
  }
  const proofs = new WeakMap<
    object,
    {
      attempt: CommandAttempt;
      context: LifecycleRequest;
      input: { operatorAccountId: string; subjectAccountId: string };
      facts: OpeningEvidence;
    }
  >();
  const management: OpeningManagement = {
    async prepare(attempt, opening) {
      requireAllowed(opening.action === managementAction);
      const context = {
        actor: opening.principal,
        deadline: accessEvidenceDeadline(deadlineFor(ACCESS_EVIDENCE_TTL_MS)),
      };
      const input = {
        operatorAccountId: opening.operatorAccountId,
        subjectAccountId: opening.subjectAccountId,
        purpose: 'session' as const,
      };
      const facts = await openingEvidence(context, input, attempt, restoredEvaluation());
      const proof = Object.freeze({});
      proofs.set(proof, { attempt, context, input, facts });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (typeof proof === 'object' && proof !== null) proofs.delete(proof);
      requireAllowed(prepared && prepared.attempt === attempt);
      await finalOpening(tx, prepared.context, prepared.input, prepared.facts);
    },
  };
  managements.set(access, management);
  async function responsibilityPage(
    input: { operatorAccountId: string; limit?: number; cursor?: string },
    viewer: Actor = { kind: 'anonymous' },
    work = false,
  ) {
    input = { ...input };
    const limit = input.limit === undefined ? 20 : input.limit;
    requireAllowed(Number.isInteger(limit) && limit >= 1 && limit <= 100);
    const operatorRoute = route(input.operatorAccountId);
    const ring = config.cursorKeys;
    requireAllowed(ring);
    // Even an empty page fails closed if the active token key is unavailable.
    const tokenKey = ring.keys.get(ring.current);
    requireAllowed(
      Number.isInteger(ring.current) &&
        ring.current >= 0 &&
        ring.current <= 255 &&
        tokenKey &&
        tokenKey.byteLength >= 32,
    );
    const workBinding = {
      operation: 'access.operator.responsibility.list',
      parameters: { operatorAccountId: input.operatorAccountId, purpose: 'operator', sort: 'reservationId:asc' },
    };
    const binding = {
      // This internal list has no HTTP route; use its fixed feed identity.
      route: workBinding.operation,
      viewer: viewer.kind === 'account' ? viewer.accountId : null,
      query: { ...workBinding.parameters, limit },
    };
    const now = clock();
    let after = '';
    let cursorEpoch: number | undefined;
    if (input.cursor !== undefined) {
      const decoded = work
        ? decodeCursor(ring, workBinding, input.cursor)
        : await decodeListCursor(ring, binding, input.cursor, now);
      requireAllowed(decoded.ok);
      requireAllowed(decoded.after.length === 1 && typeof decoded.after[0] === 'string');
      after = decoded.after[0];
      route(after);
      cursorEpoch = decoded.epoch;
    }
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const partition = await readPartition(client, partitionOf(operatorRoute));
        requireAllowed(partition && (cursorEpoch === undefined || cursorEpoch === partition.epoch));
        const rows = await pageRead.run(client, {
          route: operatorRoute,
          operator_id: input.operatorAccountId,
          after,
          limit: limit + 1,
        });
        const operators = rows.slice(0, limit);
        const next =
          rows.length > limit
            ? work
              ? encodeCursor(ring, workBinding, { epoch: partition.epoch, after: [operators.at(-1)!.reservationId] })
              : await encodeListCursor(
                  ring,
                  binding,
                  { epoch: partition.epoch, after: [operators.at(-1)!.reservationId] },
                  now,
                )
            : null;
        await client.query('COMMIT');
        return { operators, next };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    });
  }
  return {
    /** Committed mechanical work only. Lock relation and slot with the account,
     * then use the native fence mutation in that same subject transaction. */
    async fenceOperatedSubject(input: OperatorResponsibility & { key: string }) {
      input = structuredClone(input);
      const subjectRoute = route(input.subjectAccountId);
      return lifecycleExecutor(pool, clock)(
        {
          route: subjectRoute,
          id: input.subjectAccountId,
          kind: 'operator.subject-fenced',
          key: input.key,
          input,
        },
        async (tx, transactionId) => {
          const related = await fenceSubject.run(tx, {
            route: subjectRoute,
            subject_id: input.subjectAccountId,
            operator_id: input.operatorAccountId,
            reservation_id: input.reservationId,
          });
          if (!related) return { accountId: input.subjectAccountId, fenced: false, receiptId: null };
          const receiptId = derivedId(NAMESPACE, `${transactionId}:fence`, subjectRoute);
          const receipt = await nativeFence.run(tx, {
            at: authoritativeTimeValue(currentCommand(tx).time),
            route: subjectRoute,
            account_id: input.subjectAccountId,
            receipt_id: receiptId,
            tombstone: false,
            kind: 'fence',
            prior_operator_id: '',
            transaction_id: transactionId,
          });
          requireAllowed(receipt[0]);
          return { accountId: input.subjectAccountId, fenced: true, receiptId };
        },
      );
    },
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
      const deadline = accessEvidenceDeadline(deadlineFor(ACCESS_EVIDENCE_TTL_MS));
      const held = await reservation(input);
      const operator = await read(input.operatorAccountId);
      const bound = operator ? databaseDeadline(operator, deadline) : '';
      return execute(
        { anchor: input.subjectAccountId, kind: 'relation-recorded', key: input.key, input, counterChanged: true },
        async (tx, transactionId) => {
          live(deadline);
          // The responsibility row is on the operator. Lock that account with the
          // subject and require the operator to still be active before writing.
          const rows = await lockOrdered(tx, [input.operatorAccountId, input.subjectAccountId]);
          const currentOperator = rows.get(input.operatorAccountId);
          const subject = rows.get(input.subjectAccountId);
          const currentHeld = await reservationRead.run(tx, {
            route: route(input.operatorAccountId),
            operator_id: input.operatorAccountId,
            reservation_id: input.reservationId,
          });
          requireAllowed(
            held?.subjectAccountId === input.subjectAccountId &&
              eligible(operator) &&
              currentHeld?.subjectAccountId === input.subjectAccountId &&
              eligible(currentOperator ?? null) &&
              subject,
          );
          requireAllowed(subject);
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
            at: authoritativeTimeValue(currentCommand(tx).time),
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
            at: authoritativeTimeValue(currentCommand(tx).time),
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
          const operator = await locked(tx, input.operatorAccountId);
          requireAllowed(operator.state === 'active');
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
    /** Bounded operator-local observation, including pending reservations; not relation authority.
     * Trusted composition supplies the authenticated viewer, never a request body's viewer id.
     */
    responsibilityPage: (input: { operatorAccountId: string; limit?: number; cursor?: string }, viewer?: Actor) =>
      responsibilityPage(input, viewer),
    /** Internal fanout work cursors stay on the seal and never reach a list reader. */
    responsibilityWorkPage: (input: { operatorAccountId: string; limit?: number; cursor?: string }) =>
      responsibilityPage(input, undefined, true),
    /** Advisory local eligibility. The actual lifecycle tombstone rechecks holds
     * with the locked account and database guard, atomically with deletion.
     */
    async deletionEligibility(accountId: string) {
      return withConnection(pool, async (client) => {
        const current = await account(client, accountId);
        const safety = await safetyRead.run(client, {
          route: route(accountId),
          account_id: accountId,
          at: clock().toISOString(),
        });
        return {
          accountId,
          safe:
            !!current &&
            current.state === 'active' &&
            !!safety &&
            !safety.held &&
            (current.kind !== 'organization' || !safety.owners),
        };
      });
    },
    /** Authorization replay returns the original receipt after checking current
     * authority. Only session issuance or the bound credential effect consumes it.
     */
    async authorizeOpening(
      context: LifecycleRequest,
      input: {
        operatorAccountId: string;
        subjectAccountId: string;
        purpose: OperatorPurpose;
        key: string;
        credential?: CredentialEffectBinding;
      },
    ) {
      input = structuredClone(input);
      context = request(context);
      if (input.credential)
        requireAllowed(
          input.purpose === 'credential-management' &&
            input.credential.subjectAccountId === input.subjectAccountId &&
            input.credential.actingHumanId === context.actor.accountId &&
            input.credential.clientId === context.actor.clientId &&
            canonicalize(input.credential.scopes) === canonicalize(context.actor.scopes),
        );
      const prepared = openingAuthorization(context, input);
      return execute(
        {
          anchor: input.operatorAccountId,
          kind: 'opening-authorized',
          key: input.key,
          input: { ...input, managementAction },
          actor: context.actor,
          deadline: context.deadline,
          authorization: prepared.authorization,
        },
        async (tx, transactionId) => {
          const facts = prepared.facts();
          await finalOpening(tx, context, input, facts);
          const receiptId = derivedId(NAMESPACE, `${transactionId}:opening`, route(input.operatorAccountId));
          const inserted = await openingInsert.run(tx, {
            ...receiptParameters(tx, context, input, facts),
            receipt_id: receiptId,
            transaction_id: transactionId,
          });
          requireAllowed(inserted[0]);
          await finalOpening(tx, context, input, facts);
          let expiresAt = inserted[0].expiresAt;
          if (input.credential) {
            const bound = await credentialBind.run(tx, {
              route: route(input.operatorAccountId),
              operator_id: input.operatorAccountId,
              receipt_id: receiptId,
              ...credentialParameters(input.credential),
              at: authoritativeTimeValue(currentCommand(tx).time),
              expires_at: new Date(
                Math.min(
                  verifiedBearerExpiry(access, context.actor, { pool, deadline: context.deadline }),
                  Date.parse(authoritativeTimeValue(currentCommand(tx).time)) + OPERATOR_RECEIPT_TTL_MS,
                ),
              ).toISOString(),
            });
            requireAllowed(bound[0]);
            expiresAt = bound[0].expiresAt;
          }
          return openingValue(context, input, facts, receiptId, expiresAt);
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
        credential?: CredentialEffectBinding;
      },
    ) {
      input = input.credential ? structuredClone(input) : { ...input };
      route(input.receiptId);
      context = request(context);
      const prepared = openingAuthorization(context, input);
      const outcome = await execute(
        {
          anchor: input.operatorAccountId,
          kind: 'opening-consumed',
          key: input.key,
          input: { ...input, managementAction },
          actor: context.actor,
          deadline: context.deadline,
          authorization: prepared.authorization,
        },
        async (tx, transactionId) => {
          const facts = prepared.facts();
          await finalOpening(tx, context, input, facts);
          const consumed = await (input.credential ? credentialConsume : openingConsume).run(tx, {
            ...credentialParameters(input.credential),
            ...receiptParameters(tx, context, input, facts),
            receipt_id: input.receiptId,
            transaction_id: transactionId,
          });
          requireAllowed(consumed[0]);
          await finalOpening(tx, context, input, facts);
          return openingValue(context, input, facts, input.receiptId, consumed[0].expiresAt);
        },
      );
      // Consumption replay cannot authorize another Auth issuance. Lost issuance
      // acknowledgements fail closed; opening authorization remains replayable.
      requireAllowed(!outcome.replayed);
      return outcome;
    },
  };
  function openingAuthorization(
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose },
  ) {
    let current: OpeningEvidence | undefined;
    const proofs = new WeakMap<object, { attempt: CommandAttempt; facts: OpeningEvidence }>();
    const authorization: CommandAuthorization = {
      action: managementAction,
      resource: { route: route(input.operatorAccountId), id: input.operatorAccountId },
      denied: () => new OperatorDeniedError(),
      async prepare(attempt) {
        current = undefined;
        const facts = await openingEvidence(context, input, attempt);
        const proof = Object.freeze({});
        proofs.set(proof, { attempt, facts });
        return proof;
      },
      async authorize(tx, attempt, proof) {
        const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
        if (typeof proof === 'object' && proof !== null) proofs.delete(proof);
        requireAllowed(prepared && prepared.attempt === attempt);
        await finalOpening(tx, context, input, prepared.facts);
        current = prepared.facts;
        return 'execute';
      },
    };
    return {
      authorization,
      facts() {
        requireAllowed(current);
        return current;
      },
    };
  }
  function receiptParameters(
    tx: CommandTransaction,
    context: LifecycleRequest,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: OperatorPurpose },
    facts: OpeningEvidence,
  ) {
    return {
      at: authoritativeTimeValue(currentCommand(tx).time),
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

function credentialParameters(binding?: CredentialEffectBinding) {
  return {
    credential_purpose: binding?.purpose ?? '',
    operation_key: binding?.operationKey ?? '',
    effect_reference: binding?.effectReference ?? '',
    effect_digest: binding?.effectDigest ?? '',
  };
}
