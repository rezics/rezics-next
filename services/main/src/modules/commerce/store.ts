import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { commerceColumns } from './schema.ts';
import type { OwnerRow } from './owner-columns.ts';

export class CommerceInvalid extends Error {}
export class CommerceDenied extends Error {}
/** An idempotency key already binds another request. */
export class CommerceKeyConflict extends Error {}
/** Expected generation, offering head, quote or lease no longer current. */
export class CommerceStale extends Error {}
/** The requested state transition conflicts with current commercial state. */
export class CommerceStateConflict extends Error {}
export class CommerceUnavailable extends Error {}
export class CommerceSignatureInvalid extends Error {}

/** Account scope for payer and beneficiary commands and reads. */
export const COMMERCE_SCOPE = 'subscription:manage';
/** Access representation action: the caller may act for this beneficiary. */
export const SUBSCRIBE_ACTION = 'commerce.subscribe';
/** Access representation and direct grant action for complimentary awards. */
export const GIFT_ACTION = 'commerce.gift.issue';
export const giftScope = (seller: string) => `commerce:gift:${seller}`;

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = /^[a-z][a-z0-9-]{0,62}$/;
const generation = /^(0|[1-9][0-9]{0,18})$/;
const QUOTE_TTL_SECONDS = 900;
const MAX_ACTIVE_GRANTS = 64;

/** Outbound provider protocol; the in-stack fake is the only admitted kind. */
export interface PaymentProvider {
  /** Idempotent by reference. Throws when the outcome is lost or refused. */
  create(input: { reference: string; amountMinor: string; currency: string }): Promise<void>;
  /** Throws when the provider cannot answer. */
  lookup(reference: string): Promise<'succeeded' | 'failed' | 'pending' | 'not-found'>;
}

