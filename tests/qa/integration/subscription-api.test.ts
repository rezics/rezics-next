import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { COMMERCE_SCOPE, CommerceStore, GIFT_ACTION, giftScope, HttpPaymentProvider, SUBSCRIBE_ACTION }
  from '../../../services/main/src/modules/commerce/store.ts';
import type { CommerceRouteDependencies } from '../../../services/main/src/routes/commerce.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { startFakePaymentProvider } from '../support/fake-payment.ts';

// SUB01-SUB03 through the real Main routes, a cloned Access PostgreSQL owner
// and the in-stack fake payment provider. Only Account token verification is
// replaced: each bearer names a fixture principal and its granted scopes.
const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://account.rezics.test';
const secret = 'fake-provider-callback-secret';
const iri = () => `https://rezics.com/id/${randomUUID()}`;

let pool: Pool;
let close: () => Promise<void>;
let provider: ReturnType<typeof startFakePaymentProvider>;
let app: ReturnType<typeof createMainApp>;
const seller = iri();

/** Count SQL statements per request to check the fixed-probe cost contract. */
let statements = 0;
function countingPool(inner: Pool): Pool {
  inner.on('connect', client => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      statements++;
      return query(...args);
    };
  });
  return inner;
}

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  close = databases.close;
  pool = countingPool(new Pool({ connectionString: databases.urls.access, max: 8 }));
  provider = startFakePaymentProvider(secret);
  await pool.query(`INSERT INTO commerce.payment_provider (id, kind, callback_key_reference)
    VALUES ('fake', 'fake', 'test:fake-callback')`);
  const commerce = new CommerceStore(pool, new HttpPaymentProvider(provider.url),
    reference => reference === 'test:fake-callback' ? secret : undefined);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const deps = {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(root, '.temp', `subscription-api-${randomUUID()}`) },
    account: { verify: async (request: Request, scopes: readonly string[]) => {
      const [subject, granted] = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('|');
      if (!subject || !scopes.every(scope => (granted ?? '').split(',').includes(scope))) {
        throw new AccountAssertionDenied('fixture bearer lacks scope');
      }
      return { issuer, subject };
    } },
    access: new AccessAdmissionRegistry(pool),
    commerce,
  } satisfies MainWorkDependencies & CommerceRouteDependencies;
  app = createMainApp(fuseki, deps);
}, 60_000);

afterAll(async () => {
  await provider?.stop();
  await pool?.end();
  await close?.();
}, 60_000);

/** One installation-provisioned offering per case, so revisions never cross cases. */
async function seedOffering(): Promise<string> {
  const offering = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1, $2, 'person', 1)`, [offering, seller]);
    await client.query(`INSERT INTO commerce.offering_revision (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1, 1, 'open', repeat('a', 64))`, [offering]);
    await client.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics)
      VALUES ($1, 'pro', 'replaceable'), ($1, 'addons', 'parallel')`, [offering]);
    await client.query(`INSERT INTO commerce.plan (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1, 1, 'basic', 'pro', 1), ($1, 1, 'plus', 'pro', 2),
             ($1, 1, 'export', 'addons', 0), ($1, 1, 'archive', 'addons', 0)`, [offering]);
    await client.query(`INSERT INTO commerce.price (offering_id, offering_revision, plan_key, price_key, currency,
        amount_minor, billing_period)
      VALUES ($1, 1, 'basic', 'monthly', 'USD', 500, 'P1M'), ($1, 1, 'plus', 'monthly', 'USD', 1500, 'P1M'),
             ($1, 1, 'export', 'monthly', 'USD', 100, 'P1M'), ($1, 1, 'archive', 'monthly', 'USD', 200, 'P1M')`,
    [offering]);
    await client.query(`INSERT INTO commerce.plan_benefit (offering_id, offering_revision, plan_key, benefit_key,
        level, quota_unit, quota_amount)
      VALUES ($1, 1, 'basic', 'pro.read', 1, NULL, NULL), ($1, 1, 'plus', 'pro.read', 2, NULL, NULL),
             ($1, 1, 'export', 'pro.export', 1, NULL, NULL), ($1, 1, 'archive', 'pro.archive', 1, NULL, NULL)`,
    [offering]);
    await client.query('COMMIT');
  } finally { client.release(); }
  return offering;
}

