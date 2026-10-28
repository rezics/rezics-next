import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandEvent,
  type CommandAuthorization,
} from '../command/command.ts';
import { accessCommandAuthorization, type Actor } from '../request/access.ts';
import type { Access } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { offerParentAnchor, platformRootAnchor } from './catalogue.ts';
import type { CheckoutSession, CheckoutSnapshot, Offer } from './model.ts';
import { assertTransactionBound, decideCheckout } from './settlement.ts';
import * as store from './store.ts';
import offerCreated from './command-offer-created.sql';
import checkoutCount from './command-checkout-count.sql';
import checkoutRecord from './command-checkout-record.sql';

export class OfferUnavailableError extends Error {
  constructor() {
    super('The offer is delisted');
    this.name = 'OfferUnavailableError';
  }
}
class Unchanged extends Error {}
const unchanged = { changed: false } as const;
const WORK_STEP_DEADLINE_MS = 5_000;
export type CheckoutOutcome = { session: CheckoutSession } | { kind: 'failed' | 'unknown' };
export type OfferInput = Pick<Offer, 'targetSubjectId' | 'title' | 'currency' | 'unitAmountMinor' | 'taxCode'>;

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

/** Actor arguments are verified Access identities. Checkout methods are trusted
 * internal ports, not client operations: their receipts are attributed to the buyer.
 */
export function createCommerceCommands(config: { pool: Pool; access: Access; royaltyBasisPoints?: number }) {
  const { pool, access } = config;
  const royaltyBasisPoints = config.royaltyBasisPoints ?? 9000;
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
      targetSubjectId: body.targetSubjectId,
      title: body.title,
      currency: body.currency,
      unitAmountMinor: body.unitAmountMinor,
      taxCode: body.taxCode,
    };
    if (
      routeOf(input.targetSubjectId) === null ||
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
    return runCommand(
      pool,
      {
        ...options(actor, r, 'commerce.offer.create', requestKey, input),
        authorization: accountAuthorization(actor, authorization),
      },
      async (tx, command) => {
        const offer = await store.insertOffer(
          tx,
          r,
          { ...input, id, creatorAccountId: seller.accountId, royaltyBasisPoints },
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
  async function delistOffer(actor: Actor, id: string, requestKey: string) {
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
      { ...options(actor, r, 'commerce.offer.delist', requestKey, { id }), authorization },
      async (tx, command) => {
        const offer = await store.readOffer(tx, r, id);
        if (!offer) throw new GrantDeniedError();
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
  async function reviseOffer(actor: Actor, id: string, body: Pick<Offer, 'unitAmountMinor'>, requestKey: string) {
    const r = route(id);
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      'offer:manage',
      { route: r, id },
      context(),
      () => new GrantDeniedError(),
    );
    const input = { offerId: id, unitAmountMinor: body.unitAmountMinor };
    if (!Number.isSafeInteger(input.unitAmountMinor) || input.unitAmountMinor <= 0)
      throw new TypeError('Invalid offer');
    return runCommand(
      pool,
      { ...options(actor, r, 'commerce.offer.revise', requestKey, input), authorization },
      async (tx, command) => {
        const value = await store.reviseOfferPrice(tx, r, id, input.unitAmountMinor, {
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
  async function createOrder(actor: Actor, offerId: string, requestKey: string) {
    const buyer = account(actor),
      r = route(buyer.accountId),
      id = newId(r);
    route(offerId);
    const parent = offerParentAnchor(offerId);
    const authorization = parentCreationAuthorization({
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
    });
    return runCommand(
      pool,
      {
        ...options(actor, r, 'commerce.order.create', requestKey, { offerId }),
        authorization: accountAuthorization(actor, authorization),
      },
      async (tx, command) => {
        const offer = parent.at(command.time);
        if (offer.state !== 'active') throw new OfferUnavailableError();
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
  }
  async function recordCheckout(id: string, body: CheckoutOutcome) {
    const r = routeOf(id);
    if (r === null) return unchanged;
    const outcome = structuredClone(body);
    const prefix = `order:${id}:checkout:`;
    // A competing outcome can win this numbered receipt. Re-read its sequence
    // after a digest conflict; runCommand itself handles serialization retries.
    // Stripe has already created or refused the session, so recording uses a fresh work budget.
    const deadline = Date.now() + WORK_STEP_DEADLINE_MS;
    while (Date.now() < deadline) {
      const order = await store.readOrder(pool, r, id);
      if (!order || order.checkoutSessionId !== null || order.settlement === 'failed' || order.settlement === 'paid')
        return unchanged;
      const counts = await checkoutCount.run(
        { query: pool.query.bind(pool) },
        {
          partition: partitionOf(r),
          buyer: order.buyerAccountId,
          prefix,
          end: `${prefix}z`,
        },
      );
      try {
        return await runCommand(
          pool,
          {
            partition: partitionOf(r),
            deadline,
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
  async function applyCheckoutSnapshot(body: CheckoutSnapshot, workflowId: string) {
    assertTransactionBound(body.transactions);
    const snapshot = structuredClone(body),
      id = snapshot.clientReferenceId;
    const r = id === null ? null : routeOf(id);
    if (r === null || id === null) return unchanged;
    const order = await store.readOrder(pool, r, id);
    if (!order || order.checkoutSessionId !== snapshot.sessionId) return unchanged;
    try {
      const result = await runCommand(
        pool,
        {
          partition: partitionOf(r),
          receipt: {
            actorAccountId: order.buyerAccountId,
            kind: 'commerce.checkout.apply',
            key: key(stepCommandKey(workflowId, 'apply')),
            digest: digest({ orderId: id }),
          },
        },
        async (tx, command) => {
          const state = await store.readSettlementState(
            tx,
            r,
            id,
            snapshot.transactions.map((t) => t.id),
          );
          if (!state || state.order.checkoutSessionId !== snapshot.sessionId) throw new Unchanged();
          const decision = decideCheckout(state, snapshot);
          if (!decision.changed) throw new Unchanged();
          const applied = await store.applyCheckoutDecision(tx, r, state, decision, {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
            newEntitlementId: newId(r),
            amountTaxMinor: snapshot.amountTaxMinor,
          });
          if (!applied.changed) throw new Unchanged();
          const events: CommandEvent[] = [updated(id, applied.order.revision)];
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
      throw error;
    }
  }
  async function readOffer(id: string) {
    const r = routeOf(id);
    return r === null ? null : store.readOffer(pool, r, id);
  }
  async function readOrderForAccount(accountId: string, id: string) {
    const r = routeOf(accountId);
    if (r === null || routeOf(id) !== r) return null;
    const order = await store.readOrder(pool, r, id);
    return order?.buyerAccountId === accountId ? order : null;
  }
  async function readEntitlementForAccount(accountId: string, id: string) {
    const r = routeOf(accountId);
    if (r === null || routeOf(id) !== r) return null;
    const entitlement = await store.readEntitlement(pool, r, id);
    return entitlement?.accountId === accountId ? entitlement : null;
  }
  async function listEntitlementsForAccount(accountId: string, page: { after: string | null; limit: number }) {
    const r = routeOf(accountId);
    return r === null ? [] : store.listEntitlements(pool, r, accountId, page);
  }
  return {
    createOffer,
    delistOffer,
    reviseOffer,
    createOrder,
    recordCheckout,
    applyCheckoutSnapshot,
    readOffer,
    readOrderForAccount,
    readEntitlementForAccount,
    listEntitlementsForAccount,
  };
}