/** HTTP binding of {@link PaymentProvider} with a per-call deadline. */
export class HttpPaymentProvider implements PaymentProvider {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 3000) {}

  async create(input: { reference: string; amountMinor: string; currency: string }): Promise<void> {
    const response = await this.fetcher(new URL('/payments', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new CommerceUnavailable(`payment provider refused (${response.status})`);
  }

  async lookup(reference: string): Promise<'succeeded' | 'failed' | 'pending' | 'not-found'> {
    const response = await this.fetcher(new URL(`/payments/${encodeURIComponent(reference)}`, this.baseUrl),
      { signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status === 404) return 'not-found';
    if (!response.ok) throw new CommerceUnavailable(`payment provider unavailable (${response.status})`);
    const body = await response.json() as { status?: string };
    if (body.status === 'succeeded' || body.status === 'failed' || body.status === 'pending') return body.status;
    throw new CommerceUnavailable('payment provider answered an unknown status');
  }
}

export interface CommerceReceipt { idempotencyKey: string; requestDigest: string }

export type QuoteInput = {
  beneficiary: string; offeringId: string; offeringRevision: string;
} & ({ operation: 'purchase'; planKey: string; priceKey: string }
  | { operation: 'change'; planKey: string; priceKey: string; subscriptionId: string; expectedGeneration: string }
  | { operation: 'cancel'; subscriptionId: string; expectedGeneration: string });

export interface QuoteResult {
  quoteId: string; operation: 'purchase' | 'change' | 'cancel'; beneficiary: string;
  offeringId: string; offeringRevision: string; planKey: string | null; priceKey: string | null;
  subscriptionId: string | null; expectedGeneration: string | null;
  amountMinor: string; currency: string; benefitEpoch: string; quoteDigest: string; expiresAt: string;
  replayed: boolean;
}

export interface SettlementView { id: string; state: string; generation: string; providerReference: string }
export interface ChangeResult {
  changeId: string; quoteId: string; operation: 'purchase' | 'change' | 'cancel';
  subscriptionId: string; subscriptionGeneration: string; settlement: SettlementView | null;
  replayed: boolean;
}
export interface CallbackResult {
  provider: string; eventId: string; disposition: 'applied' | 'no-effect' | 'unmatched';
  settlementId: string | null; settlementState: string | null; replayed: boolean;
}
export interface ReconciliationResult {
  reconciliationId: string; settlementId: string;
  observed: 'succeeded' | 'failed' | 'pending' | 'not-found' | 'unavailable';
  outcome: 'applied' | 'no-change' | 'still-unknown';
  settlementState: string; settlementGeneration: string; replayed: boolean;
}
export type GiftInput = { issuerSubject: string } & ({
  operation: 'issue'; beneficiary: string; offeringId: string; offeringRevision: string;
  planKey: string; validUntil: string; reason: string;
} | { operation: 'revoke'; entitlementId: string; expectedGeneration: string; reason: string });
export interface GiftResult {
  operation: 'issue' | 'revoke'; entitlementId: string; beneficiary: string;
  state: 'active' | 'revoked'; generation: string; validUntil: string; benefitEpoch: string; replayed: boolean;
}
export interface BenefitGrant {
  entitlementId: string; source: 'purchase' | 'gift'; offeringId: string; planKey: string;
  level: number; validUntil: string; generation: string;
}
export interface BenefitResult {
  beneficiary: string; benefitEpoch: string; freshUntil: string | null;
  benefits: { benefitKey: string; level: number; grants: BenefitGrant[] }[];
}
export interface SubscriptionView {
  subscriptionId: string; beneficiary: string; offeringId: string; groupKey: string;
  groupSemantics: string; offeringRevision: string; planKey: string; priceKey: string;
  state: string; generation: string; currentPeriodEnd: string | null;
  settlements: SettlementView[];
}

type Receipted<T> = T & { replayed: boolean };
type Subscription = OwnerRow<typeof commerceColumns.subscription>;
type Settlement = OwnerRow<typeof commerceColumns.settlement>;
type Quote = OwnerRow<typeof commerceColumns.quote>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => `${JSON.stringify(name)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical digest of a validated command body (the request intent). */
export function commerceIntentDigest(body: Record<string, unknown>): string {
  return createHash('sha256').update(stable(body)).digest('hex');
}

/** Provider callback signature: lowercase hex HMAC-SHA256 over the raw body. */
export function signProviderCallback(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function periodEnd(billing: string): string {
  return billing === 'P1Y' ? "clock_timestamp() + interval '1 year'"
    : billing === 'P1M' ? "clock_timestamp() + interval '1 month'"
      : "clock_timestamp() + interval '100 years'";
}

/**
 * Commercial owner for subscriptions, settlements and independent benefit
 * grants. Every command runs in one Access-database transaction behind the
 * shared Access recovery fence, serializes its principal-scoped idempotency key
 * with a transaction advisory lock and writes one immutable commerce.receipt.
 * Provider I/O never runs inside a transaction.
 */
export class CommerceStore {
  constructor(private readonly pool: Pool, private readonly provider: PaymentProvider,
    private readonly callbackSecret: (keyReference: string) => string | undefined) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (fence.rows[0]?.open !== true) throw new CommerceUnavailable('Access recovery is held');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new CommerceUnavailable('commerce owner could not complete');
      }
      if (code === '23505' && 'constraint' in error
        && error.constraint === 'subscription_replaceable_live') {
        return new CommerceStateConflict('a live subscription already holds this replaceable group');
      }
      if (code === '23505' && 'constraint' in error
        && error.constraint === 'subscription_change_quote_id_key') {
        return new CommerceStateConflict('quote was already used');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async principalId(client: PoolClient, principal: VerifiedPrincipal): Promise<string> {
    const row = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [principal.issuer, principal.subject]);
    if (!row.rows[0]) throw new CommerceDenied('principal is not admitted');
    return row.rows[0].id;
  }

  private async represents(client: PoolClient, principalId: string, subject: string,
    action: string): Promise<boolean> {
    const row = await client.query(`SELECT 1 FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3 AND r.active
        AND r.valid_until > clock_timestamp() AND s.active
      LIMIT 1 FOR SHARE OF r, s`, [principalId, subject, action]);
    return row.rowCount === 1;
  }

  /** Serialize one principal key, then return its immutable prior result if any. */
  private async receipt<T>(client: PoolClient, principalId: string, receipt: CommerceReceipt,
    operations: readonly string[]): Promise<Receipted<T> | null> {
    if (!receipt.idempotencyKey || receipt.idempotencyKey.length > 128
      || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
      throw new CommerceInvalid('invalid idempotency binding');
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`commerce:${principalId}:${receipt.idempotencyKey}`]);
    const prior = await client.query<{ request_digest: string; operation: string;
      result: Record<string, unknown> }>(`SELECT request_digest, operation, result
      FROM commerce.receipt WHERE principal_id = $1 AND idempotency_key = $2`,
    [principalId, receipt.idempotencyKey]);
    const row = prior.rows[0];
    if (!row) return null;
    if (row.request_digest !== receipt.requestDigest || !operations.includes(row.operation)) {
      throw new CommerceKeyConflict('idempotency key binds another request');
    }
    return { ...(row.result as T), replayed: true };
  }

  private async saveReceipt(client: PoolClient, principalId: string, receipt: CommerceReceipt,
    operation: string, result: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO commerce.receipt (principal_id, idempotency_key, request_digest,
      operation, result) VALUES ($1, $2, $3, $4, $5)`,
    [principalId, receipt.idempotencyKey, receipt.requestDigest, operation, JSON.stringify(result)]);
  }

  private async benefitEpoch(client: PoolClient, beneficiary: string): Promise<string> {
    const row = await client.query<{ epoch: string }>(
      'SELECT epoch FROM commerce.benefit_epoch WHERE beneficiary = $1', [beneficiary]);
    return row.rows[0]?.epoch ?? '0';
  }

  /** Price one exact purchase, plan change or cancellation for 15 minutes. */
  async quote(principal: VerifiedPrincipal, input: QuoteInput, receipt: CommerceReceipt): Promise<QuoteResult> {
    if (!nativeId.test(input.beneficiary) || !uuid.test(input.offeringId)
      || !generation.test(input.offeringRevision)
      || (input.operation !== 'cancel' && (!key.test(input.planKey) || !key.test(input.priceKey)))
      || (input.operation !== 'purchase' && (!uuid.test(input.subscriptionId)
        || !generation.test(input.expectedGeneration)))) {
      throw new CommerceInvalid('invalid quote request');
    }
    return this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const prior = await this.receipt<QuoteResult>(client, principalId, receipt, ['quote']);
      if (prior) return prior;
      if (!await this.represents(client, principalId, input.beneficiary, SUBSCRIBE_ACTION)) {
        throw new CommerceDenied('caller does not represent the beneficiary');
      }
      const offering = await client.query<{ head_revision: string; lifecycle: string }>(`
        SELECT o.head_revision, r.lifecycle FROM commerce.offering o
        JOIN commerce.offering_revision r ON r.offering_id = o.id AND r.revision = o.head_revision
        WHERE o.id = $1 FOR SHARE OF o`, [input.offeringId]);
      if (!offering.rows[0]) throw new CommerceInvalid('offering is unknown');
      if (offering.rows[0].head_revision !== input.offeringRevision || offering.rows[0].lifecycle !== 'open') {
        throw new CommerceStale('offering revision is not the open head');
      }
      let subscription: Subscription | undefined;
      if (input.operation !== 'purchase') {
        subscription = (await client.query<Subscription>(`SELECT * FROM commerce.subscription
          WHERE id = $1 FOR SHARE`, [input.subscriptionId])).rows[0];
        if (!subscription || subscription.principal_id !== principalId
          || subscription.beneficiary !== input.beneficiary || subscription.offering_id !== input.offeringId) {
          throw new CommerceDenied('subscription is unavailable to caller');
        }
        if (subscription.generation !== input.expectedGeneration) {
          throw new CommerceStale('subscription generation changed');
        }
        if (subscription.state !== 'active') throw new CommerceStateConflict('subscription is not active');
      }
      let amount = '0';
      let currency = 'USD';
      if (input.operation !== 'cancel') {
        const price = await client.query<{ amount_minor: string; currency: string; group_key: string;
          semantics: string }>(`SELECT p.amount_minor, p.currency, l.group_key, g.semantics
          FROM commerce.price p
          JOIN commerce.plan l USING (offering_id, offering_revision, plan_key)
          JOIN commerce.plan_group g ON g.offering_id = l.offering_id AND g.group_key = l.group_key
          WHERE p.offering_id = $1 AND p.offering_revision = $2 AND p.plan_key = $3 AND p.price_key = $4`,
        [input.offeringId, input.offeringRevision, input.planKey, input.priceKey]);
        const row = price.rows[0];
        if (!row) throw new CommerceInvalid('plan price is unknown');
        if (input.operation === 'purchase' && row.semantics === 'replaceable') {
          const live = await client.query(`SELECT 1 FROM commerce.subscription
            WHERE beneficiary = $1 AND offering_id = $2 AND group_key = $3
              AND state IN ('pending', 'active', 'cancelling')`,
          [input.beneficiary, input.offeringId, row.group_key]);
          if (live.rowCount) throw new CommerceStateConflict('replaceable group already has a live subscription');
        }
        if (subscription && (row.group_key !== subscription.group_key
          || (input.planKey === subscription.plan_key && input.priceKey === subscription.price_key))) {
          throw new CommerceInvalid('a change must target another plan in the same group');
        }
        amount = row.amount_minor;
        currency = row.currency;
      } else {
        const price = await client.query<{ currency: string }>(`SELECT currency FROM commerce.price
          WHERE offering_id = $1 AND offering_revision = $2 AND plan_key = $3 AND price_key = $4`,
        [subscription!.offering_id, subscription!.offering_revision, subscription!.plan_key, subscription!.price_key]);
        currency = price.rows[0]!.currency;
      }
      const benefitEpoch = await this.benefitEpoch(client, input.beneficiary);
      const quoteId = randomUUID();
      const planKey = input.operation === 'cancel' ? null : input.planKey;
      const priceKey = input.operation === 'cancel' ? null : input.priceKey;
      const subscriptionId = input.operation === 'purchase' ? null : input.subscriptionId;
      const expectedGeneration = input.operation === 'purchase' ? null : input.expectedGeneration;
      const quoteDigest = commerceIntentDigest({ quoteId, operation: input.operation,
        beneficiary: input.beneficiary, offeringId: input.offeringId,
        offeringRevision: input.offeringRevision, planKey, priceKey, subscriptionId,
        expectedGeneration, amountMinor: amount, currency });
      const inserted = await client.query<{ expires_at: Date }>(`INSERT INTO commerce.quote (id, principal_id,
          beneficiary, operation, subscription_id, expected_subscription_generation, offering_id,
          offering_revision, plan_key, price_key, amount_minor, currency, eligibility, quote_digest, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          clock_timestamp() + make_interval(secs => ${QUOTE_TTL_SECONDS}))
        RETURNING expires_at`,
      [quoteId, principalId, input.beneficiary, input.operation, subscriptionId, expectedGeneration,
        input.offeringId, input.offeringRevision, planKey, priceKey, amount, currency,
        JSON.stringify({ benefitEpoch, subscriptionGeneration: expectedGeneration }), quoteDigest]);
      const result = { quoteId, operation: input.operation, beneficiary: input.beneficiary,
        offeringId: input.offeringId, offeringRevision: input.offeringRevision, planKey, priceKey,
        subscriptionId, expectedGeneration, amountMinor: amount, currency, benefitEpoch, quoteDigest,
        expiresAt: inserted.rows[0]!.expires_at.toISOString() };
      await this.saveReceipt(client, principalId, receipt, 'quote', result);
      return { ...result, replayed: false };
    });
  }

  /** Consume one exact quote. A charged change creates one pending settlement
   * whose provider call happens after commit; free changes apply immediately. */
  async change(principal: VerifiedPrincipal, input: { quoteId: string; quoteDigest: string },
    receipt: CommerceReceipt): Promise<ChangeResult> {
    if (!uuid.test(input.quoteId) || !/^[0-9a-f]{64}$/.test(input.quoteDigest)) {
      throw new CommerceInvalid('invalid change request');
    }
    const result = await this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const prior = await this.receipt<ChangeResult>(client, principalId, receipt,
        ['purchase', 'change', 'cancel']);
      if (prior) return prior;
      const quote = (await client.query<Quote & { live: boolean; used: boolean }>(`SELECT q.*,
          q.expires_at > clock_timestamp() AS live,
          EXISTS (SELECT 1 FROM commerce.subscription_change c WHERE c.quote_id = q.id) AS used
        FROM commerce.quote q WHERE q.id = $1`, [input.quoteId])).rows[0];
      if (!quote || quote.principal_id !== principalId) throw new CommerceDenied('quote is unavailable to caller');
      if (quote.quote_digest !== input.quoteDigest) throw new CommerceInvalid('quote digest differs');
      if (quote.used) throw new CommerceStateConflict('quote was already used');
      if (!quote.live) throw new CommerceStale('quote expired');
      if (!await this.represents(client, principalId, quote.beneficiary, SUBSCRIBE_ACTION)) {
        throw new CommerceDenied('caller no longer represents the beneficiary');
      }
      const head = await client.query<{ head_revision: string; lifecycle: string }>(`SELECT o.head_revision,
        r.lifecycle FROM commerce.offering o JOIN commerce.offering_revision r
          ON r.offering_id = o.id AND r.revision = o.head_revision WHERE o.id = $1 FOR SHARE OF o`,
      [quote.offering_id]);
      if (head.rows[0]?.head_revision !== quote.offering_revision || head.rows[0].lifecycle !== 'open') {
        throw new CommerceStale('offering revision changed after quote');
      }
      const changeId = randomUUID();
      let subscriptionId: string;
      let resultGeneration: string;
      if (quote.operation === 'purchase') {
        subscriptionId = randomUUID();
        await client.query(`INSERT INTO commerce.subscription (id, principal_id, beneficiary, offering_id,
            group_key, group_semantics, offering_revision, plan_key, price_key, state, generation, provider)
          SELECT $1, $2, $3, l.offering_id, l.group_key, g.semantics, l.offering_revision, l.plan_key, $6,
            'pending', 1, 'fake'
          FROM commerce.plan l JOIN commerce.plan_group g ON g.offering_id = l.offering_id AND g.group_key = l.group_key
          WHERE l.offering_id = $4 AND l.offering_revision = $5 AND l.plan_key = $7`,
        [subscriptionId, principalId, quote.beneficiary, quote.offering_id, quote.offering_revision,
          quote.price_key, quote.plan_key]);
        resultGeneration = '1';
      } else {
        const subscription = (await client.query<Subscription>(`SELECT * FROM commerce.subscription
          WHERE id = $1 FOR UPDATE`, [quote.subscription_id])).rows[0]!;
        if (subscription.generation !== quote.expected_subscription_generation) {
          throw new CommerceStale('subscription generation changed after quote');
        }
        if (subscription.state !== 'active') throw new CommerceStateConflict('subscription is not active');
        const unresolved = await client.query(`SELECT 1 FROM commerce.settlement s
          JOIN commerce.subscription_change c ON c.id = s.change_id
          WHERE c.subscription_id = $1 AND s.state IN ('pending', 'unknown') LIMIT 1`, [subscription.id]);
        if (unresolved.rowCount) throw new CommerceStateConflict('an earlier settlement is unresolved');
        const updated = await client.query<{ generation: string }>(`UPDATE commerce.subscription
          SET generation = generation + 1, state = CASE WHEN $2 = 'cancel' THEN 'cancelling' ELSE state END
          WHERE id = $1 RETURNING generation`, [subscription.id, quote.operation]);
        subscriptionId = subscription.id;
        resultGeneration = updated.rows[0]!.generation;
      }
      await client.query(`INSERT INTO commerce.subscription_change (id, subscription_id, quote_id, operation,
          base_generation, result_generation, principal_id, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [changeId, subscriptionId, quote.id, quote.operation, (BigInt(resultGeneration) - 1n).toString(),
        resultGeneration, principalId, receipt.idempotencyKey]);
      let settlement: SettlementView | null = null;
      if (quote.operation !== 'cancel' && BigInt(quote.amount_minor) > 0n) {
        const settlementId = randomUUID();
        const reference = `rz-${settlementId}`;
        await client.query(`INSERT INTO commerce.settlement (id, change_id, provider, provider_reference,
          amount_minor, currency, state, generation) VALUES ($1, $2, 'fake', $3, $4, $5, 'pending', 1)`,
        [settlementId, changeId, reference, quote.amount_minor, quote.currency]);
        await client.query(`INSERT INTO commerce.settlement_event (settlement_id, generation, state, source)
          VALUES ($1, 1, 'pending', 'command')`, [settlementId]);
        settlement = { id: settlementId, state: 'pending', generation: '1', providerReference: reference };
      } else if (quote.operation !== 'cancel') {
        resultGeneration = await this.fulfill(client, changeId, null);
      }
      const view = { changeId, quoteId: quote.id, operation: quote.operation as ChangeResult['operation'],
        subscriptionId, subscriptionGeneration: resultGeneration, settlement };
      await this.saveReceipt(client, principalId, receipt, quote.operation, view);
      return { ...view, replayed: false };
    });
    if (result.replayed || !result.settlement) return result;
    const quote = await this.pool.query<{ amount_minor: string; currency: string }>(
      'SELECT amount_minor, currency FROM commerce.quote WHERE id = $1', [result.quoteId]);
    try {
      await this.provider.create({ reference: result.settlement.providerReference,
        amountMinor: quote.rows[0]!.amount_minor, currency: quote.rows[0]!.currency });
      return result;
    } catch {
      // The provider may or may not hold the payment: only reconciliation can tell.
      const unknown = await this.markUnknown(result.settlement.id);
      return { ...result, settlement: unknown ?? result.settlement };
    }
  }

  private async markUnknown(settlementId: string): Promise<SettlementView | null> {
    return this.transaction(async client => {
      const row = (await client.query<Settlement>(`SELECT * FROM commerce.settlement WHERE id = $1 FOR UPDATE`,
        [settlementId])).rows[0]!;
      if (row.state !== 'pending') return null;
      const next = (BigInt(row.generation) + 1n).toString();
      await client.query(`INSERT INTO commerce.settlement_event (settlement_id, generation, state, source)
        VALUES ($1, $2, 'unknown', 'command')`, [settlementId, next]);
      await client.query(`UPDATE commerce.settlement SET state = 'unknown', generation = $2 WHERE id = $1`,
        [settlementId, next]);
      return { id: row.id, state: 'unknown', generation: next, providerReference: row.provider_reference };
    });
  }

  /** Apply one change's effect after payment (or immediately when free).
   * The fulfillment unique index makes a second fulfillment impossible. */
  private async fulfill(client: PoolClient, changeId: string, settlementId: string | null): Promise<string> {
    const change = (await client.query<{ operation: string; subscription_id: string; offering_id: string;
      offering_revision: string; plan_key: string; price_key: string; billing_period: string }>(`
      SELECT c.operation, c.subscription_id, q.offering_id, q.offering_revision, q.plan_key, q.price_key,
        p.billing_period
      FROM commerce.subscription_change c JOIN commerce.quote q ON q.id = c.quote_id
      JOIN commerce.price p ON p.offering_id = q.offering_id AND p.offering_revision = q.offering_revision
        AND p.plan_key = q.plan_key AND p.price_key = q.price_key
      WHERE c.id = $1`, [changeId])).rows[0]!;
    const subscription = (await client.query<Subscription>(
      'SELECT * FROM commerce.subscription WHERE id = $1 FOR UPDATE', [change.subscription_id])).rows[0]!;
    let replaced: string | null = null;
    if (change.operation === 'change') {
      const current = await client.query<{ id: string; generation: string }>(`SELECT id, generation
        FROM commerce.entitlement WHERE subscription_id = $1 AND state = 'active'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [subscription.id]);
      if (current.rows[0]) {
        replaced = current.rows[0].id;
        const next = (BigInt(current.rows[0].generation) + 1n).toString();
        await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
          valid_until, change_id) VALUES ($1, $2, 'replace', 'ended', clock_timestamp(), $3)`,
        [replaced, next, changeId]);
        await client.query(`UPDATE commerce.entitlement SET state = 'ended', generation = $2,
          valid_until = clock_timestamp() WHERE id = $1`, [replaced, next]);
      }
    }
    const entitlementId = randomUUID();
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, subscription_id, replaces, valid_from, valid_until, state, generation)
      VALUES ($1, $2, 'purchase', $3, $4, $5, $6, $7, clock_timestamp(), ${periodEnd(change.billing_period)},
        'active', 1)`,
    [entitlementId, subscription.beneficiary, change.offering_id, change.offering_revision, change.plan_key,
      subscription.id, replaced]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
        valid_until, change_id, settlement_id)
      SELECT id, 1, 'grant', 'active', valid_until, $2, $3 FROM commerce.entitlement WHERE id = $1`,
    [entitlementId, changeId, settlementId]);
    const updated = await client.query<{ generation: string }>(`UPDATE commerce.subscription s
      SET state = 'active', generation = s.generation + 1, offering_revision = $2, plan_key = $3,
        price_key = $4, current_period_end = e.valid_until
      FROM commerce.entitlement e WHERE s.id = $1 AND e.id = $5 RETURNING s.generation`,
    [subscription.id, change.offering_revision, change.plan_key, change.price_key, entitlementId]);
    return updated.rows[0]!.generation;
  }

  /** Payment failed: a pending purchase fails; a change leaves the prior plan. */
  private async failChange(client: PoolClient, changeId: string): Promise<void> {
    await client.query(`UPDATE commerce.subscription s SET state = 'failed', generation = s.generation + 1
      FROM commerce.subscription_change c
      WHERE c.id = $1 AND c.operation = 'purchase' AND s.id = c.subscription_id AND s.state = 'pending'`,
    [changeId]);
  }

  /** A refund ends only the grant this settlement fulfilled. */
  private async refund(client: PoolClient, settlementId: string): Promise<void> {
    const grant = await client.query<{ id: string; generation: string; subscription_id: string }>(`
      SELECT e.id, e.generation, e.subscription_id FROM commerce.entitlement_event f
      JOIN commerce.entitlement e ON e.id = f.entitlement_id
      WHERE f.settlement_id = $1 AND f.action IN ('grant', 'renew') AND e.state = 'active'
      FOR UPDATE OF e`, [settlementId]);
    const row = grant.rows[0];
    if (!row) return;
    const next = (BigInt(row.generation) + 1n).toString();
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
      valid_until, settlement_id, reason_reference)
      VALUES ($1, $2, 'refund', 'ended', clock_timestamp(), $3, 'provider-refund')`, [row.id, next, settlementId]);
    await client.query(`UPDATE commerce.entitlement SET state = 'ended', generation = $2,
      valid_until = clock_timestamp() WHERE id = $1`, [row.id, next]);
    await client.query(`UPDATE commerce.subscription SET state = 'ended', generation = generation + 1
      WHERE id = $1 AND state IN ('active', 'cancelling')`, [row.subscription_id]);
  }

  /** Move a settlement one generation and apply its commercial effect. */
  private async advance(client: PoolClient, settlement: Settlement, state: 'succeeded' | 'failed' | 'refunded',
    source: { callback?: { provider: string; eventId: string }; reconciliationId?: string }): Promise<string> {
    const next = (BigInt(settlement.generation) + 1n).toString();
    await client.query(`INSERT INTO commerce.settlement_event (settlement_id, generation, state, source,
        callback_provider, callback_event_id, reconciliation_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [settlement.id, next, state, source.callback ? 'provider-callback' : 'reconciliation',
      source.callback?.provider ?? null, source.callback?.eventId ?? null, source.reconciliationId ?? null]);
    await client.query('UPDATE commerce.settlement SET state = $2, generation = $3 WHERE id = $1',
      [settlement.id, state, next]);
    if (state === 'succeeded') await this.fulfill(client, settlement.change_id, settlement.id);
    else if (state === 'failed') await this.failChange(client, settlement.change_id);
    else await this.refund(client, settlement.id);
    return next;
  }

  /** Verified, deduplicated provider callback. Unverified bodies never reach
   * the log; an unknown reference is retained as unmatched reconciliation work. */
  async recordCallback(rawBody: string, signature: string | null): Promise<CallbackResult> {
    let body: { provider?: unknown; eventId?: unknown; reference?: unknown; kind?: unknown };
    try { body = JSON.parse(rawBody) as typeof body; } catch { throw new CommerceInvalid('callback is not JSON'); }
    const { provider, eventId, reference, kind } = body;
    if (typeof provider !== 'string' || !key.test(provider) || typeof eventId !== 'string'
      || eventId.length < 1 || eventId.length > 256 || typeof reference !== 'string'
      || reference.length < 1 || reference.length > 256
      || !['payment.succeeded', 'payment.failed', 'refund.succeeded'].includes(String(kind))) {
      throw new CommerceInvalid('callback does not match the provider profile');
    }
    const providerRow = await this.pool.query<{ callback_key_reference: string }>(
      'SELECT callback_key_reference FROM commerce.payment_provider WHERE id = $1 AND enabled', [provider]);
    const secret = providerRow.rows[0] && this.callbackSecret(providerRow.rows[0].callback_key_reference);
    const expected = secret ? Buffer.from(signProviderCallback(secret, rawBody), 'hex') : null;
    const actual = signature && /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : null;
    if (!expected || !actual || !timingSafeEqual(expected, actual)) {
      throw new CommerceSignatureInvalid('callback signature is not verified');
    }
    const payloadDigest = createHash('sha256').update(rawBody).digest('hex');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-callback:${provider}:${eventId}`]);
      const prior = await client.query<{ payload_digest: string; disposition: CallbackResult['disposition'];
        settlement_id: string | null; state: string | null }>(`SELECT c.payload_digest, c.disposition,
          c.settlement_id, s.state FROM commerce.provider_callback c
        LEFT JOIN commerce.settlement s ON s.id = c.settlement_id
        WHERE c.provider = $1 AND c.provider_event_id = $2`, [provider, eventId]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_digest !== payloadDigest) {
          throw new CommerceKeyConflict('provider event identity binds another payload');
        }
        return { provider, eventId, disposition: prior.rows[0].disposition,
          settlementId: prior.rows[0].settlement_id, settlementState: prior.rows[0].state, replayed: true };
      }
      const settlement = (await client.query<Settlement>(`SELECT * FROM commerce.settlement
        WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`, [provider, reference])).rows[0];
      if (!settlement) {
        await client.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id,
            provider_reference, event_kind, payload_digest, disposition)
          VALUES ($1, $2, $3, $4, $5, 'unmatched')`, [provider, eventId, reference, kind, payloadDigest]);
        return { provider, eventId, disposition: 'unmatched' as const, settlementId: null,
          settlementState: null, replayed: false };
      }
      const open = settlement.state === 'pending' || settlement.state === 'unknown';
      const target = kind === 'payment.succeeded' && open ? 'succeeded'
        : kind === 'payment.failed' && open ? 'failed'
          : kind === 'refund.succeeded' && settlement.state === 'succeeded' ? 'refunded' : null;
      if (!target) {
        await client.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id,
            provider_reference, event_kind, payload_digest, disposition, settlement_id)
          VALUES ($1, $2, $3, $4, $5, 'no-effect', $6)`,
        [provider, eventId, reference, kind, payloadDigest, settlement.id]);
        return { provider, eventId, disposition: 'no-effect' as const, settlementId: settlement.id,
          settlementState: settlement.state, replayed: false };
      }
      await client.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id,
          provider_reference, event_kind, payload_digest, disposition, settlement_id, settlement_generation)
        VALUES ($1, $2, $3, $4, $5, 'applied', $6, $7)`,
      [provider, eventId, reference, kind, payloadDigest, settlement.id,
        (BigInt(settlement.generation) + 1n).toString()]);
      await this.advance(client, settlement, target, { callback: { provider, eventId } });
      return { provider, eventId, disposition: 'applied' as const, settlementId: settlement.id,
        settlementState: target, replayed: false };
    });
  }

  /** Explicit reconciliation of a pending or unknown settlement. The provider is
   * queried before the transaction; an unreachable provider stays still-unknown. */
  async reconcile(principal: VerifiedPrincipal, input: { settlementId: string; expectedGeneration: string },
    receipt: CommerceReceipt): Promise<ReconciliationResult> {
    if (!uuid.test(input.settlementId) || !generation.test(input.expectedGeneration)) {
      throw new CommerceInvalid('invalid reconciliation request');
    }
    const target = await this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const prior = await this.receipt<ReconciliationResult>(client, principalId, receipt, ['reconcile']);
      if (prior) return { prior };
      return { settlement: await this.ownedSettlement(client, principalId, input) };
    });
    if ('prior' in target) return target.prior!;
    let observed: ReconciliationResult['observed'];
    try { observed = await this.provider.lookup(target.settlement.provider_reference); }
    catch { observed = 'unavailable'; }
    return this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const prior = await this.receipt<ReconciliationResult>(client, principalId, receipt, ['reconcile']);
      if (prior) return prior;
      const settlement = await this.ownedSettlement(client, principalId, input);
      const id = randomUUID();
      const operationId = createHash('sha256')
        .update(`${principalId}\0${receipt.idempotencyKey}`).digest('hex');
      const next = (BigInt(settlement.generation) + 1n).toString();
      const state = observed === 'succeeded' ? 'succeeded'
        : observed === 'failed' || observed === 'not-found' ? 'failed' : null;
      const outcome = state ? 'applied' : observed === 'unavailable' ? 'still-unknown' : 'no-change';
      await client.query(`INSERT INTO commerce.reconciliation (id, operation_id, settlement_id, base_generation,
          observed, observation_digest, outcome, settlement_generation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, operationId, settlement.id, settlement.generation, observed,
        commerceIntentDigest({ reference: settlement.provider_reference, observed }), outcome,
        state ? next : null]);
      const settlementGeneration = state
        ? await this.advance(client, settlement, state, { reconciliationId: id }) : settlement.generation;
      const result = { reconciliationId: id, settlementId: settlement.id, observed,
        outcome: outcome as ReconciliationResult['outcome'], settlementState: state ?? settlement.state,
        settlementGeneration };
      await this.saveReceipt(client, principalId, receipt, 'reconcile', result);
      return { ...result, replayed: false };
    });
  }

  private async ownedSettlement(client: PoolClient, principalId: string,
    input: { settlementId: string; expectedGeneration: string }): Promise<Settlement> {
    const row = (await client.query<Settlement & { principal_id: string }>(`SELECT s.*, u.principal_id
      FROM commerce.settlement s JOIN commerce.subscription_change c ON c.id = s.change_id
      JOIN commerce.subscription u ON u.id = c.subscription_id WHERE s.id = $1 FOR UPDATE OF s`,
    [input.settlementId])).rows[0];
    if (!row || row.principal_id !== principalId) throw new CommerceDenied('settlement is unavailable to caller');
    if (row.generation !== input.expectedGeneration) throw new CommerceStale('settlement generation changed');
    if (row.state !== 'pending' && row.state !== 'unknown') {
      throw new CommerceStateConflict('settlement is already resolved');
    }
    return row;
  }

  /** Issue or revoke one complimentary award. It never touches a purchase. */
  async gift(principal: VerifiedPrincipal, input: GiftInput, receipt: CommerceReceipt): Promise<GiftResult> {
    if (!nativeId.test(input.issuerSubject) || input.reason.length < 1 || input.reason.length > 128
      || (input.operation === 'issue' && (!nativeId.test(input.beneficiary) || !uuid.test(input.offeringId)
        || !generation.test(input.offeringRevision) || !key.test(input.planKey)
        || Number.isNaN(Date.parse(input.validUntil))))
      || (input.operation === 'revoke' && (!uuid.test(input.entitlementId)
        || !generation.test(input.expectedGeneration)))) {
      throw new CommerceInvalid('invalid gift request');
    }
    return this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const prior = await this.receipt<GiftResult>(client, principalId, receipt, [input.operation === 'issue'
        ? 'gift' : 'revoke']);
      if (prior) return prior;
      const offeringId = input.operation === 'issue' ? input.offeringId
        : (await client.query<{ offering_id: string }>('SELECT offering_id FROM commerce.entitlement WHERE id = $1',
          [input.entitlementId])).rows[0]?.offering_id;
      const seller = offeringId && (await client.query<{ seller: string }>(
        'SELECT seller FROM commerce.offering WHERE id = $1', [offeringId])).rows[0]?.seller;
      if (!seller) throw new CommerceInvalid('offering or entitlement is unknown');
      const authorized = await this.represents(client, principalId, input.issuerSubject, GIFT_ACTION)
        && (await client.query(`SELECT 1 FROM access.permission_grant WHERE recipient_subject = $1
          AND scope_id = $2 AND action = $3 AND active AND valid_until > clock_timestamp()
          LIMIT 1 FOR SHARE`, [input.issuerSubject, giftScope(seller), GIFT_ACTION])).rowCount === 1;
      if (!authorized) throw new CommerceDenied('issuer authority for complimentary awards is missing');
      let view: Omit<GiftResult, 'replayed' | 'benefitEpoch'>;
      if (input.operation === 'issue') {
        const plan = await client.query(`SELECT 1 FROM commerce.plan WHERE offering_id = $1
          AND offering_revision = $2 AND plan_key = $3`, [input.offeringId, input.offeringRevision, input.planKey]);
        if (!plan.rowCount) throw new CommerceInvalid('plan is unknown');
        const entitlementId = randomUUID();
        const inserted = await client.query<{ valid_until: Date }>(`INSERT INTO commerce.entitlement (id,
            beneficiary, source, offering_id, offering_revision, plan_key, award_issuer, award_reason,
            valid_from, valid_until, state, generation)
          SELECT $1, $2, 'gift', $3, $4, $5, $6, $7, clock_timestamp(), $8::timestamptz, 'active', 1
          WHERE $8::timestamptz > clock_timestamp() AND $8::timestamptz <= clock_timestamp() + interval '1 year'
          RETURNING valid_until`,
        [entitlementId, input.beneficiary, input.offeringId, input.offeringRevision, input.planKey,
          input.issuerSubject, input.reason, input.validUntil]);
        if (!inserted.rows[0]) throw new CommerceInvalid('award validity must end within one year');
        await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
          valid_until) VALUES ($1, 1, 'grant', 'active', $2)`, [entitlementId, inserted.rows[0].valid_until]);
        view = { operation: 'issue', entitlementId, beneficiary: input.beneficiary, state: 'active',
          generation: '1', validUntil: inserted.rows[0].valid_until.toISOString() };
      } else {
        const row = (await client.query<{ beneficiary: string; source: string; award_issuer: string | null;
          state: string; generation: string; valid_until: Date }>(`SELECT beneficiary, source, award_issuer,
          state, generation, valid_until FROM commerce.entitlement WHERE id = $1 FOR UPDATE`,
        [input.entitlementId])).rows[0]!;
        if (row.source !== 'gift' || row.award_issuer !== input.issuerSubject) {
          throw new CommerceDenied('only the awarding issuer may revoke this grant');
        }
        if (row.generation !== input.expectedGeneration) throw new CommerceStale('award generation changed');
        if (row.state !== 'active') throw new CommerceStateConflict('award is no longer active');
        const next = (BigInt(row.generation) + 1n).toString();
        await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
          valid_until, reason_reference) VALUES ($1, $2, 'revoke', 'revoked', $3, $4)`,
        [input.entitlementId, next, row.valid_until, input.reason]);
        await client.query('UPDATE commerce.entitlement SET state = $2, generation = $3 WHERE id = $1',
          [input.entitlementId, 'revoked', next]);
        view = { operation: 'revoke', entitlementId: input.entitlementId, beneficiary: row.beneficiary,
          state: 'revoked', generation: next, validUntil: row.valid_until.toISOString() };
      }
      const result = { ...view, benefitEpoch: await this.benefitEpoch(client, view.beneficiary) };
      await this.saveReceipt(client, principalId, receipt, input.operation === 'issue' ? 'gift' : 'revoke', result);
      return { ...result, replayed: false };
    });
  }

  /** Effective benefits: the maximum level per benefit over independent active
   * grants, with each contributing grant and the epoch a consumer must recheck. */
  async benefits(principal: VerifiedPrincipal, beneficiary: string): Promise<BenefitResult> {
    if (!nativeId.test(beneficiary)) throw new CommerceInvalid('invalid beneficiary');
    return this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      if (!await this.represents(client, principalId, beneficiary, SUBSCRIBE_ACTION)) {
        throw new CommerceDenied('caller does not represent the beneficiary');
      }
      return resolveBenefits(client, beneficiary);
    });
  }

  async subscription(principal: VerifiedPrincipal, subscriptionId: string): Promise<SubscriptionView> {
    if (!uuid.test(subscriptionId)) throw new CommerceInvalid('invalid subscription');
    return this.transaction(async client => {
      const principalId = await this.principalId(client, principal);
      const row = (await client.query<Subscription>('SELECT * FROM commerce.subscription WHERE id = $1',
        [subscriptionId])).rows[0];
      if (!row || row.principal_id !== principalId) throw new CommerceDenied('subscription is unavailable');
      const settlements = await client.query<Settlement>(`SELECT s.* FROM commerce.settlement s
        JOIN commerce.subscription_change c ON c.id = s.change_id WHERE c.subscription_id = $1
        ORDER BY c.result_generation DESC LIMIT 20`, [subscriptionId]);
      return { subscriptionId: row.id, beneficiary: row.beneficiary, offeringId: row.offering_id,
        groupKey: row.group_key, groupSemantics: row.group_semantics, offeringRevision: row.offering_revision,
        planKey: row.plan_key, priceKey: row.price_key, state: row.state, generation: row.generation,
        currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
        settlements: settlements.rows.map(s => ({ id: s.id, state: s.state, generation: s.generation,
          providerReference: s.provider_reference })) };
    });
  }
}