/** A fixture Account principal representing its own beneficiary Agent. */
async function person() {
  const principalId = randomUUID();
  const subject = `person-${principalId}`;
  const agent = iri();
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
    [principalId, issuer, subject]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [agent]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, agent, SUBSCRIBE_ACTION]);
  return { principalId, subject, agent, bearer: `Bearer ${subject}|${COMMERCE_SCOPE}` };
}

/** A seller-authorized gift issuer: representation plus an independent direct grant. */
async function giftIssuer() {
  const caller = await person();
  const issuerAgent = iri();
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')`, [issuerAgent]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), caller.principalId, issuerAgent, GIFT_ACTION]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [giftScope(seller)]);
  await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action,
    valid_until) VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
  [randomUUID(), issuerAgent, giftScope(seller), GIFT_ACTION]);
  return { ...caller, issuerAgent };
}

async function call(method: string, path: string, bearer: string | null, body?: unknown, key?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (bearer) headers.set('authorization', bearer);
  if (key) headers.set('idempotency-key', key);
  const response = await app.handle(new Request(`http://main.local${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function quote(who: { bearer: string; agent: string }, offering: string, body: Record<string, unknown>,
  key = randomUUID()) {
  return call('POST', '/v1/subscriptions/quotes', who.bearer, { profile: 'subscription-quote-v1',
    beneficiary: who.agent, offeringId: offering, offeringRevision: '1', ...body }, key);
}

async function buy(who: { bearer: string; agent: string }, offering: string, planKey: string) {
  const quoted = await quote(who, offering, { operation: 'purchase', planKey, priceKey: 'monthly' });
  expect(quoted.status).toBe(200);
  const changed = await call('POST', '/v1/subscriptions/changes', who.bearer, { profile: 'subscription-change-v1',
    quoteId: quoted.body.quoteId, quoteDigest: quoted.body.quoteDigest }, randomUUID());
  expect(changed.status).toBe(200);
  return changed.body;
}

async function deliver(delivery: { body: string; signature: string }) {
  const response = await app.handle(new Request('http://main.local/v1/subscriptions/settlements', {
    method: 'POST', headers: { 'content-type': 'text/plain', 'rezics-provider-signature': delivery.signature },
    body: delivery.body }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function benefits(who: { bearer: string; agent: string }) {
  const read = await call('GET', `/v1/subscriptions/benefits?beneficiary=${encodeURIComponent(who.agent)}`, who.bearer);
  expect(read.status).toBe(200);
  return read.body as { benefitEpoch: string; benefits: { benefitKey: string; level: number;
    grants: { entitlementId: string; source: string; planKey: string; generation: string }[] }[] };
}

const level = (result: Awaited<ReturnType<typeof benefits>>, key: string) =>
  result.benefits.find(entry => entry.benefitKey === key);

test('SUB01: a higher gift and a lower purchase stay independent grants and effective benefits', async () => {
  const offering = await seedOffering();
  const buyer = await person();
  const awarder = await giftIssuer();
  const grantsBefore = (await pool.query('SELECT count(*)::int AS n FROM access.permission_grant')).rows[0].n;
  // The higher gift arrives first and does not prevent buying the lower plan.
  const giftKey = randomUUID();
  const giftBody = { profile: 'subscription-gift-v1', operation: 'issue', issuerSubject: awarder.issuerAgent,
    beneficiary: buyer.agent, offeringId: offering, offeringRevision: '1', planKey: 'plus',
    validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), reason: 'launch-award' };
  const gift = await call('POST', '/v1/subscriptions/gifts', awarder.bearer, giftBody, giftKey);
  expect(gift.status).toBe(200);
  expect(gift.body).toMatchObject({ operation: 'issue', state: 'active', generation: '1', replayed: false });
  // Without the seller's direct gift grant, a representative cannot award.
  const stranger = await person();
  const denied = await call('POST', '/v1/subscriptions/gifts', stranger.bearer,
    { ...giftBody, issuerSubject: stranger.agent }, randomUUID());
  expect([denied.status, denied.body.code]).toEqual([403, 'commerce_denied']);

  const purchase = await buy(buyer, offering, 'basic');
  expect(purchase).toMatchObject({ operation: 'purchase', subscriptionGeneration: '1', replayed: false });
  expect(purchase.settlement).toMatchObject({ state: 'pending', generation: '1' });
  const paid = await deliver(provider.settle(purchase.settlement.providerReference, 'succeeded'));
  expect(paid.body).toMatchObject({ disposition: 'applied', settlementState: 'succeeded' });
  const both = await benefits(buyer);
  expect(level(both, 'pro.read')?.level).toBe(2);
  expect(level(both, 'pro.read')?.grants.map(grant => [grant.source, grant.planKey]).sort())
    .toEqual([['gift', 'plus'], ['purchase', 'basic']]);
  const subscription = await call('GET', `/v1/subscriptions/${purchase.subscriptionId}`, buyer.bearer);
  expect(subscription.body).toMatchObject({ state: 'active', planKey: 'basic', generation: '2' });
  // Another principal cannot read the payer's subscription or the beneficiary's benefits.
  expect((await call('GET', `/v1/subscriptions/${purchase.subscriptionId}`, stranger.bearer)).status).toBe(403);
  expect((await call('GET', `/v1/subscriptions/benefits?beneficiary=${encodeURIComponent(buyer.agent)}`,
    stranger.bearer)).status).toBe(403);
  expect((await call('GET', `/v1/subscriptions/${purchase.subscriptionId}`,
    `Bearer ${buyer.subject}|work:read`)).status).toBe(401);

  // Refunding the purchase ends only that grant; the gift keeps its level.
  const refunded = await deliver(provider.callback(purchase.settlement.providerReference, 'refund.succeeded'));
  expect(refunded.body).toMatchObject({ disposition: 'applied', settlementState: 'refunded' });
  const afterRefund = await benefits(buyer);
  expect(level(afterRefund, 'pro.read')?.grants.map(grant => grant.source)).toEqual(['gift']);
  expect((await call('GET', `/v1/subscriptions/${purchase.subscriptionId}`, buyer.bearer)).body.state).toBe('ended');

  // Revoking the gift ends only the gift; exact retry replays and stale generations conflict.
  const beforeRevocation = await quote(buyer, offering,
    { operation: 'purchase', planKey: 'basic', priceKey: 'monthly' });
  expect(beforeRevocation.status).toBe(200);
  const revokeBody = { profile: 'subscription-gift-v1', operation: 'revoke', issuerSubject: awarder.issuerAgent,
    entitlementId: gift.body.entitlementId, expectedGeneration: '1', reason: 'award-withdrawn' };
  const revokeKey = randomUUID();
  const revoked = await call('POST', '/v1/subscriptions/gifts', awarder.bearer, revokeBody, revokeKey);
  expect(revoked.body).toMatchObject({ state: 'revoked', generation: '2', replayed: false });
  expect((await call('POST', '/v1/subscriptions/gifts', awarder.bearer, revokeBody, revokeKey)).body)
    .toMatchObject({ state: 'revoked', replayed: true });
  const stale = await call('POST', '/v1/subscriptions/gifts', awarder.bearer, revokeBody, randomUUID());
  expect([stale.status, stale.body.code]).toEqual([409, 'commerce_stale']);
  const none = await benefits(buyer);
  expect(none.benefits).toEqual([]);
  expect(BigInt(none.benefitEpoch)).toBeGreaterThan(BigInt(both.benefitEpoch));
  const staleEligibility = await call('POST', '/v1/subscriptions/changes', buyer.bearer,
    { profile: 'subscription-change-v1', quoteId: beforeRevocation.body.quoteId,
      quoteDigest: beforeRevocation.body.quoteDigest }, randomUUID());
  expect([staleEligibility.status, staleEligibility.body.code]).toEqual([409, 'commerce_stale']);
  // The gift replay after revocation returns the original issue result, not current state.
  expect((await call('POST', '/v1/subscriptions/gifts', awarder.bearer, giftBody, giftKey)).body)
    .toMatchObject({ state: 'active', replayed: true });
  // No benefit became an Access permission grant.
  expect((await pool.query('SELECT count(*)::int AS n FROM access.permission_grant')).rows[0].n).toBe(grantsBefore);
}, 60_000);

test('SUB02: replaceable and parallel groups keep their semantics and exact quotes bind each change', async () => {
  const offering = await seedOffering();
  const buyer = await person();
  const basic = await buy(buyer, offering, 'basic');
  await deliver(provider.settle(basic.settlement.providerReference, 'succeeded'));
  // Replaceable: a second live purchase in the group is refused; a change is required.
  const second = await quote(buyer, offering, { operation: 'purchase', planKey: 'plus', priceKey: 'monthly' });
  expect([second.status, second.body.code]).toEqual([409, 'commerce_state_conflict']);
  // Parallel: independent purchases coexist.
  const exportPlan = await buy(buyer, offering, 'export');
  const archivePlan = await buy(buyer, offering, 'archive');
  await deliver(provider.settle(exportPlan.settlement.providerReference, 'succeeded'));
  await deliver(provider.settle(archivePlan.settlement.providerReference, 'succeeded'));

  // Exact quote replay and changed intent under the same key.
  const key = randomUUID();
  const changeQuote = await quote(buyer, offering, { operation: 'change', planKey: 'plus', priceKey: 'monthly',
    subscriptionId: basic.subscriptionId, expectedGeneration: '2' }, key);
  expect(changeQuote.body).toMatchObject({ amountMinor: '1500', planKey: 'plus', expectedGeneration: '2' });
  expect((await quote(buyer, offering, { operation: 'change', planKey: 'plus', priceKey: 'monthly',
    subscriptionId: basic.subscriptionId, expectedGeneration: '2' }, key)).body)
    .toMatchObject({ quoteId: changeQuote.body.quoteId, replayed: true });
  const changedIntent = await quote(buyer, offering, { operation: 'change', planKey: 'plus', priceKey: 'annual',
    subscriptionId: basic.subscriptionId, expectedGeneration: '2' }, key);
  expect([changedIntent.status, changedIntent.body.code]).toEqual([409, 'idempotency_conflict']);
  // A quote bound to an older subscription generation is stale.
  const staleQuote = await quote(buyer, offering, { operation: 'change', planKey: 'plus', priceKey: 'monthly',
    subscriptionId: basic.subscriptionId, expectedGeneration: '1' });
  expect([staleQuote.status, staleQuote.body.code]).toEqual([409, 'commerce_stale']);
  // The digest must match the exact quote.
  const wrongDigest = await call('POST', '/v1/subscriptions/changes', buyer.bearer, { profile: 'subscription-change-v1',
    quoteId: changeQuote.body.quoteId, quoteDigest: '0'.repeat(64) }, randomUUID());
  expect(wrongDigest.status).toBe(400);
  const changed = await call('POST', '/v1/subscriptions/changes', buyer.bearer, { profile: 'subscription-change-v1',
    quoteId: changeQuote.body.quoteId, quoteDigest: changeQuote.body.quoteDigest }, randomUUID());
  expect(changed.body).toMatchObject({ operation: 'change', subscriptionId: basic.subscriptionId,
    subscriptionGeneration: '3' });
  expect(changed.body.settlement).toMatchObject({ state: 'pending' });
  const reused = await call('POST', '/v1/subscriptions/changes', buyer.bearer, { profile: 'subscription-change-v1',
    quoteId: changeQuote.body.quoteId, quoteDigest: changeQuote.body.quoteDigest }, randomUUID());
  expect([reused.status, reused.body.code]).toEqual([409, 'commerce_state_conflict']);
  // Until the new plan is paid, the old plan's benefit stays exact.
  expect(level(await benefits(buyer), 'pro.read')?.grants.map(grant => grant.planKey)).toEqual(['basic']);
  await deliver(provider.settle(changed.body.settlement.providerReference, 'succeeded'));
  const replaced = await benefits(buyer);
  expect(level(replaced, 'pro.read')).toMatchObject({ level: 2 });
  expect(level(replaced, 'pro.read')?.grants.map(grant => grant.planKey)).toEqual(['plus']);
  expect(level(replaced, 'pro.export')?.level).toBe(1);
  expect(level(replaced, 'pro.archive')?.level).toBe(1);
  const chain = await pool.query<{ plan_key: string; state: string; replaced: boolean }>(`SELECT e.plan_key, e.state,
      e.replaces IS NOT NULL AS replaced FROM commerce.entitlement e
    WHERE e.subscription_id = $1 ORDER BY e.created_at`, [basic.subscriptionId]);
  expect(chain.rows).toEqual([{ plan_key: 'basic', state: 'ended', replaced: false },
    { plan_key: 'plus', state: 'active', replaced: true }]);
  const quoted = await pool.query<{ offering_revision: string; plan_key: string; amount_minor: string }>(
    'SELECT offering_revision, plan_key, amount_minor FROM commerce.quote WHERE id = $1', [changeQuote.body.quoteId]);
  expect(quoted.rows[0]).toEqual({ offering_revision: '1', plan_key: 'plus', amount_minor: '1500' });

  // A new offering revision makes an outstanding quote stale instead of charging an old price.
  const cancelQuote = await quote(buyer, offering, { operation: 'cancel', subscriptionId: exportPlan.subscriptionId,
    expectedGeneration: '2' });
  expect(cancelQuote.body).toMatchObject({ amountMinor: '0', planKey: null });
  const cancelled = await call('POST', '/v1/subscriptions/changes', buyer.bearer, { profile: 'subscription-change-v1',
    quoteId: cancelQuote.body.quoteId, quoteDigest: cancelQuote.body.quoteDigest }, randomUUID());
  expect(cancelled.body).toMatchObject({ operation: 'cancel', settlement: null, subscriptionGeneration: '3' });
  // Cancellation keeps the paid period's benefit; the archive add-on is untouched.
  expect(level(await benefits(buyer), 'pro.export')?.level).toBe(1);
  const pendingQuote = await quote(buyer, offering, { operation: 'cancel', subscriptionId: archivePlan.subscriptionId,
    expectedGeneration: '2' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO commerce.offering_revision (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1, 2, 'open', repeat('b', 64))`, [offering]);
    await client.query('UPDATE commerce.offering SET head_revision = 2 WHERE id = $1', [offering]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const late = await call('POST', '/v1/subscriptions/changes', buyer.bearer, { profile: 'subscription-change-v1',
    quoteId: pendingQuote.body.quoteId, quoteDigest: pendingQuote.body.quoteDigest }, randomUUID());
  expect([late.status, late.body.code]).toEqual([409, 'commerce_stale']);
  const oldRevision = await quote(buyer, offering, { operation: 'purchase', planKey: 'export', priceKey: 'monthly' });
  expect([oldRevision.status, oldRevision.body.code]).toEqual([409, 'commerce_stale']);
}, 60_000);

test('SUB03: duplicate, forged, unknown and lost settlement outcomes never charge or fulfill twice', async () => {
  const offering = await seedOffering();
  const buyer = await person();
  const purchase = await buy(buyer, offering, 'basic');
  const reference = purchase.settlement.providerReference;
  const creates = provider.creates;
  const delivery = provider.settle(reference, 'succeeded');
  // Concurrent duplicate deliveries: one applies, the other replays.
  const [first, second] = await Promise.all([deliver(delivery), deliver(delivery)]);
  expect([first.body.disposition, second.body.disposition]).toEqual(['applied', 'applied']);
  expect([first.body.replayed, second.body.replayed].sort()).toEqual([false, true]);
  // A distinct later success event for the same payment has no effect.
  expect((await deliver(provider.callback(reference, 'payment.succeeded'))).body.disposition).toBe('no-effect');
  // A changed payload under a used event ID conflicts; a forged signature is refused unrecorded.
  const tampered = provider.callback(reference, 'payment.failed', delivery.eventId);
  expect((await deliver(tampered)).status).toBe(409);
  const forged = await deliver({ body: provider.callback(reference, 'refund.succeeded', 'evt-forged').body,
    signature: '0'.repeat(64) });
  expect([forged.status, forged.body.code]).toEqual([401, 'callback_unverified']);
  expect((await pool.query(`SELECT 1 FROM commerce.provider_callback WHERE provider_event_id = 'evt-forged'`))
    .rowCount).toBe(0);
  const fulfilled = await pool.query(`SELECT count(*)::int AS n FROM commerce.entitlement_event f
    JOIN commerce.settlement s ON s.id = f.settlement_id WHERE s.provider_reference = $1 AND f.action = 'grant'`,
  [reference]);
  expect(fulfilled.rows[0].n).toBe(1);
  // Callbacks never call the provider: still one charge for this purchase.
  expect(provider.creates).toBe(creates);
  // An unknown reference is kept as unmatched reconciliation work.
  const unmatched = await deliver(provider.callback('rz-unknown-payment', 'payment.succeeded'));
  expect(unmatched.body).toMatchObject({ disposition: 'unmatched', settlementId: null });

  // A payment failure fails the pending purchase without granting anything.
  const failing = await person();
  const failed = await buy(failing, offering, 'basic');
  expect((await deliver(provider.settle(failed.settlement.providerReference, 'failed'))).body.settlementState)
    .toBe('failed');
  expect((await call('GET', `/v1/subscriptions/${failed.subscriptionId}`, failing.bearer)).body.state).toBe('failed');
  expect((await benefits(failing)).benefits).toEqual([]);

  // Lost provider response: the settlement is unknown, not assumed failed or paid.
  const lost = await person();
  provider.setMode('lose-response');
  const unknown = await buy(lost, offering, 'basic');
  provider.setMode('normal');
  expect(unknown.settlement).toMatchObject({ state: 'unknown', generation: '2' });
  expect(provider.payment(unknown.settlement.providerReference)?.status).toBe('pending');
  expect((await benefits(lost)).benefits).toEqual([]);
  // An unavailable provider leaves it unknown and records still-unknown work.
  provider.setMode('unavailable');
  const blind = await call('POST', '/v1/subscriptions/reconciliations', lost.bearer, {
    profile: 'subscription-reconciliation-v1', settlementId: unknown.settlement.id, expectedGeneration: '2' },
  randomUUID());
  provider.setMode('normal');
  expect(blind.body).toMatchObject({ observed: 'unavailable', outcome: 'still-unknown', settlementState: 'unknown',
    settlementGeneration: '2' });
  // The provider meanwhile captured the payment; reconciliation applies it exactly once.
  const late = provider.settle(unknown.settlement.providerReference, 'succeeded');
  const reconcileKey = randomUUID();
  const reconcileBody = { profile: 'subscription-reconciliation-v1', settlementId: unknown.settlement.id,
    expectedGeneration: '2' };
  const applied = await call('POST', '/v1/subscriptions/reconciliations', lost.bearer, reconcileBody, reconcileKey);
  expect(applied.body).toMatchObject({ observed: 'succeeded', outcome: 'applied', settlementState: 'succeeded',
    settlementGeneration: '3', replayed: false });
  expect((await call('POST', '/v1/subscriptions/reconciliations', lost.bearer, reconcileBody, reconcileKey)).body)
    .toMatchObject({ reconciliationId: applied.body.reconciliationId, replayed: true });
  const resolved = await call('POST', '/v1/subscriptions/reconciliations', lost.bearer, reconcileBody, randomUUID());
  expect([resolved.status, resolved.body.code]).toEqual([409, 'commerce_stale']);
  // The late provider callback now has no effect: one grant, one charge.
  expect((await deliver(late)).body.disposition).toBe('no-effect');
  expect(level(await benefits(lost), 'pro.read')?.grants).toHaveLength(1);
  const history = await pool.query<{ state: string; source: string }>(`SELECT state, source FROM commerce.settlement_event
    WHERE settlement_id = $1 ORDER BY generation`, [unknown.settlement.id]);
  expect(history.rows).toEqual([{ state: 'pending', source: 'command' }, { state: 'unknown', source: 'command' },
    { state: 'succeeded', source: 'reconciliation' }]);
  // Only the payer may reconcile its settlement.
  const other = await person();
  expect((await call('POST', '/v1/subscriptions/reconciliations', other.bearer, reconcileBody, randomUUID())).status)
    .toBe(403);
}, 60_000);

test('SUB01/SUB02/SUB03: a held Access recovery fence changes nothing and the same key then completes once', async () => {
  const offering = await seedOffering();
  const buyer = await person();
  const quoted = await quote(buyer, offering, { operation: 'purchase', planKey: 'basic', priceKey: 'monthly' });
  const key = randomUUID();
  const body = { profile: 'subscription-change-v1', quoteId: quoted.body.quoteId, quoteDigest: quoted.body.quoteDigest };
  await pool.query('UPDATE access.recovery_fence SET open = false, generation = generation + 1');
  try {
    const held = await call('POST', '/v1/subscriptions/changes', buyer.bearer, body, key);
    expect([held.status, held.body.code]).toEqual([503, 'commerce_unavailable']);
    const held2 = await deliver(provider.callback('rz-anything', 'payment.succeeded'));
    expect(held2.status).toBe(503);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open = true, generation = generation + 1');
  }
  expect((await pool.query('SELECT 1 FROM commerce.subscription_change WHERE quote_id = $1',
    [quoted.body.quoteId])).rowCount).toBe(0);
  const done = await call('POST', '/v1/subscriptions/changes', buyer.bearer, body, key);
  expect(done.body).toMatchObject({ operation: 'purchase', replayed: false });
  expect((await call('POST', '/v1/subscriptions/changes', buyer.bearer, body, key)).body)
    .toMatchObject({ changeId: done.body.changeId, replayed: true });
}, 60_000);

test('SUB01/SUB03: benefit and callback work stays fixed as unrelated commerce history grows', async () => {
  const offering = await seedOffering();
  const buyer = await person();
  const purchase = await buy(buyer, offering, 'basic');
  await deliver(provider.settle(purchase.settlement.providerReference, 'succeeded'));
  async function measure() {
    statements = 0;
    await benefits(buyer);
    const read = statements;
    statements = 0;
    await deliver(provider.callback(purchase.settlement.providerReference, 'payment.succeeded'));
    return [read, statements];
  }
  const small = await measure();
  // 2,000 unrelated gift grants and callbacks for other beneficiaries.
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ('https://rezics.com/id/00000000-0000-4000-8000-000000000000', 'institution') ON CONFLICT DO NOTHING`);
  await pool.query(`WITH grants AS (
      INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision, plan_key,
        award_issuer, award_reason, valid_from, valid_until, state, generation)
      SELECT gen_random_uuid(), 'https://rezics.com/id/' || gen_random_uuid(), 'gift', $1, 1, 'basic',
        'https://rezics.com/id/00000000-0000-4000-8000-000000000000', 'bulk', now(), now() + interval '1 day', 'active', 1
      FROM generate_series(1, 2000) RETURNING id, valid_until)
    INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state, valid_until)
    SELECT id, 1, 'grant', 'active', valid_until FROM grants`, [offering]);
  await pool.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id, provider_reference, event_kind,
      payload_digest, disposition)
    SELECT 'fake', 'bulk-' || n, 'rz-bulk-' || n, 'payment.succeeded', repeat('c', 64), 'unmatched'
    FROM generate_series(1, 2000) AS n`);
  await pool.query('ANALYZE commerce.entitlement; ANALYZE commerce.provider_callback');
  expect(await measure()).toEqual(small);
  const plan = await pool.query<{ 'QUERY PLAN': unknown[] }>(`EXPLAIN (FORMAT JSON) SELECT * FROM commerce.entitlement
    WHERE beneficiary = $1 AND state = 'active' AND valid_until > clock_timestamp() ORDER BY valid_until, id LIMIT 65`,
  [buyer.agent]);
  expect(JSON.stringify(plan.rows[0]!['QUERY PLAN'])).toContain('entitlement_effective');
}, 60_000);
