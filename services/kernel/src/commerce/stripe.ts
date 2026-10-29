import Stripe from 'stripe';
import { stripeTransport } from './stripe-transport.ts';
import { assertTransactionBound, CheckoutMismatchError } from './settlement.ts';
import {
  MAX_ORDER_TRANSACTIONS,
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
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
  timeoutMs?: number;
  maxNetworkRetries?: number;
  /** Attempt/process cancellation; never used as authority for native mutation. */
  signal?: AbortSignal;
  clock: () => Date;
};

function expanded<T>(value: string | T | null): T | null {
  if (typeof value === 'string') throw new StripeUnavailableError('Stripe omitted a requested expansion');
  return value;
}

function known<T extends string>(value: string | null, supported: readonly T[]): T {
  const match = supported.find((status) => status === value);
  if (match === undefined) throw new StripeUnavailableError('Stripe returned an unsupported Checkout status');
  return match;
}

// https://docs.stripe.com/api/balance_transactions/object: preserve Stripe's settlement amounts, fees and FX rate.
function transaction(balance: Stripe.BalanceTransaction, kind: TransactionKind, sourceId: string): StripeTransaction {
  return {
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
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await read(maximum - items.length, after);
    for (const item of page.data) {
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
      const transport = stripeTransport({ timeoutMs, retries, requests, signal: config.signal });
      return await transport.run(async () => {
        transport.inspectInput({ input, apiKey: config.apiKey, host: config.host });
        // One SDK instance binds the supported fetch hook to this physical operation, including retries/pages.
        const stripe = new Stripe(config.apiKey, {
          ...(config.host === undefined ? {} : { host: config.host }),
          ...(config.port === undefined ? {} : { port: config.port }),
          ...(config.protocol === undefined ? {} : { protocol: config.protocol }),
          timeout: timeoutMs,
          maxNetworkRetries: retries,
          httpClient: Stripe.createFetchHttpClient(transport.fetch),
        });
        return operation(stripe);
      });
    } catch (error) {
      // https://docs.stripe.com/api/errors; stripe-node esm/Error.js maps HTTP errors to these classes.
      // Fixed messages also prevent Stripe's diagnostic text (or connection causes) from leaking credentials.
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError ||
        error instanceof Stripe.errors.StripeCardError ||
        error instanceof Stripe.errors.StripeIdempotencyError
      ) {
        throw new StripeRejectedError('Stripe rejected the request');
      }
      if (error instanceof StripeUnavailableError || error instanceof CheckoutMismatchError) throw error;
      throw new StripeUnavailableError('Stripe request outcome is unavailable');
    }
  }

  return {
    createCheckoutSession(request, idempotencyKey) {
      return call(1, { request, idempotencyKey }, async (stripe) => {
        // https://docs.stripe.com/api/checkout/sessions/create: inline price_data, one item, order correlation.
        const params: Stripe.Checkout.SessionCreateParams = {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
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
          ...(config.managedPayments ? { managed_payments: { enabled: true } } : { automatic_tax: { enabled: true } }),
        };
        // https://docs.stripe.com/api/idempotent_requests: Stripe retains the first result for this exact request key.
        const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
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
        const intent = expanded(session.payment_intent);
        const charge = intent ? expanded(intent.latest_charge) : null;
        const refunds = intent
          ? await boundedList(100, (limit, after) =>
              stripe.refunds.list({
                payment_intent: intent.id,
                limit,
                ...(after ? { starting_after: after } : {}),
                expand: ['data.balance_transaction', 'data.failure_balance_transaction'],
              }),
            )
          : [];
        const disputes = intent
          ? await boundedList(10, (limit, after) =>
              stripe.disputes.list({
                payment_intent: intent.id,
                limit,
                ...(after ? { starting_after: after } : {}),
                expand: ['data.balance_transactions'],
              }),
            )
          : [];
        const transactions: StripeTransaction[] = [];
        const addTransaction = (balance: Stripe.BalanceTransaction, kind: TransactionKind, sourceId: string) => {
          if (transactions.length === MAX_ORDER_TRANSACTIONS)
            throw new StripeUnavailableError('Stripe transaction limit exceeded');
          transactions.push(transaction(balance, kind, sourceId));
        };
        const chargeBalance = charge ? expanded(charge.balance_transaction) : null;
        if (charge && chargeBalance) addTransaction(chargeBalance, 'charge', charge.id);
        // https://docs.stripe.com/api/refunds/object: failed refunds can have a separate failure reversal.
        for (const refund of refunds) {
          const balance = expanded(refund.balance_transaction);
          const failure = expanded(refund.failure_balance_transaction ?? null);
          if (balance) addTransaction(balance, 'refund', refund.id);
          if (failure) addTransaction(failure, 'refund_reversal', refund.id);
        }
        // https://docs.stripe.com/api/disputes/object: balance_transactions includes withdrawals and reinstatements.
        for (const dispute of disputes) {
          for (const balance of dispute.balance_transactions) {
            addTransaction(balance, balance.amount < 0 ? 'dispute' : 'dispute_reversal', dispute.id);
          }
        }
        assertTransactionBound(transactions);
        const snapshot: CheckoutSnapshot = {
          sessionId: session.id,
          clientReferenceId: session.client_reference_id,
          metadataOrderId: session.metadata?.order_id ?? null,
          livemode: session.livemode,
          status: known(session.status, ['open', 'complete', 'expired']),
          paymentStatus: known(session.payment_status, ['paid', 'unpaid', 'no_payment_required']),
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
            status: refund.status ?? 'unknown',
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
