import Stripe from 'stripe';

// Fixture objects contain the documented fields used by commerce, with IDs at expandable boundaries.
// https://docs.stripe.com/api/checkout/sessions/object
// https://docs.stripe.com/api/payment_intents/object
// https://docs.stripe.com/api/charges/object
// https://docs.stripe.com/api/refunds/object
// https://docs.stripe.com/api/disputes/object
// https://docs.stripe.com/api/balance_transactions/object
type Session = Pick<
  Stripe.Checkout.Session,
  | 'id'
  | 'object'
  | 'livemode'
  | 'created'
  | 'mode'
  | 'status'
  | 'payment_status'
  | 'currency'
  | 'amount_subtotal'
  | 'amount_total'
  | 'total_details'
  | 'client_reference_id'
  | 'metadata'
  | 'expires_at'
  | 'url'
  | 'success_url'
  | 'cancel_url'
  | 'automatic_tax'
  | 'managed_payments'
> & {
  payment_intent: string | null;
};
type Intent = Pick<
  Stripe.PaymentIntent,
  'id' | 'object' | 'livemode' | 'created' | 'status' | 'amount' | 'amount_received' | 'currency' | 'metadata'
> & { latest_charge: string | null };
type Charge = Pick<
  Stripe.Charge,
  | 'id'
  | 'object'
  | 'livemode'
  | 'created'
  | 'amount'
  | 'amount_captured'
  | 'amount_refunded'
  | 'currency'
  | 'paid'
  | 'captured'
  | 'refunded'
  | 'disputed'
  | 'status'
  | 'metadata'
> & {
  payment_intent: string;
  balance_transaction: string | null;
};
type Refund = Pick<Stripe.Refund, 'id' | 'object' | 'created' | 'amount' | 'currency' | 'status' | 'metadata'> & {
  livemode: false;
  charge: string;
  payment_intent: string;
  balance_transaction: string | null;
  failure_balance_transaction: string | null;
  failure_reason?: string;
};
type Dispute = Pick<
  Stripe.Dispute,
  | 'id'
  | 'object'
  | 'livemode'
  | 'created'
  | 'amount'
  | 'currency'
  | 'status'
  | 'metadata'
  | 'reason'
  | 'is_charge_refundable'
  | 'evidence_details'
> & {
  charge: string;
  payment_intent: string;
  balance_transactions: Stripe.BalanceTransaction[];
};
type FixtureObject = Session | Intent | Charge | Refund | Dispute | Stripe.BalanceTransaction;
export type RecordedStripeRequest = {
  method: string;
  path: string;
  headers: Headers;
  params: URLSearchParams;
  rawParams: URLSearchParams;
};
export type CreateFault = 'rejected' | 'lost' | 'timeout' | { type: string; status: number; message?: string };
type Settlement = { currency?: string; amount?: number; exchangeRate?: number | null };

function required<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`Unknown fake Stripe object: ${id}`);
  return value;
}