/** Resolve effective benefits inside a caller's transaction (fixed bound). */
export async function resolveBenefits(client: PoolClient, beneficiary: string): Promise<BenefitResult> {
  const epoch = await client.query<{ epoch: string }>(
    'SELECT epoch FROM commerce.benefit_epoch WHERE beneficiary = $1 FOR SHARE', [beneficiary]);
  const rows = await client.query<{ id: string; source: 'purchase' | 'gift'; offering_id: string;
    plan_key: string; valid_until: Date; generation: string; benefit_key: string | null; level: number | null }>(`
    SELECT e.id, e.source, e.offering_id, e.plan_key, e.valid_until, e.generation, b.benefit_key, b.level
    FROM (SELECT * FROM commerce.entitlement WHERE beneficiary = $1 AND state = 'active'
      AND valid_until > clock_timestamp() AND valid_from <= clock_timestamp()
      ORDER BY valid_until, id LIMIT ${MAX_ACTIVE_GRANTS + 1}) e
    LEFT JOIN commerce.plan_benefit b USING (offering_id, offering_revision, plan_key)
    ORDER BY b.benefit_key, b.level DESC, e.id`, [beneficiary]);
  if (new Set(rows.rows.map(row => row.id)).size > MAX_ACTIVE_GRANTS) {
    throw new CommerceUnavailable('active grant budget exceeded');
  }
  const benefits = new Map<string, { benefitKey: string; level: number; grants: BenefitGrant[] }>();
  let freshUntil: Date | null = null;
  for (const row of rows.rows) {
    if (!freshUntil || row.valid_until < freshUntil) freshUntil = row.valid_until;
    if (!row.benefit_key || row.level === null) continue;
    const entry = benefits.get(row.benefit_key) ?? { benefitKey: row.benefit_key, level: row.level, grants: [] };
    entry.level = Math.max(entry.level, row.level);
    entry.grants.push({ entitlementId: row.id, source: row.source, offeringId: row.offering_id,
      planKey: row.plan_key, level: row.level, validUntil: row.valid_until.toISOString(),
      generation: row.generation });
    benefits.set(row.benefit_key, entry);
  }
  return { beneficiary, benefitEpoch: epoch.rows[0]?.epoch ?? '0',
    freshUntil: freshUntil?.toISOString() ?? null, benefits: [...benefits.values()] };
}
