import Stripe from 'stripe';
import { stripeEvidenceMoneyUnit, type StripeMoneyProvenance } from './money.ts';
import { deadlineFor } from '../request/deadline.ts';
import { stripeTransport } from './stripe-transport.ts';
import { assertCheckoutEvidence, assertTransactionBound, CheckoutMismatchError } from './settlement.ts';
import {
  MAX_ORDER_TRANSACTIONS,
  STRIPE_API_VERSION,
  StripeRejectedError,
  StripeUnavailableError,
  type CheckoutLocator,
  type CheckoutSnapshot,
  type StripeCheckoutLocatorPort,
  type StripePort,
  type StripeTransaction,
  type TransactionKind,
} from './model.ts';

export type StripePortConfig = {
  apiKey: string;
  managedPayments: boolean;
  accountNamespace?: string;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
  timeoutMs?: number;
  maxNetworkRetries?: number;
  /** Attempt/process cancellation; never used as authority for native mutation. */
  signal?: AbortSignal;
  clock: () => Date;
};

function expanded<T>(value: string | T | null | undefined): T | null {
  if (value === undefined || typeof value === 'string')
    throw new StripeUnavailableError('Stripe omitted a requested expansion');
  return value;
}

function known<T extends string>(value: string | null, supported: readonly T[], field = 'Checkout'): T {
  const match = supported.find((status) => status === value);
  if (match === undefined) throw new StripeUnavailableError(`Stripe returned an unsupported ${field} status`);
  return match;
}