/** A local Stripe API fixture. Controls operate on provider objects, never commerce settlement or entitlements. */
export function startFakeStripe(rewriteRead?: (path: string, response: Response) => Promise<Response>) {
  const sessions = new Map<string, Session>();
  const intents = new Map<string, Intent>();
  const charges = new Map<string, Charge>();
  const refunds = new Map<string, Refund>();
  const disputes = new Map<string, Dispute>();
  const balances = new Map<string, Stripe.BalanceTransaction>();
  const objects = new Map<string, FixtureObject>();
  const paymentMetadata = new Map<string, Stripe.Metadata>();
  const requests: RecordedStripeRequest[] = [];
  const idempotency = new Map<string, { params: string; body: string; status: number; created: number }>();
  const sdk = new Stripe('sk_test_fake_only');
  const webhookSecret = 'whsec_local_stripe_fixture';
  const controls = { nextCreateFault: null as CreateFault | null, pageSize: 100 };
  let sequence = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(12, '0')}`;
  function store<T extends FixtureObject>(map: Map<string, T>, object: T): T {
    map.set(object.id, object);
    objects.set(object.id, object);
    return object;
  }

  // https://docs.stripe.com/api/balance_transactions/object: net is amount minus fee, independent of presentment.
  function balance(
    source: string,
    amount: number,
    currency: string,
    type: Stripe.BalanceTransaction.Type,
    fee = 0,
    description = 'Processing fee',
    exchangeRate: number | null = null,
  ): Stripe.BalanceTransaction {
    return store(balances, {
      id: id('txn'),
      object: 'balance_transaction',
      balance_type: 'payments',
      amount,
      currency,
      fee,
      net: amount - fee,
      fee_details: fee ? [{ amount: fee, currency, description, type: 'stripe_fee', application: null }] : [],
      exchange_rate: exchangeRate,
      created: now(),
      available_on: now(),
      description: null,
      reporting_category: type === 'adjustment' ? 'dispute' : type,
      source,
      status: 'available',
      type,
    });
  }

  function intentOf(sessionId: string): Intent {
    const session = required(sessions, sessionId);
    if (!session.payment_intent) throw new Error('Checkout has no PaymentIntent');
    return required(intents, session.payment_intent);
  }
  function chargeOf(sessionId: string): Charge {
    const intent = intentOf(sessionId);
    if (!intent.latest_charge) throw new Error('PaymentIntent has no charge');
    return required(charges, intent.latest_charge);
  }
  function chargeBalance(charge: Charge): Stripe.BalanceTransaction {
    if (!charge.balance_transaction) throw new Error('Charge has no balance transaction');
    return required(balances, charge.balance_transaction);
  }
  function updateRefundTotals(charge: Charge) {
    charge.amount_refunded = [...refunds.values()]
      .filter((r) => r.charge === charge.id && r.status === 'succeeded')
      .reduce((sum, r) => sum + r.amount, 0);
    charge.refunded = charge.amount_refunded === charge.amount;
  }

  function succeedPayment(sessionId: string, settlement: Settlement = {}) {
    const session = required(sessions, sessionId);
    const intent = intentOf(sessionId);
    if (intent.status !== 'processing') throw new Error('Payment is not processing');
    const charge = store(charges, {
      id: id('ch'),
      object: 'charge',
      livemode: false,
      created: now(),
      amount: intent.amount,
      amount_captured: intent.amount,
      amount_refunded: 0,
      currency: intent.currency,
      paid: true,
      captured: true,
      refunded: false,
      disputed: false,
      status: 'succeeded',
      metadata: { ...intent.metadata },
      payment_intent: intent.id,
      balance_transaction: null,
    } satisfies Charge);
    charge.balance_transaction = balance(
      charge.id,
      settlement.amount ?? charge.amount,
      settlement.currency ?? charge.currency,
      'charge',
      65,
      'Processing fee',
      settlement.exchangeRate ?? null,
    ).id;
    intent.latest_charge = charge.id;
    intent.status = 'succeeded';
    intent.amount_received = intent.amount;
    session.payment_status = 'paid';
  }

  function pay(sessionId: string, mode: 'immediate' | 'async' = 'immediate', settlement: Settlement = {}) {
    const session = required(sessions, sessionId);
    if (session.status !== 'open') throw new Error('Checkout is not open');
    const intent = store(intents, {
      id: id('pi'),
      object: 'payment_intent',
      livemode: false,
      created: now(),
      status: 'processing',
      amount: session.amount_total!,
      amount_received: 0,
      currency: session.currency!,
      metadata: { ...paymentMetadata.get(sessionId) },
      latest_charge: null,
    } satisfies Intent);
    session.payment_intent = intent.id;
    session.status = 'complete';
    session.url = null;
    if (mode === 'immediate') succeedPayment(sessionId, settlement);
  }

  function withdrawDispute(disputeId: string, fee = 1500) {
    const dispute = required(disputes, disputeId);
    if (dispute.balance_transactions.length) return;
    const original = chargeBalance(required(charges, dispute.charge));
    dispute.balance_transactions.push(
      balance(
        dispute.id,
        -Math.round(dispute.amount * (original.exchange_rate ?? 1)),
        original.currency,
        'adjustment',
        fee,
        'Dispute fee',
        original.exchange_rate,
      ),
    );
  }

  function reinstateDispute(disputeId: string) {
    const dispute = required(disputes, disputeId);
    if (dispute.balance_transactions.length !== 1) return;
    const withdrawal = dispute.balance_transactions[0]!;
    dispute.balance_transactions.push(
      balance(dispute.id, -withdrawal.amount, withdrawal.currency, 'adjustment', 0, '', withdrawal.exchange_rate),
    );
  }

  // Expansion changes only the returned representation, never the stored object's relationships.
  function serialize(object: FixtureObject, expansions: string[] = []): unknown {
    const paths = (field: string) =>
      expansions.filter((e) => e.startsWith(`${field}.`)).map((e) => e.slice(field.length + 1));
    const wants = (field: string) => expansions.some((e) => e === field || e.startsWith(`${field}.`));
    const reference = (field: string, value: string | null) =>
      value && wants(field) ? serialize(required(objects, value), paths(field)) : value;
    switch (object.object) {
      case 'checkout.session':
        return { ...object, payment_intent: reference('payment_intent', object.payment_intent) };
      case 'payment_intent':
        return { ...object, latest_charge: reference('latest_charge', object.latest_charge) };
      case 'charge':
        return { ...object, balance_transaction: reference('balance_transaction', object.balance_transaction) };
      case 'refund':
        return {
          ...object,
          balance_transaction: reference('balance_transaction', object.balance_transaction),
          failure_balance_transaction: reference('failure_balance_transaction', object.failure_balance_transaction),
        };
      // Dispute balance_transactions are embedded objects in Stripe's schema, even without expansion.
      default:
        return structuredClone(object);
    }
  }

  // https://docs.stripe.com/api/checkout/sessions/list
  // https://docs.stripe.com/api/refunds/list and https://docs.stripe.com/api/disputes/list
  function list(path: string, values: FixtureObject[], params: URLSearchParams): Response {
    const filtered = values
      .filter((value) => {
        const record = value as unknown as Record<string, unknown>;
        return ['payment_intent', 'charge', 'status'].every(
          (field) => !params.has(field) || record[field] === params.get(field),
        );
      })
      .reverse();
    const after = params.get('starting_after');
    const before = params.get('ending_before');
    const position = after ? filtered.findIndex((v) => v.id === after) : -1;
    const end = before ? filtered.findIndex((v) => v.id === before) : filtered.length;
    if ((after && position < 0) || (before && end < 0))
      return error('invalid_request_error', 400, 'Unknown pagination cursor');
    const candidates = filtered.slice(position + 1, end);
    const limit = Math.min(Number(params.get('limit') ?? 10), controls.pageSize);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return error('invalid_request_error', 400, 'Invalid list limit');
    const data = candidates.slice(0, limit);
    const expand = params
      .getAll('expand[]')
      .filter((e) => e.startsWith('data.'))
      .map((e) => e.slice(5));
    return Response.json({
      object: 'list',
      url: path,
      has_more: candidates.length > data.length,
      data: data.map((v) => serialize(v, expand)),
    });
  }
  // https://docs.stripe.com/api/errors: Stripe errors use an error envelope with type and message.
  function error(type: string, status: number, message: string) {
    return Response.json({ error: { type, message } }, { status, headers: { 'stripe-should-retry': 'false' } });
  }
  function create(params: URLSearchParams): Session {
    const session = store(sessions, {
      id: id('cs_test'),
      object: 'checkout.session',
      livemode: false,
      created: now(),
      mode: 'payment',
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      currency: params.get('line_items[0][price_data][currency]')!,
      amount_subtotal: Number(params.get('line_items[0][price_data][unit_amount]')),
      amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
      total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
      client_reference_id: params.get('client_reference_id'),
      metadata: { order_id: params.get('metadata[order_id]')!, account_id: params.get('metadata[account_id]')! },
      expires_at: Number(params.get('expires_at')),
      url: 'https://checkout.stripe.com/c/pay/fixture',
      success_url: params.get('success_url'),
      cancel_url: params.get('cancel_url'),
      automatic_tax: {
        enabled: params.get('automatic_tax[enabled]') === 'true',
        liability: null,
        provider: null,
        status: null,
      },
      managed_payments: params.get('managed_payments[enabled]') === 'true' ? { enabled: true } : null,
    } satisfies Session);
    session.url = `https://checkout.stripe.com/c/pay/${session.id}`;
    paymentMetadata.set(session.id, { order_id: params.get('payment_intent_data[metadata][order_id]')! });
    return session;
  }

  async function signedEvent(type: string, objectId: string) {
    const object = required(objects, objectId);
    const bytes = JSON.stringify({
      id: id('evt'),
      object: 'event',
      api_version: Stripe.API_VERSION,
      created: now(),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object: serialize(object) },
    });
    const signature = await sdk.webhooks.generateTestHeaderStringAsync({
      payload: bytes,
      secret: webhookSecret,
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    return { bytes, signature, headers: { 'Stripe-Signature': signature } };
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/walk/')) {
        if (req.method !== 'POST') return error('invalid_request_error', 404, 'Unknown fake Stripe endpoint or object');
        let body: unknown;
        try {
          body = JSON.parse(await req.text());
        } catch {
          return error('invalid_request_error', 400, 'Invalid walk fixture body');
        }
        const record =
          typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
        const objectId = typeof record.objectId === 'string' ? record.objectId : sessionId;
        const type = typeof record.type === 'string' ? record.type : undefined;
        try {
          if (url.pathname === '/walk/pay' && sessionId) {
            pay(sessionId);
            return new Response(null, { status: 204 });
          }
          if (url.pathname === '/walk/event' && type && objectId) {
            const signed = await signedEvent(type, objectId);
            return Response.json({ bytes: signed.bytes, headers: { 'stripe-signature': signed.signature } });
          }
        } catch {
          return error('invalid_request_error', 400, 'Walk fixture could not sign that Checkout');
        }
        return error('invalid_request_error', 404, 'Unknown fake Stripe endpoint or object');
      }
      const params = req.method === 'POST' ? new URLSearchParams(await req.text()) : url.searchParams;
      const rawParams = new URLSearchParams(params);
      // Stripe accepts both expand[]=x and expand[0]=x; expose the decoded array under its unindexed name.
      for (const name of [...new Set(params.keys())]) {
        if (/^expand\[\d+\]$/.test(name)) {
          for (const value of params.getAll(name)) params.append('expand[]', value);
          params.delete(name);
        }
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: new Headers(req.headers),
        params: new URLSearchParams(params),
        rawParams,
      });
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const key = req.headers.get('idempotency-key');
        const canonical = new URLSearchParams(params);
        canonical.sort();
        const fingerprint = canonical.toString();
        const previous = key ? idempotency.get(key) : undefined;
        // https://docs.stripe.com/api/idempotent_requests: cache the original bytes, not today's mutable session.
        if (previous && now() - previous.created < 86400)
          return previous.params === fingerprint
            ? new Response(previous.body, {
                status: previous.status,
                headers: { 'content-type': 'application/json', 'stripe-should-retry': 'false' },
              })
            : error('idempotency_error', 400, 'Key reused with different parameters');
        const fault = controls.nextCreateFault;
        controls.nextCreateFault = null;
        if (fault === 'rejected') return error('invalid_request_error', 400, 'Checkout parameters rejected');
        if (fault && typeof fault === 'object') {
          const response = error(fault.type, fault.status, fault.message ?? 'Injected Stripe error');
          // Execution errors are retained too; authentication and validation failures precede execution.
          if (key && fault.status >= 500)
            idempotency.set(key, {
              params: fingerprint,
              body: await response.clone().text(),
              status: fault.status,
              created: now(),
            });
          return response;
        }
        if (
          params.get('mode') !== 'payment' ||
          params.get('line_items[0][quantity]') !== '1' ||
          !params.get('line_items[0][price_data][product_data][name]') ||
          !params.get('line_items[0][price_data][product_data][tax_code]') ||
          !params.get('line_items[0][price_data][currency]') ||
          !Number.isSafeInteger(Number(params.get('line_items[0][price_data][unit_amount]'))) ||
          Number(params.get('line_items[0][price_data][unit_amount]')) <= 0 ||
          Number(params.get('expires_at')) < now() + 1800 ||
          Number(params.get('expires_at')) > now() + 86400 ||
          (params.has('managed_payments[enabled]') && params.has('automatic_tax[enabled]'))
        ) {
          return error('invalid_request_error', 400, 'Invalid Checkout parameters');
        }
        const body = JSON.stringify(serialize(create(params)));
        if (key) idempotency.set(key, { params: fingerprint, body, status: 200, created: now() });
        // A truncated JSON response loses the result after Stripe committed it, without an SDK-retryable status.
        if (fault === 'lost') return new Response('{', { headers: { 'content-type': 'application/json' } });
        if (fault === 'timeout') {
          // The provider has committed; the caller can still time out and reconcile using the same key.
          await new Promise<void>((resolve) => {
            if (req.signal.aborted) resolve();
            else req.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }
      if (req.method === 'GET') {
        const reply = (response: Response) => (rewriteRead ? rewriteRead(url.pathname, response) : response);
        if (url.pathname === '/v1/checkout/sessions') return reply(list(url.pathname, [...sessions.values()], params));
        if (url.pathname === '/v1/refunds') return reply(list(url.pathname, [...refunds.values()], params));
        if (url.pathname === '/v1/disputes') return reply(list(url.pathname, [...disputes.values()], params));
        const match = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
        const session = match?.[1] ? sessions.get(decodeURIComponent(match[1])) : undefined;
        if (session) return reply(Response.json(serialize(session, params.getAll('expand[]'))));
      }
      return error('invalid_request_error', 404, 'Unknown fake Stripe endpoint or object');
    },
  });

  return {
    port: server.port!,
    webhookSecret,
    sessions,
    requests,
    get nextCreateFault() {
      return controls.nextCreateFault;
    },
    set nextCreateFault(value: CreateFault | null) {
      controls.nextCreateFault = value;
    },
    get pageSize() {
      return controls.pageSize;
    },
    set pageSize(value: number) {
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Invalid fake page size');
      controls.pageSize = value;
    },
    stop() {
      void server.stop(true);
    },
    pay,
    chargeId(sessionId: string) {
      return chargeOf(sessionId).id;
    },
    refundRemaining(sessionId: string, amount: number | 'remaining') {
      const charge = chargeOf(sessionId);
      return this.refund(sessionId, {
        amount: amount === 'remaining' ? charge.amount - charge.amount_refunded : amount,
      });
    },
    succeedPayment,
    failPayment(sessionId: string) {
      const intent = intentOf(sessionId);
      if (intent.status !== 'processing') throw new Error('Payment is not processing');
      intent.status = 'requires_payment_method';
    },
    expire(sessionId: string) {
      const session = required(sessions, sessionId);
      if (session.status !== 'open') throw new Error('Checkout is not open');
      session.status = 'expired';
      session.url = null;
    },
    refund(sessionId: string, options: { amount: number; status?: NonNullable<Stripe.Refund['status']> }) {
      const charge = chargeOf(sessionId);
      const reserved = [...refunds.values()]
        .filter((r) => r.charge === charge.id && r.status !== 'failed' && r.status !== 'canceled')
        .reduce((sum, r) => sum + r.amount, 0);
      if (!Number.isSafeInteger(options.amount) || options.amount <= 0 || reserved + options.amount > charge.amount) {
        throw new Error('Invalid refund amount');
      }
      const refund = store(refunds, {
        id: id('re'),
        object: 'refund',
        livemode: false,
        created: now(),
        amount: options.amount,
        currency: charge.currency,
        status: options.status ?? 'succeeded',
        metadata: {},
        charge: charge.id,
        payment_intent: charge.payment_intent,
        balance_transaction: null,
        failure_balance_transaction: null,
      } satisfies Refund);
      const original = chargeBalance(charge);
      if (refund.status !== 'failed' && refund.status !== 'canceled') {
        refund.balance_transaction = balance(
          refund.id,
          -Math.round(options.amount * (original.exchange_rate ?? 1)),
          original.currency,
          'refund',
          0,
          '',
          original.exchange_rate,
        ).id;
      }
      updateRefundTotals(charge);
      return refund.id;
    },
    failRefund(refundId: string) {
      const refund = required(refunds, refundId);
      if (refund.status === 'failed') return;
      refund.status = 'failed';
      refund.failure_reason = 'declined';
      if (refund.balance_transaction) {
        const original = required(balances, refund.balance_transaction);
        refund.failure_balance_transaction = balance(
          refund.id,
          -original.amount,
          original.currency,
          'refund_failure',
          0,
          '',
          original.exchange_rate,
        ).id;
      }
      updateRefundTotals(required(charges, refund.charge));
    },
    dispute(
      sessionId: string,
      options: { amount?: number; status?: Stripe.Dispute.Status; fee?: number; withdraw?: boolean } = {},
    ) {
      const charge = chargeOf(sessionId);
      const dispute = store(disputes, {
        id: id('du'),
        object: 'dispute',
        livemode: false,
        created: now(),
        amount: options.amount ?? charge.amount,
        currency: charge.currency,
        status: options.status ?? 'needs_response',
        metadata: {},
        charge: charge.id,
        payment_intent: charge.payment_intent,
        balance_transactions: [],
        reason: 'general',
        is_charge_refundable: false,
        evidence_details: {
          due_by: now() + 604800,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
          submission_method: 'not_submitted',
        },
      } satisfies Dispute);
      charge.disputed = true;
      if (options.withdraw !== false) withdrawDispute(dispute.id, options.fee);
      return dispute.id;
    },
    updateDispute(disputeId: string, status: Stripe.Dispute.Status) {
      const dispute = required(disputes, disputeId);
      dispute.status = status;
      if (status === 'won') reinstateDispute(disputeId);
    },
    withdrawDispute,
    reinstateDispute,
    event: signedEvent,
  };
}
