import {
  admitBenefitAcquisition,
  lockBenefitAcquisition,
  recordAcquisitionDisposition,
  verifiedAcquisitionRelease,
} from './acquisition.ts';
import { readCommerceMoneyPolicy, validateOfferAmount, type CommerceMoneyPolicy } from './money.ts';
import {
  captureCurrentContentEdition,
  isContentEditionUnavailable,
  requireCurrentContentEdition,
  requireMechanicalContentEdition,
  sameCapturedContentEdition,
  withoutUnverifiedBenefit,
} from './benefit.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  IdempotencyConflictError,
  principalCommandIdentity,
  hasOwnCommandCompletion,
  normalizeCommandKey,
  noEffect,
  runCommand,
  type CommandEvent,
  type CommandAuthorization,
  type CommandAttempt,
  type AuthoritativeTime,
  type CommandTransaction,
  type CommandOutcome,
  type PrincipalCommandReceipt,
} from '../command/command.ts';
import { accessCommandAuthorization, type Actor } from '../request/access.ts';
import type { Access } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { offerParentAnchor, platformRootAnchor } from './catalogue.ts';
import { declareCommerceCommandHistory } from './erasure-history.ts';
import {
  STRIPE_API_VERSION,
  type CheckoutRequest,
  type CheckoutSession,
  type CheckoutSnapshot,
  type Offer,
  type Order,
} from './model.ts';
import { assertCheckoutEvidence, assertTransactionBound, decideCheckout } from './settlement.ts';
import * as store from './store.ts';
import { appendCheckoutMoneyObservations } from './money-observation.ts';
import metadataUpdate from './store-checkout-metadata.sql';
import offerCreated from './command-offer-created.sql';
import checkoutCount from './command-checkout-count.sql';
import checkoutRecord from './command-checkout-record.sql';
import checkoutCreate from './command-checkout-create.sql';
import creationRead from './creation-attempt-read.sql';
import creationInsert from './creation-attempt-insert.sql';
import creationRetry from './creation-attempt-retry.sql';
import {
  creationRetryUntil,
  type CheckoutCreationAdmission,
  type CheckoutCreationAttempt,
} from './creation-attempt.ts';

export class OfferUnavailableError extends Error {
  constructor() {
    super('The offer is delisted');
    this.name = 'OfferUnavailableError';
  }
}
export class OfferRevisionConflictError extends Error {
  constructor() {
    super('The displayed offer terms have changed');
    this.name = 'OfferRevisionConflictError';
  }
}
class Unchanged extends Error {}
class CompletedRefresh extends Error {}
class SupersededRefresh extends Error {}
const unchanged = { changed: false } as const;
const WORK_STEP_DEADLINE_MS = 5_000;
export type CheckoutOutcome =
  | { session: CheckoutSession }
  | { kind: 'unknown' }
  | { kind: 'failed'; creationAttemptId?: string };
export type OfferInput = Pick<Offer, 'title' | 'currency' | 'unitAmountMinor' | 'taxCode'> & {
  /** Optional only for old trusted callers/receipt replays. A fresh create must select an edition. */
  contentEditionId?: string;
  /** Old receipt identity only; fresh requests cannot select or relabel a subject. */
  targetSubjectId?: string;
};

/** Trusted native port input, never a client operation or buyer permission. */
export type CheckoutRefreshInput = Readonly<{ orderId: string; sessionId: string; workflowId: string }>;
/** Committed admission metadata; neither permission nor durable provider truth. */
export type CheckoutRefreshClaim = Readonly<{ order: Order; workflowId: string; attemptId: string }>;
export type CheckoutRefreshAdmission =
  | { kind: 'completed' }
  | { kind: 'claimed'; command: CommandOutcome<CheckoutRefreshClaim> };
export type CheckoutRefreshApplication =
  | { changed: false; superseded?: true }
  | (CommandOutcome<Extract<store.AppliedCheckoutDecision, { changed: true }>> & { changed: true });

/** Stable identity for a trusted durable-work step; this module performs no workflows. */
export function stepCommandKey(workflowId: string, step: string): string {
  return `${workflowId}:${step}`;
}
function digest(input: unknown) {
  return createHash('sha256').update(canonicalize(input)!).digest();
}
function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new GrantDeniedError();
  return value;
}
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}
function key(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw new TypeError('Invalid idempotency key');
  return value;
}
function updated(orderId: string, revision: number): CommandEvent {
  return { type: 'com.rezics.commerce.order.updated.v1', subject: orderId, data: { orderId, revision } };
}

/** Compose internal preparation without replacing any parent authorization or
 * creation registry proof. Each opaque handle belongs to exactly one physical
 * attempt; retries run both preparations again with no resource client held.
 */