/** Reasons contain only local vocabulary, never provider diagnostic text or payloads. */
function evidence(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new StripeUnavailableError(`Stripe ${reason}`);
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

function validId(value: string, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}

function minor(value: number | null | undefined, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function currency(value: string | null): value is string {
  return typeof value === 'string' && /^[a-z]{3}$/.test(value);
}

// https://docs.stripe.com/api/balance_transactions/object: preserve Stripe's settlement amounts, fees and FX rate.
function transaction(
  balance: Stripe.BalanceTransaction,
  kind: TransactionKind,
  sourceId: string,
  provenance: StripeMoneyProvenance,
): StripeTransaction {
  evidence(
    balance.object === 'balance_transaction' &&
      validId(balance.id, 'txn_') &&
      idOf(balance.source) === sourceId &&
      currency(balance.currency) &&
      Number.isSafeInteger(balance.amount) &&
      Number.isSafeInteger(balance.fee) &&
      Number.isSafeInteger(balance.net) &&
      balance.net === balance.amount - balance.fee &&
      (balance.exchange_rate === null || (Number.isFinite(balance.exchange_rate) && balance.exchange_rate > 0)) &&
      minor(balance.created) &&
      Array.isArray(balance.fee_details) &&
      balance.fee_details.every((fee) => fee.currency === balance.currency && Number.isSafeInteger(fee.amount)),
    'balance transaction association or amounts are inconsistent',
  );
  return {
    moneyUnit: stripeEvidenceMoneyUnit(balance.currency, 'balance_transaction'),
    providerApiVersion: provenance.responseApiVersion ?? provenance.requestApiVersion,
    moneyProvenance: provenance,
    id: balance.id,
    kind,
    sourceId,
    currency: balance.currency,
    amountMinor: balance.amount,
    feeMinor: balance.fee,
    netMinor: balance.net,
    feeDetails: balance.fee_details.map((fee) => ({
      type: fee.type,
      amountMinor: fee.amount,
      description: fee.description,
    })),
    exchangeRate: balance.exchange_rate,
    created: new Date(balance.created * 1000).toISOString(),
  };
}

// https://docs.stripe.com/api/refunds/list and https://docs.stripe.com/api/disputes/list:
// payment_intent filters and starting_after cursors bound each read to one payment, with a hard object cap.
async function boundedList<T extends { id: string }>(
  maximum: number,
  read: (limit: number, after: string | undefined) => Promise<Stripe.ApiList<T>>,
  onPage?: (page: Stripe.ApiList<T>) => void,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const limit = maximum - items.length;
    const page = await read(limit, after);
    onPage?.(page);
    evidence(
      page.object === 'list' &&
        typeof page.has_more === 'boolean' &&
        Array.isArray(page.data) &&
        page.data.length <= limit,
      'pagination completeness is unavailable',
    );
    for (const item of page.data) {
      evidence(typeof item?.id === 'string' && item.id.length > 0, 'pagination object identity is unavailable');
      if (seen.has(item.id)) throw new StripeUnavailableError('Stripe pagination repeated an object');
      seen.add(item.id);
      items.push(item);
    }
    if (items.length > maximum || (page.has_more && items.length === maximum)) {
      throw new StripeUnavailableError('Stripe object limit exceeded');
    }
    if (!page.has_more) return items;
    if (!page.data.length) throw new StripeUnavailableError('Stripe pagination did not advance');
    after = items.at(-1)!.id;
  }
}

/** Expanded objects inherit the actual response that carried them, including each list page. */
function responseApiVersion(value: unknown): string | null {
  const version = (value as { lastResponse?: { apiVersion?: string } }).lastResponse?.apiVersion;
  return typeof version === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/.test(version) ? version : null;
}

export function createStripePort(config: StripePortConfig): StripePort & StripeCheckoutLocatorPort {
  const timeoutMs = config.timeoutMs ?? 20_000;
  const retries = config.maxNetworkRetries ?? 2;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20_000 ||
    !Number.isSafeInteger(retries) ||
    retries < 0 ||
    retries > 2
  ) {
    throw new StripeUnavailableError('Stripe transport configuration is unavailable');
  }

  async function call<T>(requests: number, input: unknown, operation: (stripe: Stripe) => Promise<T>): Promise<T> {
    try {
      const remainingMs = Math.min(timeoutMs, deadlineFor(timeoutMs) - Date.now());
      if (remainingMs <= 0) throw new StripeUnavailableError('Stripe request deadline expired');
      const signal = config.signal;
      const transport = stripeTransport({
        timeoutMs: remainingMs,
        retries,
        requests,
        ...(signal === undefined ? {} : { signal }),
      });
      return await transport.run(async () => {
        transport.inspectInput({ input, apiKey: config.apiKey, host: config.host });
        // One SDK instance binds the supported fetch hook to this physical operation, including retries/pages.
        const stripe = new Stripe(config.apiKey, {
          apiVersion: STRIPE_API_VERSION,
          ...(config.host === undefined ? {} : { host: config.host }),
          ...(config.port === undefined ? {} : { port: config.port }),
          ...(config.protocol === undefined ? {} : { protocol: config.protocol }),
          timeout: remainingMs,
          maxNetworkRetries: retries,
          httpClient: Stripe.createFetchHttpClient(transport.fetch),
        });
        return operation(stripe);
      });
    } catch (error) {
      // https://docs.stripe.com/api/errors; stripe-node esm/Error.js maps HTTP errors to these classes.
      // Fixed messages also prevent Stripe's diagnostic text (or connection causes) from leaking credentials.
      if (
        (error instanceof Stripe.errors.StripeInvalidRequestError && error.code !== 'idempotency_key_in_use') ||
        error instanceof Stripe.errors.StripeCardError
      ) {
        throw new StripeRejectedError('Stripe rejected the request');
      }
      if (error instanceof StripeUnavailableError || error instanceof CheckoutMismatchError) throw error;
      throw new StripeUnavailableError('Stripe request outcome is unavailable');
    }
  }

  const managedPayments = config.managedPayments;
  return {
    managedPayments,
    createCheckoutSession(request, idempotencyKey) {
      return call(1, { request, idempotencyKey }, async (stripe) => {
        // https://docs.stripe.com/api/checkout/sessions/create: inline price_data, one item, order correlation.
        const params: Stripe.Checkout.SessionCreateParams = {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                ...(request.taxBehavior === 'exclusive' ? { tax_behavior: request.taxBehavior } : {}),
                currency: request.currency,
                unit_amount: request.unitAmountMinor,
                product_data: { name: request.title, tax_code: request.taxCode },
              },
            },
          ],
          client_reference_id: request.orderId,
          metadata: { order_id: request.orderId, account_id: request.buyerAccountId },
          payment_intent_data: { metadata: { order_id: request.orderId } },
          expires_at: request.expiresAt,
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          // https://docs.stripe.com/payments/managed-payments
          // https://docs.stripe.com/payments/managed-payments/how-it-works
          // https://docs.stripe.com/payments/managed-payments/eligibility
          // Managed Payments handles indirect taxes for approved digital sellers and eligible product tax codes.
          // https://docs.stripe.com/changelog/dahlia/2026-04-22/managed-payments (2026-04-22.dahlia)
          // The installed SDK types include managed_payments; other accounts use the ADR's automatic-tax fallback.
          ...((request.managedPayments ?? managedPayments)
            ? { managed_payments: { enabled: true } }
            : { automatic_tax: { enabled: true } }),
        };
        // https://docs.stripe.com/api/idempotent_requests: Stripe retains the first result for this exact request key.
        const session = await stripe.checkout.sessions.create(params, {
          idempotencyKey,
          ...(request.apiVersion ? { apiVersion: request.apiVersion } : {}),
        });
        if (!session.url) throw new StripeUnavailableError('Stripe returned no Checkout URL');
        return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
      });
    },

    readCheckoutLocator(sessionId): Promise<CheckoutLocator> {
      return call(1, sessionId, async (stripe) => {
        // https://docs.stripe.com/api/checkout/sessions/retrieve: one logical GET, no expansions or child reads.
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_intent !== null && typeof session.payment_intent !== 'string') {
          throw new StripeUnavailableError('Stripe unexpectedly expanded the Checkout PaymentIntent');
        }
        return {
          sessionId: session.id,
          clientReferenceId: session.client_reference_id,
          metadataOrderId: session.metadata?.order_id ?? null,
          livemode: session.livemode,
          mode: known(session.mode, ['payment', 'setup', 'subscription']),
          paymentIntentId: session.payment_intent,
        };
      });
    },

    readCheckout(sessionId) {
      return call(111, sessionId, async (stripe) => {
        // https://docs.stripe.com/api/checkout/sessions/object: completion and payment status are independent.
        // https://docs.stripe.com/api/payment_intents/object: latest_charge is expandable and may be null.
        // https://docs.stripe.com/api/charges/object: the balance transaction represents the captured charge.
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent.latest_charge.balance_transaction'],
        });
        evidence(
          session.object === 'checkout.session' &&
            session.id === sessionId &&
            validId(session.id, 'cs_') &&
            session.mode === 'payment' &&
            typeof session.livemode === 'boolean',
          'Checkout identity or mode is inconsistent',
        );
        const status = known(session.status, ['open', 'complete', 'expired']);
        const paymentStatus = known(session.payment_status, ['paid', 'unpaid', 'no_payment_required']);
        const intent = expanded(session.payment_intent);
        evidence(intent !== null || paymentStatus !== 'paid', 'paid Checkout PaymentIntent is missing');
        if (intent) {
          evidence(
            intent.object === 'payment_intent' &&
              validId(intent.id, 'pi_') &&
              intent.livemode === session.livemode &&
              intent.metadata?.order_id === session.metadata?.order_id &&
              !!session.metadata?.order_id &&
              currency(session.currency) &&
              intent.currency === session.currency &&
              minor(session.amount_subtotal, 1) &&
              session.total_details !== null &&
              minor(session.total_details.amount_tax) &&
              minor(session.amount_total, 1) &&
              session.amount_total === session.amount_subtotal + session.total_details.amount_tax &&
              intent.amount === session.amount_total &&
              minor(intent.amount_received) &&
              intent.amount_received <= intent.amount,
            'Checkout PaymentIntent identity, currency or amounts are inconsistent',
          );
          known(
            intent.status,
            [
              'requires_payment_method',
              'requires_confirmation',
              'requires_action',
              'processing',
              'requires_capture',
              'canceled',
              'succeeded',
            ],
            'PaymentIntent',
          );
          evidence(
            paymentStatus !== 'paid' || intent.status === 'succeeded',
            'paid Checkout PaymentIntent is not succeeded',
          );
        }
        const charge = intent ? expanded(intent.latest_charge) : null;
        evidence(
          !intent || intent.status !== 'succeeded' || charge !== null,
          'succeeded PaymentIntent charge is missing',
        );
        if (charge && intent) {
          evidence(
            charge.object === 'charge' &&
              validId(charge.id, 'ch_') &&
              idOf(charge.payment_intent) === intent.id &&
              charge.livemode === session.livemode &&
              charge.currency === intent.currency &&
              minor(charge.amount, 1) &&
              charge.amount === intent.amount &&
              minor(charge.amount_captured) &&
              charge.amount_captured <= charge.amount &&
              minor(charge.amount_refunded) &&
              charge.amount_refunded <= charge.amount &&
              typeof charge.disputed === 'boolean' &&
              charge.refunded === (charge.amount_refunded === charge.amount),
            'PaymentIntent charge association, currency or amounts are inconsistent',
          );
          evidence(
            intent.status !== 'succeeded' ||
              (intent.amount_received === charge.amount &&
                charge.paid === true &&
                charge.captured === true &&
                charge.status === 'succeeded' &&
                charge.amount_captured === charge.amount),
            'succeeded payment charge is not fully captured',
          );
        }
        const requestApiVersion = stripe.getApiField('version') ?? Stripe.API_VERSION;
        const versions = new Map<string, string | null>();
        const remember = (page: Stripe.ApiList<{ id: string }>) => {
          for (const item of page.data) versions.set(item.id, responseApiVersion(page));
        };
        const lineage = (
          objectId: string,
          object: StripeMoneyProvenance['object'],
          context: StripeMoneyProvenance['context'],
          responseVersion: string | null,
        ): StripeMoneyProvenance => ({
          accountNamespace: config.accountNamespace ?? 'direct',
          livemode: session.livemode,
          objectId,
          object,
          context,
          requestApiVersion,
          responseApiVersion: responseVersion,
        });
        const refunds = intent
          ? await boundedList(
              100,
              (limit, after) =>
                stripe.refunds.list({
                  payment_intent: intent.id,
                  limit,
                  ...(after ? { starting_after: after } : {}),
                  expand: ['data.balance_transaction', 'data.failure_balance_transaction'],
                }),
              remember,
            )
          : [];
        const disputes = intent
          ? await boundedList(
              10,
              (limit, after) =>
                stripe.disputes.list({
                  payment_intent: intent.id,
                  limit,
                  ...(after ? { starting_after: after } : {}),
                  expand: ['data.balance_transactions'],
                }),
              remember,
            )
          : [];
        // Validate associations while the original provider fields are still present. Lists are complete or fail.
        let succeededRefunds = 0;
        let countedRefunds = 0;
        for (const refund of refunds) {
          evidence(
            refund.object === 'refund' &&
              validId(refund.id, 're_') &&
              !!intent &&
              !!charge &&
              idOf(refund.payment_intent) === intent.id &&
              idOf(refund.charge) === charge.id &&
              refund.currency === charge.currency &&
              minor(refund.amount, 1) &&
              refund.amount <= charge.amount,
            'refund payment association, currency or amount is inconsistent',
          );
          const status = known(
            refund.status,
            ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'],
            'refund',
          );
          if (status === 'succeeded') succeededRefunds += refund.amount;
          if (status !== 'failed' && status !== 'canceled') countedRefunds += refund.amount;
        }
        for (const dispute of disputes) {
          evidence(
            dispute.object === 'dispute' &&
              validId(dispute.id, 'du_') &&
              !!intent &&
              !!charge &&
              idOf(dispute.payment_intent) === intent.id &&
              idOf(dispute.charge) === charge.id &&
              dispute.livemode === session.livemode &&
              dispute.currency === charge.currency &&
              minor(dispute.amount, 1) &&
              dispute.amount <= charge.amount &&
              Array.isArray(dispute.balance_transactions),
            'dispute payment association, mode, currency or amount is inconsistent',
          );
          known(
            dispute.status,
            [
              'needs_response',
              'under_review',
              'appeal_needs_response',
              'appeal_under_review',
              'lost',
              'won',
              'warning_needs_response',
              'warning_under_review',
              'warning_closed',
              'prevented',
            ],
            'dispute',
          );
        }
        if (charge) {
          evidence(
            succeededRefunds === charge.amount_refunded &&
              countedRefunds <= charge.amount &&
              (!charge.disputed || disputes.length > 0),
            'charge and adverse lists contain mixed or incomplete evidence',
          );
        }
        const transactions: StripeTransaction[] = [];
        const transactionIds = new Set<string>();
        const addTransaction = (
          balance: Stripe.BalanceTransaction,
          kind: TransactionKind,
          sourceId: string,
          version: string | null,
        ) => {
          if (transactions.length === MAX_ORDER_TRANSACTIONS)
            throw new StripeUnavailableError('Stripe transaction limit exceeded');
          evidence(!transactionIds.has(balance.id), 'balance transaction identity repeated');
          transactionIds.add(balance.id);
          transactions.push(
            transaction(
              balance,
              kind,
              sourceId,
              lineage(balance.id, 'balance_transaction', 'balance_transaction', version),
            ),
          );
        };
        const chargeBalance = charge ? expanded(charge.balance_transaction) : null;
        if (charge && chargeBalance) addTransaction(chargeBalance, 'charge', charge.id, responseApiVersion(session));
        // https://docs.stripe.com/api/refunds/object: failed refunds can have a separate failure reversal.
        for (const refund of refunds) {
          const balance = expanded(refund.balance_transaction);
          const failure = expanded(refund.failure_balance_transaction ?? null);
          if (balance) addTransaction(balance, 'refund', refund.id, versions.get(refund.id) ?? null);
          if (failure) addTransaction(failure, 'refund_reversal', refund.id, versions.get(refund.id) ?? null);
        }
        // https://docs.stripe.com/api/disputes/object: balance_transactions includes withdrawals and reinstatements.
        for (const dispute of disputes) {
          for (const balance of dispute.balance_transactions) {
            addTransaction(
              balance,
              balance.amount < 0 ? 'dispute' : 'dispute_reversal',
              dispute.id,
              versions.get(dispute.id) ?? null,
            );
          }
        }
        assertTransactionBound(transactions);
        const local = session.presentment_details;
        evidence(
          !local || (currency(local.presentment_currency) && minor(local.presentment_amount)),
          'presentment amounts are inconsistent',
        );
        const snapshot: CheckoutSnapshot = {
          integrationMoneyUnit:
            session.currency === null ? null : stripeEvidenceMoneyUnit(session.currency, 'checkout.integration'),
          providerApiVersion: responseApiVersion(session) ?? requestApiVersion,
          moneyProvenance: lineage(session.id, 'checkout.session', 'checkout.integration', responseApiVersion(session)),
          presentment: local
            ? {
                currency: local.presentment_currency,
                amountMinor: local.presentment_amount,
                moneyUnit: stripeEvidenceMoneyUnit(local.presentment_currency, 'checkout.presentment'),
              }
            : null,
          sessionId: session.id,
          clientReferenceId: session.client_reference_id,
          metadataOrderId: session.metadata?.order_id ?? null,
          livemode: session.livemode,
          status,
          paymentStatus,
          currency: session.currency,
          amountSubtotalMinor: session.amount_subtotal,
          amountTaxMinor: session.total_details?.amount_tax ?? null,
          amountTotalMinor: session.amount_total,
          paymentIntentId: intent?.id ?? null,
          paymentIntentStatus: intent?.status ?? null,
          chargeId: charge?.id ?? null,
          chargeAmountMinor: charge?.amount ?? null,
          refunds: refunds.map((refund) => ({
            id: refund.id,
            status: known(refund.status, ['pending', 'requires_action', 'succeeded', 'failed', 'canceled']),
            amountMinor: refund.amount,
          })),
          disputes: disputes.map((dispute) => ({
            id: dispute.id,
            status: dispute.status,
            amountMinor: dispute.amount,
          })),
          transactions,
          observedAt: config.clock().toISOString(),
        };
        assertCheckoutEvidence(snapshot, paymentStatus === 'paid');
        return snapshot;
      });
    },

    findCheckoutSession(paymentIntentId) {
      return call(1, paymentIntentId, async (stripe) => {
        // https://docs.stripe.com/api/checkout/sessions/list: filter by the PaymentIntent that Checkout created.
        const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        if (sessions.data.length > 1 || sessions.has_more) {
          throw new StripeUnavailableError('Stripe Session locator limit exceeded');
        }
        return sessions.data[0]?.id ?? null;
      });
    },
  };
}