function withSalePreparation<T>(
  parent: CommandAuthorization,
  read: (attempt: CommandAttempt, deadline: number) => Promise<T>,
) {
  type Prepared = {
    attempt: CommandAttempt;
    parentEvidence: unknown;
    deadline: number;
    result: { value: T } | { error: unknown };
  };
  const proofs = new WeakMap<object, Prepared>();
  const admitted = new WeakMap<CommandTransaction, Prepared>();
  const authorization: CommandAuthorization = {
    ...parent,
    async prepare(attempt) {
      const parentEvidence = await parent.prepare?.(attempt);
      // Content has its own native read T. This bounded result is neither a
      // cross-home simultaneous snapshot nor authority for final byte delivery.
      const deadline = Math.min(Date.now() + 1_000, deadlineFor(1_000));
      let result: Prepared['result'];
      try {
        result = { value: await read(attempt, deadline) };
      } catch (error) {
        // Only fresh sale failures are delayed past normal authorization/receipt.
        // An authorized exact replay must not depend on today's target availability.
        if (!isContentEditionUnavailable(error) && !(error instanceof GrantDeniedError)) throw error;
        result = { error };
      }
      const proof = Object.freeze({});
      proofs.set(proof, { attempt, parentEvidence, deadline, result });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (!prepared || prepared.attempt !== attempt) throw parent.denied();
      proofs.delete(proof as object);
      const mode = await parent.authorize(tx, attempt, prepared.parentEvidence);
      admitted.set(tx, prepared);
      return mode;
    },
    async finalize(tx, attempt) {
      const prepared = admitted.get(tx);
      if (!prepared || prepared.attempt !== attempt) throw parent.denied();
      await parent.finalize?.(tx, attempt, prepared.parentEvidence);
      admitted.delete(tx);
    },
  };
  return {
    authorization,
    at(tx: CommandTransaction, time: AuthoritativeTime): T {
      const prepared = admitted.get(tx);
      if (!prepared || prepared.attempt.time !== time) throw parent.denied();
      if ('error' in prepared.result) throw prepared.result.error;
      requireAccessDeadline(prepared.deadline);
      return prepared.result.value;
    },
    deadlineAt(tx: CommandTransaction, time: AuthoritativeTime): number {
      const prepared = admitted.get(tx);
      if (!prepared || prepared.attempt.time !== time) throw parent.denied();
      return prepared.deadline;
    },
  };
}

/** Actor arguments are verified Access identities. Checkout methods are trusted
 * internal ports, not client operations: their receipts are attributed to the buyer.
 */
export function createCommerceCommands(config: {
  pool: Pool;
  access: Access;
  royaltyBasisPoints?: number;
  moneyPolicy?: CommerceMoneyPolicy;
}) {
  const { pool, access } = config;
  const moneyPolicy = config.moneyPolicy ?? readCommerceMoneyPolicy(process.env);
  const royaltyBasisPoints = config.royaltyBasisPoints ?? 9000;
  // Never written to a receipt or workflow result. Only this physical invocation's
  // committed admission may reach a provider call, once and inside its sale lifetime.
  const liveCreations = new WeakMap<CheckoutCreationAdmission, { orderId: string; deadline: number }>();
  if (!Number.isInteger(royaltyBasisPoints) || royaltyBasisPoints < 0 || royaltyBasisPoints > 10000)
    throw new RangeError('Invalid configured royalty rate');
  // Access's request identity has bounded cached account evidence. On commands
  // already anchored at the actor account, verify its current floor before any
  // receipt lookup without consulting a second partition or connection.
  function accountAuthorization(actor: Actor, authorization: CommandAuthorization): CommandAuthorization {
    const owner = account(actor);
    return {
      ...authorization,
      async authorize(tx, attempt, evidence) {
        const current = await readAccount(tx, route(owner.accountId), owner.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
        )
          throw new GrantDeniedError();
        await shareAccount(tx, owner.accountId);
        return authorization.authorize(tx, attempt, evidence);
      },
    };
  }
  const context = () => ({ pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) });
  function options(actor: Actor, r: number, kind: string, requestKey: string, input: unknown) {
    const identity = principalCommandIdentity(account(actor));
    return {
      ...identity,
      partition: partitionOf(r),
      deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
      receipt: { kind, key: key(requestKey), digest: digest([identity, kind, input]) },
    };
  }
  async function createOffer(actor: Actor, body: OfferInput, requestKey: string) {
    const seller = account(actor);
    const r = route(seller.accountId),
      id = newId(r),
      resource = { route: r, id };
    // Copy only seller-controlled fields; the royalty comes exclusively from service configuration.
    const input: OfferInput = {
      ...(body.contentEditionId === undefined ? {} : { contentEditionId: body.contentEditionId }),
      ...(body.targetSubjectId === undefined ? {} : { targetSubjectId: body.targetSubjectId }),
      title: body.title,
      currency: body.currency,
      unitAmountMinor: body.unitAmountMinor,
      taxCode: body.taxCode,
    };
    if (
      (input.contentEditionId !== undefined && routeOf(input.contentEditionId) === null) ||
      (input.targetSubjectId !== undefined && routeOf(input.targetSubjectId) === null) ||
      !input.title.trim() ||
      !/^[a-z]{3}$/.test(input.currency) ||
      !Number.isSafeInteger(input.unitAmountMinor) ||
      input.unitAmountMinor <= 0 ||
      !input.taxCode
    )
      throw new TypeError('Invalid offer');
    let insertedTransactionId: string | undefined;
    const authorization = parentCreationAuthorization({
      access,
      actor,
      action: 'offer:create',
      parent: platformRootAnchor,
      context: {
        ...context(),
        resource,
        creation: {
          async validate(tx, target, time) {
            if (!insertedTransactionId) return false;
            const rows = await offerCreated.run(tx, {
              route: target.route,
              id: target.id,
              creator: seller.accountId,
              transaction_id: insertedTransactionId,
              at: authoritativeTimeValue(time),
            });
            return rows !== null;
          },
        },
      },
    });
    const sale = withSalePreparation(accountAuthorization(actor, authorization), async (_attempt, deadline) =>
      captureCurrentContentEdition(input.contentEditionId ?? '', { pool, access }, { actor, deadline }),
    );
    return runCommand(
      pool,
      {
        ...options(actor, r, 'commerce.offer.create', requestKey, input),
        authorization: sale.authorization,
      },
      async (tx, command) => {
        // Replay is already resolved. Legacy subject-only creates may replay, never mint a benefit.
        const contentEdition = sale.at(tx, command.time);
        if (
          contentEdition.creatorAccountId !== seller.accountId ||
          contentEdition.benefit.resource.id !== input.contentEditionId ||
          (input.targetSubjectId !== undefined && input.targetSubjectId !== contentEdition.targetSubjectId)
        )
          throw new GrantDeniedError();
        await declareCommerceCommandHistory(tx, 'commerce.offer.create', { creatorAccountId: seller.accountId });
        const offer = await store.insertOffer(
          tx,
          r,
          {
            ...input,
            ...validateOfferAmount({ currency: input.currency, amountMinor: input.unitAmountMinor }, moneyPolicy),
            targetSubjectId: contentEdition.targetSubjectId,
            contentEdition,
            id,
            creatorAccountId: seller.accountId,
            royaltyBasisPoints,
          },
          { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
        );
        insertedTransactionId = command.transactionId;
        await initializeResourceGrants(tx, { resource, type: 'commerce.offer', creator: seller.accountId });
        return {
          value: offer,
          events: [{ type: 'com.rezics.commerce.offer.created.v1', subject: id, data: { offerId: id } }],
        };
      },
    );
  }
  async function delistOffer(actor: Actor, id: string, requestKey: string, expectedRevision?: number) {
    validateExpectedRevision(expectedRevision);
    const r = route(id);
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      'offer:manage',
      { route: r, id },
      context(),
      () => new GrantDeniedError(),
    );
    return runCommand(
      pool,
      {
        ...options(actor, r, 'commerce.offer.delist', requestKey, {
          id,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        }),
        authorization,
      },
      async (tx, command) => {
        const offer = await store.lockOffer(tx, r, id);
        if (!offer) throw new GrantDeniedError();
        if (expectedRevision !== undefined && offer.revision !== expectedRevision)
          throw new OfferRevisionConflictError();
        await declareCommerceCommandHistory(tx, 'commerce.offer.delist', offer);
        const value = await store.setOfferState(tx, r, id, 'delisted', {
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
        });
        return {
          value,
          events: [{ type: 'com.rezics.commerce.offer.delisted.v1', subject: id, data: { offerId: id } }],
        };
      },
    );
  }
  // Existing trusted native callers may omit the precondition; seller HTTP always requires it.
  function validateExpectedRevision(revision: number | undefined) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new TypeError('Invalid expected offer revision');
  }
  async function reviseOffer(
    actor: Actor,
    id: string,
    body: Pick<Offer, 'unitAmountMinor'> & { expectedRevision?: number },
    requestKey: string,
  ) {
    validateExpectedRevision(body.expectedRevision);
    const r = route(id);
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      'offer:manage',
      { route: r, id },
      context(),
      () => new GrantDeniedError(),
    );
    const input = {
      offerId: id,
      unitAmountMinor: body.unitAmountMinor,
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
    };
    if (!Number.isSafeInteger(input.unitAmountMinor) || input.unitAmountMinor <= 0)
      throw new TypeError('Invalid offer');
    return runCommand(
      pool,
      {
        ...options(actor, r, 'commerce.offer.revise', requestKey, input),
        authorization,
      },
      async (tx, command) => {
        const current = await store.lockOffer(tx, r, id);
        if (!current) throw new GrantDeniedError();
        if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
          throw new OfferRevisionConflictError();
        if (current.state !== 'active') throw new OfferUnavailableError();
        const money = validateOfferAmount(
          { currency: current.currency, amountMinor: input.unitAmountMinor },
          moneyPolicy,
        );
        await declareCommerceCommandHistory(tx, 'commerce.offer.revise', current);
        const value = await store.reviseOfferPrice(tx, r, id, input.unitAmountMinor, money, {
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
        });
        if (!value) throw new GrantDeniedError();
        if (value.state !== 'active') throw new OfferUnavailableError();
        return {
          value,
          events: [{ type: 'com.rezics.commerce.offer.revised.v1', subject: id, data: { offerId: id } }],
        };
      },
    );
  }
  async function createOrder(actor: Actor, offerId: string, expectedOfferRevision: number, requestKey: string) {
    const buyer = account(actor),
      r = route(buyer.accountId),
      id = newId(r);
    route(offerId);
    if (!Number.isSafeInteger(expectedOfferRevision) || expectedOfferRevision < 1)
      throw new TypeError('Invalid expected offer revision');
    // Every actual attempt gets fresh parent/account evidence at its own T.
    function admission() {
      const parent = offerParentAnchor(offerId);
      const authorization = accountAuthorization(
        actor,
        parentCreationAuthorization({
          access,
          actor,
          action: 'order:create',
          parent,
          context: {
            ...context(),
            resource: { route: r, id },
            creation: {
              async validate() {
                return false;
              },
            },
          },
        }),
      );
      return { parent, authorization };
    }
    const { parent, authorization } = admission();
    const sale = withSalePreparation(authorization, async (attempt, deadline) => {
      const offer = parent.at(attempt.time);
      return requireCurrentContentEdition(offer.contentEdition, { pool, access }, { actor, deadline });
    });
    try {
      return await runCommand(
        pool,
        {
          ...options(actor, r, 'commerce.order.create', requestKey, { offerId, expectedOfferRevision }),
          authorization: sale.authorization,
        },
        async (tx, command) => {
          const offer = parent.at(command.time);
          if (!parent.availableAt(command.time) || offer.state !== 'active') throw new OfferUnavailableError();
          // The command body runs only after current authorization and exact receipt replay.
          if (offer.revision !== expectedOfferRevision) throw new OfferRevisionConflictError();
          let money;
          try {
            money = validateOfferAmount({ currency: offer.currency, amountMinor: offer.unitAmountMinor }, moneyPolicy);
          } catch (error) {
            if (error instanceof RangeError) throw new OfferUnavailableError();
            throw error;
          }
          if (
            offer.taxBehavior !== money.taxBehavior ||
            !offer.moneyUnit ||
            offer.moneyUnit.system !== money.moneyUnit.system ||
            offer.moneyUnit.exponent !== money.moneyUnit.exponent ||
            offer.moneyUnit.factsVersion !== money.moneyUnit.factsVersion
          )
            throw new OfferUnavailableError();
          const contentEdition = sale.at(tx, command.time);
          if (
            !sameCapturedContentEdition(offer.contentEdition, contentEdition) ||
            offer.creatorAccountId !== contentEdition.creatorAccountId ||
            offer.targetSubjectId !== contentEdition.targetSubjectId
          )
            throw new GrantDeniedError();
          await admitBenefitAcquisition(tx, buyer, id, contentEdition);
          await declareCommerceCommandHistory(tx, 'commerce.order.create', {
            creatorAccountId: offer.creatorAccountId,
            buyerAccountId: buyer.accountId,
          });
          const order = await store.insertOrder(
            tx,
            r,
            { id, buyerAccountId: buyer.accountId, offer },
            { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
          );
          return {
            value: order,
            events: [{ type: 'com.rezics.commerce.order.created.v1', subject: id, data: { orderId: id } }],
          };
        },
      );
    } catch (error) {
      if (!(error instanceof IdempotencyConflictError)) throw error;
      const legacy = admission().authorization;
      const replay = await runCommand<Order>(
        pool,
        {
          ...options(actor, r, 'commerce.order.create', requestKey, { offerId }),
          authorization: {
            ...legacy,
            async authorize(tx, attempt, evidence) {
              // Retain the full current policy, then remove fresh execution capability.
              await legacy.authorize(tx, attempt, evidence);
              return 'receipt-only';
            },
            // Only Core's missing-receipt branch uses this denial. Current policy
            // failures still propagate from the normal authorization above.
            denied: () => error,
          },
        },
        async () => {
          // Defensive only: Core must never invoke a receipt-only business body.
          throw error;
        },
      );
      // The historical digest did not bind consent to a revision. Check the
      // actual immutable native response before returning it to any caller.
      if (replay.value.offerId !== offerId || replay.value.offerRevision !== expectedOfferRevision) throw error;
      return replay;
    }
  }
  // Both trusted creation ports fence the current buyer before receipt lookup and hold
  // the one order lock only through native work. No permission snapshot reaches Stripe.
  function creationAuthorization(order: Order): CommandAuthorization {
    return {
      action: 'commerce.checkout.create',
      resource: { route: route(order.id), id: order.id },
      denied: () => new GrantDeniedError(),
      async authorize(tx) {
        await shareAccount(tx, order.buyerAccountId);
        const current = await store.lockOrder(tx, route(order.id), order.id);
        if (!current || current.buyerAccountId !== order.buyerAccountId) throw new GrantDeniedError();
        return 'execute';
      },
    };
  }
  async function beginCheckoutCreation(
    id: string,
    configuration: Pick<CheckoutRequest, 'successUrl' | 'cancelUrl' | 'managedPayments'>,
  ): Promise<CheckoutCreationAdmission> {
    const r = route(id);
    const order = await store.readOrder(pool, r, id);
    if (!order) throw new GrantDeniedError();
    const attemptId = Bun.randomUUIDv7();
    const physical = new Map<string, number>();
    const sale = withSalePreparation(creationAuthorization(order), async (_attempt, deadline) => {
      const current = await store.readOrder(pool, r, id);
      if (!current || current.buyerAccountId !== order.buyerAccountId) throw new GrantDeniedError();
      return {
        order: current,
        contentEdition: await requireMechanicalContentEdition(current.contentEdition, { pool, access }, { deadline }),
      };
    });
    const result = await runCommand<CheckoutCreationAdmission>(
      pool,
      {
        partition: partitionOf(r),
        deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
        authorization: sale.authorization,
        receipt: {
          actorAccountId: order.buyerAccountId,
          kind: 'commerce.checkout.create',
          key: attemptId,
          digest: digest({ id }),
        },
      },
      async (tx, command) => {
        const current = await store.readOrder(tx, r, id);
        if (!current) throw new GrantDeniedError();
        const observedAt = authoritativeTimeValue(command.time);
        const done = (value: CheckoutCreationAdmission) => noEffect(value);
        if (current.checkoutSessionId || current.settlement === 'paid' || current.settlement === 'failed')
          return done({ kind: 'finished' });
        const stored = await creationRead.run(tx, { route: r, id });
        // Pre-migration uncertainty has no trustworthy request/first-call evidence. Never guess it.
        if (!stored && current.settlement === 'unknown') return done({ kind: 'unknown' });
        if (!stored && (!current.moneyUnit || current.taxBehavior !== 'exclusive')) return done({ kind: 'unknown' });
        // Released current native target authority is indispensable before any fresh provider call.
        const prepared = sale.at(tx, command.time);
        if (
          current.revision !== prepared.order.revision ||
          current.buyerAccountId !== prepared.order.buyerAccountId ||
          current.creatorAccountId !== prepared.contentEdition.creatorAccountId ||
          current.targetSubjectId !== prepared.contentEdition.targetSubjectId ||
          !sameCapturedContentEdition(current.contentEdition, prepared.contentEdition)
        )
          throw new CommandUnavailableError('contention', partitionOf(r));
        // An existing first call always retains its original parameters, even after configuration changes.
        const request: CheckoutRequest = stored?.request
          ? JSON.parse(stored.request)
          : {
              ...(!stored
                ? {
                    moneyUnit: current.moneyUnit,
                    taxBehavior: current.taxBehavior,
                    apiVersion: STRIPE_API_VERSION,
                  }
                : {}),
              orderId: id,
              buyerAccountId: current.buyerAccountId,
              title: current.title,
              currency: current.currency,
              unitAmountMinor: current.unitAmountMinor,
              taxCode: current.taxCode,
              successUrl: stored?.successUrl ?? configuration.successUrl,
              cancelUrl: stored?.cancelUrl ?? configuration.cancelUrl,
              expiresAt: stored ? Number(stored.expiresAt) : Math.floor(Date.parse(current.createdAt) / 1000) + 3600,
              managedPayments: stored?.managedPayments ?? configuration.managedPayments ?? false,
            };
        const attempt: CheckoutCreationAttempt = {
          firstAttemptId: stored?.firstAttemptId ?? attemptId,
          firstAttemptAt: stored?.firstAttemptAt ?? observedAt,
          providerKey: stored?.providerKey ?? `order:${id}`,
          request,
          retried: stored?.retried ?? false,
        };
        if (Math.max(Date.now(), Date.parse(observedAt)) >= creationRetryUntil(attempt))
          return done({ kind: stored ? 'unknown' : 'failed' });
        if (!stored) {
          await creationInsert.run(tx, {
            route: r,
            id,
            attempt_id: attemptId,
            at: observedAt,
            provider_key: attempt.providerKey,
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
            expires_at: request.expiresAt,
            managed_payments: request.managedPayments ?? false,
            request: JSON.stringify(request),
            money_unit: JSON.stringify(request.moneyUnit),
            tax_behavior: request.taxBehavior!,
            api_version: request.apiVersion!,
          });
        } else if (!stored.retried) await creationRetry.run(tx, { route: r, id });
        const changed = await checkoutCreate.run(tx, {
          route: r,
          id,
          revision: current.revision,
          at: observedAt,
          transaction_id: command.transactionId,
        });
        if (!changed) throw new RangeError('Commerce order revision exhausted');
        const admission: CheckoutCreationAdmission = { kind: 'ready', attempt, first: !stored, observedAt };
        physical.clear();
        physical.set(command.transactionId, sale.deadlineAt(tx, command.time));
        return {
          value: admission,
          events: [updated(id, changed.revision)],
        };
      },
    );
    // runCommand normalizes fresh responses through receipt JSON. Attach the
    // nonserialized lifetime only after commit, using this exact transaction's
    // in-memory record; historical receipt responses never acquire admission.
    const deadline = physical.get(result.transactionId);
    if (!result.replayed && result.value.kind === 'ready' && deadline !== undefined)
      liveCreations.set(result.value, { orderId: id, deadline });
    return result.value;
  }
  function consumeCheckoutCreationAdmission(id: string, admission: CheckoutCreationAdmission): void {
    const live = liveCreations.get(admission);
    liveCreations.delete(admission);
    if (!live || live.orderId !== id || admission.kind !== 'ready') throw new GrantDeniedError();
    requireAccessDeadline(live.deadline);
  }
  async function recordCheckout(id: string, body: CheckoutOutcome) {
    const r = routeOf(id);
    if (r === null) return unchanged;
    const outcome = structuredClone(body);
    const prefix = `order:${id}:checkout:`;
    // A competing outcome can win this numbered receipt. Re-read its sequence
    // after a digest conflict; runCommand itself handles serialization retries.
    // Recording also consumes the enclosing physical/request budget when there is one.
    const deadline = Date.now() + WORK_STEP_DEADLINE_MS;
    const expiresAt = Math.min(deadline, deadlineFor(20_000));
    while (Date.now() < expiresAt) {
      const order = await store.readOrder(pool, r, id);
      if (!order || order.checkoutSessionId !== null || order.settlement === 'failed' || order.settlement === 'paid')
        return unchanged;
      const counts = await checkoutCount.run(
        { query: pool.query.bind(pool) },
        {
          partition: partitionOf(r),
          buyer: order.buyerAccountId,
          idempotency_keys: [0, 1].flatMap((n) =>
            nativeReceiptKeyCandidates(pool, 'commerce.checkout.record', order.buyerAccountId, `${prefix}${n}`),
          ),
        },
      );
      try {
        return await runCommand(
          pool,
          {
            partition: partitionOf(r),
            deadline: expiresAt,
            authorization: creationAuthorization(order),
            receipt: {
              actorAccountId: order.buyerAccountId,
              kind: 'commerce.checkout.record',
              key: `${prefix}${counts.count}`,
              digest: digest(outcome),
            },
          },
          async (tx, command) => {
            const current = await store.readOrder(tx, r, id);
            if (
              !current ||
              current.checkoutSessionId !== null ||
              current.settlement === 'failed' ||
              current.settlement === 'paid'
            )
              throw new Unchanged();
            const session = 'session' in outcome ? outcome.session : null;
            const settlement = session ? 'pending' : (outcome as { kind: 'failed' | 'unknown' }).kind;
            if (!session && settlement === 'failed') {
              const attempt = await creationRead.run(tx, { route: r, id });
              const evidence = 'creationAttemptId' in outcome ? outcome.creationAttemptId : undefined;
              if (
                current.settlement === 'unknown' ||
                (attempt && (evidence !== attempt.firstAttemptId || attempt.retried))
              )
                throw new Unchanged();
            }
            if (!session && settlement === current.settlement) throw new Unchanged();
            const rows = await checkoutRecord.run(tx, {
              route: r,
              id,
              revision: current.revision,
              session_id: session?.id ?? '',
              url: session?.url ?? '',
              expires_at: session?.expiresAt ?? '',
              settlement,
              at: authoritativeTimeValue(command.time),
              transaction_id: command.transactionId,
            });
            if (!rows) throw new Unchanged();
            const value = {
              ...current,
              settlement,
              checkoutSessionId: session?.id ?? null,
              checkoutUrl: session?.url ?? null,
              checkoutExpiresAt: session ? new Date(session.expiresAt).toISOString() : null,
              revision: rows.revision,
            };
            if (!session && settlement === 'failed' && 'creationAttemptId' in outcome) {
              const attempt = await creationRead.run(tx, { route: r, id });
              if (
                attempt &&
                outcome.creationAttemptId === attempt.firstAttemptId &&
                !attempt.retried &&
                current.settlement === 'pending'
              )
                await recordAcquisitionDisposition(tx, value, 'no-creation');
            }
            return { value, events: [updated(id, value.revision)] };
          },
        );
      } catch (error) {
        if (error instanceof Unchanged) return unchanged;
        if (!(error instanceof IdempotencyConflictError)) throw error;
      }
    }
    throw new CommandUnavailableError('deadline', partitionOf(r));
  }
  // The trusted internal apply port is restricted to one recorded order/Session/intent.
  // Buyer attribution names its receipt owner, not an AccountActor or an Access grant.
  // Omitting legacy command basis deliberately retains null service attribution.
  async function buyerBenefits(tx: CommandTransaction, accountId: string): Promise<boolean> {
    try {
      await shareAccount(tx, accountId);
      return true;
    } catch (error) {
      if (!(error instanceof LifecycleDeniedError)) throw error;
      return false;
    }
  }
  function refreshAuthorization(
    order: Order,
    sessionId: string,
    intent: PrincipalCommandReceipt,
    admission = false,
  ): CommandAuthorization {
    const r = route(order.id);
    const expectedDigest = digest({ orderId: order.id });
    return {
      action: 'commerce.checkout.apply',
      resource: { route: r, id: order.id },
      denied: () => new GrantDeniedError(),
      async authorize(tx) {
        if (intent.kind !== 'commerce.checkout.apply' || !Buffer.from(intent.digest).equals(expectedDigest))
          throw new GrantDeniedError();
        // Apply admission verifies immutable service binding without taking the order
        // lock. Receipt replay cannot create a fresh benefit or revision claim.
        // Begin-refresh retains its exact lock through own-completion lookup and claim.
        if (admission) await buyerBenefits(tx, order.buyerAccountId);
        const current = admission ? await store.lockOrder(tx, r, order.id) : await store.readOrder(tx, r, order.id);
        if (!current || current.buyerAccountId !== order.buyerAccountId || current.checkoutSessionId !== sessionId)
          throw new GrantDeniedError();
        return 'execute';
      },
    };
  }
  function applyIntent(order: Order, workflowId: string): PrincipalCommandReceipt {
    return {
      kind: 'commerce.checkout.apply',
      key: normalizeCommandKey({ kind: 'account', id: order.buyerAccountId }, stepCommandKey(workflowId, 'apply')),
      digest: digest({ orderId: order.id }),
    };
  }
  async function beginCheckoutRefresh(input: CheckoutRefreshInput): Promise<CheckoutRefreshAdmission> {
    const { orderId, sessionId, workflowId } = input;
    const attemptId = Bun.randomUUIDv7(); // Stable only within this physical invocation's native retries.
    const r = route(orderId);
    const order = await store.readOrder(pool, r, orderId);
    if (!order || !sessionId || order.checkoutSessionId !== sessionId) throw new GrantDeniedError();
    const intent = applyIntent(order, workflowId);
    try {
      const command = await runCommand<CheckoutRefreshClaim>(
        pool,
        {
          partition: partitionOf(r),
          authorization: refreshAuthorization(order, sessionId, intent, true),
          receipt: {
            actorAccountId: order.buyerAccountId,
            kind: 'commerce.checkout.refresh',
            key: attemptId,
            digest: digest({
              orderId,
              sessionId,
              intent: { ...intent, digest: Buffer.from(intent.digest).toString('hex') },
            }),
          },
        },
        async (tx, command) => {
          // authorize already acquired the exact order lock; it remains held through commit.
          if (await hasOwnCommandCompletion(tx, intent)) throw new CompletedRefresh();
          const current = await store.readOrder(tx, r, orderId);
          if (!current) throw new GrantDeniedError();
          const claimed = await store.claimOrderRefresh(tx, r, current, {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          });
          return { value: { order: claimed, workflowId, attemptId }, events: [updated(orderId, claimed.revision)] };
        },
      );
      // No authority escapes if native commit acknowledgement fails; abandon that invocation.
      return { kind: 'claimed', command };
    } catch (error) {
      if (error instanceof CompletedRefresh) return { kind: 'completed' };
      throw error;
    }
  }
  /** Legacy trusted split-read apply; terminal benefits share the native fence. */
  function applyCheckoutSnapshot(body: CheckoutSnapshot, workflowId: string) {
    return applySnapshot(body, workflowId);
  }
  /** New trusted native port: use only bytes read after this invocation's committed admission. */
  function applyClaimedCheckoutSnapshot(
    body: CheckoutSnapshot,
    claim: CheckoutRefreshClaim,
  ): Promise<CheckoutRefreshApplication> {
    return applySnapshot(body, claim.workflowId, structuredClone(claim));
  }
  async function applySnapshot(body: CheckoutSnapshot, workflowId: string, claim?: CheckoutRefreshClaim) {
    assertTransactionBound(body.transactions);
    const snapshot = structuredClone(body),
      id = snapshot.clientReferenceId;
    if (
      claim &&
      (id !== claim.order.id || snapshot.sessionId !== claim.order.checkoutSessionId || snapshot.metadataOrderId !== id)
    )
      throw new GrantDeniedError();
    const r = id === null ? null : routeOf(id);
    if (r === null || id === null) return unchanged;
    const order = await store.readOrder(pool, r, id);
    if (!order || order.checkoutSessionId !== snapshot.sessionId) return unchanged;
    const intent = claim
      ? applyIntent(claim.order, workflowId)
      : {
          kind: 'commerce.checkout.apply',
          key: key(stepCommandKey(workflowId, 'apply')),
          digest: digest({ orderId: id }),
        };
    const authorization = refreshAuthorization(claim?.order ?? order, snapshot.sessionId, intent);
    // Provider evidence was already read on released connections. A missing target
    // forbids only new/restored benefit; financial truth and revocation still apply.
    const sale = withSalePreparation(authorization, async (_attempt, deadline) => {
      const current = await store.readOrder(pool, r, id);
      if (!current || current.buyerAccountId !== order.buyerAccountId) throw new GrantDeniedError();
      try {
        return {
          order: current,
          contentEdition: await requireMechanicalContentEdition(current.contentEdition, { pool, access }, { deadline }),
        };
      } catch (error) {
        if (!isContentEditionUnavailable(error)) throw error;
        return null;
      }
    });
    try {
      const result = await runCommand(
        pool,
        {
          partition: partitionOf(r),
          authorization: sale.authorization,
          receipt: {
            actorAccountId: order.buyerAccountId,
            ...intent,
          },
        },
        async (tx, command) => {
          // Fresh application fences the buyer before the first order lock, even
          // for a business no-op. Availability failures must roll back all money effects.
          const permitsBenefits = await buyerBenefits(tx, order.buyerAccountId);
          if (permitsBenefits) await lockBenefitAcquisition(tx, order);
          const locked = await store.lockOrder(tx, r, id);
          if (!locked || locked.checkoutSessionId !== snapshot.sessionId) throw new Unchanged();
          if (claim && locked.revision !== claim.order.revision) throw new SupersededRefresh();
          const state = await store.readSettlementState(
            tx,
            r,
            id,
            snapshot.transactions.map((t) => t.id),
          );
          if (!state || state.order.checkoutSessionId !== snapshot.sessionId) throw new Unchanged();
          // Receipt replay and claim fencing precede evidence validation. Unavailable evidence rolls back
          // this apply, retaining the committed admission and durable work's retry/reconciliation debt.
          assertCheckoutEvidence(snapshot, state.order.settlement === 'paid' || snapshot.paymentStatus === 'paid');
          let decision = decideCheckout(state, snapshot, claim ? 'admitted-revision' : 'legacy-time');
          if (
            decision.changed &&
            !permitsBenefits &&
            (decision.entitlement.kind === 'grant' || decision.entitlement.kind === 'restore')
          ) {
            // Terminal buyers retain financial truth, never a new private benefit.
            // Recompute change detection after removing only the benefit effect.
            decision =
              decision.settlement === state.order.settlement && decision.newTransactions.length === 0
                ? { changed: false }
                : { ...decision, entitlement: { kind: 'none' } };
          }
          let verified = false;
          try {
            const prepared = sale.at(tx, command.time);
            const current = prepared?.contentEdition;
            verified =
              prepared !== null &&
              current !== undefined &&
              state.order.revision === prepared.order.revision &&
              state.order.buyerAccountId === prepared.order.buyerAccountId &&
              state.order.creatorAccountId === current.creatorAccountId &&
              state.order.targetSubjectId === current.targetSubjectId &&
              sameCapturedContentEdition(state.order.contentEdition, current) &&
              (!state.entitlement ||
                (state.entitlement.accountId === state.order.buyerAccountId &&
                  state.entitlement.orderId === state.order.id &&
                  state.entitlement.offerId === state.order.offerId &&
                  state.entitlement.targetSubjectId === state.order.targetSubjectId &&
                  sameCapturedContentEdition(state.entitlement.contentEdition, current)));
          } catch (error) {
            if (!isContentEditionUnavailable(error)) throw error;
          }
          if (!verified) decision = withoutUnverifiedBenefit(decision);
          if (
            decision.changed &&
            decision.entitlement.kind === 'none' &&
            decision.settlement === state.order.settlement &&
            decision.newTransactions.length === 0
          )
            decision = { changed: false };
          if (
            !claim &&
            state.order.observedAt !== null &&
            Date.parse(snapshot.observedAt) < Date.parse(state.order.observedAt)
          )
            throw new Unchanged();
          const businessChanged = decision.changed;
          let applied: Extract<store.AppliedCheckoutDecision, { changed: true }>;
          if (decision.changed) {
            const result = await store.applyCheckoutDecision(tx, r, state, decision, {
              transactionId: command.transactionId,
              time: authoritativeTimeValue(command.time),
              newEntitlementId: newId(r),
              amountTaxMinor: snapshot.amountTaxMinor,
            });
            if (!result.changed) throw new Unchanged();
            applied = result;
          } else {
            applied = {
              changed: true,
              order: state.order,
              entitlement: state.entitlement,
              entitlementAction: { kind: 'none' },
              newTransactions: [],
            };
          }
          const dispositionChanged = await recordAcquisitionDisposition(
            tx,
            applied.order,
            verifiedAcquisitionRelease(applied.order, snapshot),
          );
          const observations = permitsBenefits
            ? await appendCheckoutMoneyObservations(tx, r, applied.order, snapshot, {
                transactionId: command.transactionId,
                time: authoritativeTimeValue(command.time),
              })
            : [];
          if (!businessChanged) {
            if (!observations.length && !dispositionChanged) throw new Unchanged();
            const row = await metadataUpdate.run(tx, {
              route: r,
              id,
              revision: state.order.revision,
              observed_at: snapshot.observedAt,
              at: authoritativeTimeValue(command.time),
              transaction_id: command.transactionId,
            });
            if (!row) throw new SupersededRefresh();
            applied = {
              ...applied,
              order: { ...applied.order, revision: row.revision, observedAt: snapshot.observedAt },
              moneyMetadataChanged: true,
            };
          }
          const events: CommandEvent[] = [updated(id, applied.order.revision)];
          if (observations.length)
            events.push({
              type: 'com.rezics.commerce.money.observed.v1',
              subject: id,
              data: { orderId: id, transactionIds: [...new Set(snapshot.transactions.map((t) => t.id))] },
            });
          if (applied.newTransactions.length)
            events.push({
              type: 'com.rezics.commerce.transactions.recorded.v1',
              subject: id,
              data: {
                orderId: id,
                creatorAccountId: order.creatorAccountId,
                transactionIds: applied.newTransactions.map((t) => t.id),
              },
            });
          const action = applied.entitlementAction;
          if (action.kind !== 'none') {
            const name = action.kind === 'grant' ? 'granted' : action.kind === 'restore' ? 'restored' : 'revoked';
            events.push({
              type: `com.rezics.commerce.entitlement.${name}.v1`,
              subject: applied.entitlement!.id,
              data: {
                entitlementId: applied.entitlement!.id,
                orderId: id,
                ...('reason' in action ? { reason: action.reason } : {}),
              },
            });
          }
          return { value: applied, events };
        },
      );
      return { ...result, changed: true as const };
    } catch (error) {
      if (error instanceof Unchanged) return unchanged;
      if (error instanceof SupersededRefresh) return { changed: false, superseded: true } as const;
      throw error;
    }
  }
  async function readOffer(id: string) {
    const r = routeOf(id);
    return r === null ? null : store.readOffer(pool, r, id);
  }
  async function privateAccountReadable(accountId: string) {
    const r = routeOf(accountId);
    if (r === null) return false;
    const current = await readAccount({ query: pool.query.bind(pool) }, r, accountId);
    return current !== null && current.state !== 'deleted';
  }
  async function readOrderForAccount(accountId: string, id: string) {
    if (!(await privateAccountReadable(accountId))) return null;
    const r = routeOf(accountId);
    if (r === null || routeOf(id) !== r) return null;
    const order = await store.readOrder(pool, r, id);
    return order?.buyerAccountId === accountId ? order : null;
  }
  async function readEntitlementForAccount(accountId: string, id: string) {
    if (!(await privateAccountReadable(accountId))) return null;
    const r = routeOf(accountId);
    if (r === null || routeOf(id) !== r) return null;
    const entitlement = await store.readEntitlement(pool, r, id);
    return entitlement?.accountId === accountId ? entitlement : null;
  }
  async function listEntitlementsForAccount(accountId: string, page: { after: string | null; limit: number }) {
    if (!(await privateAccountReadable(accountId))) return [];
    const r = routeOf(accountId);
    return r === null ? [] : store.listEntitlements(pool, r, accountId, page);
  }
  return {
    createOffer,
    delistOffer,
    reviseOffer,
    createOrder,
    recordCheckout,
    beginCheckoutCreation,
    consumeCheckoutCreationAdmission,
    applyCheckoutSnapshot,
    beginCheckoutRefresh,
    applyClaimedCheckoutSnapshot,
    readOffer,
    readOrderForAccount,
    readEntitlementForAccount,
    listEntitlementsForAccount,
  };
}
