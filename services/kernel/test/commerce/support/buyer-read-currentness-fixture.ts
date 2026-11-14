import type { Pool, PoolClient } from 'pg';
import { insertOrder } from '../../../src/commerce/store.ts';
import type { Offer } from '../../../src/commerce/model.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { testKernel } from '../../support/test-kernel.ts';
import { createPersonas } from '../../support/personas.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { cookies, nativeFixture, password } from '../../access/native-account-bindings-fixture.ts';
import { registerTestClient } from '../../support/test-kernel.ts';

const clientId = 'buyer-read-currentness';
const scopes = ['order:read', 'entitlement:list', 'entitlement:read'];
const moneyUnit = { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' } as const;

function gatedPool(source: Pool, pause: () => Promise<void>) {
  return new Proxy(source, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          (client as PoolClient).query = ((...args: unknown[]) => {
            const config = args[0];
            const sql = typeof config === 'string' ? config : (config as { text?: string } | undefined)?.text;
            if (sql && /FROM semantic\.(?:definition_activation|subject)\b/i.test(sql))
              return pause().then(() => query(...(args as Parameters<typeof query>)));
            return query(...(args as Parameters<typeof query>));
          }) as typeof client.query;
          return client;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
}

export async function buyerReadCurrentnessFixture() {
  const db = await openGrowthDatabase();
  const auth = await nativeFixture(db.pool);
  let summaryPause: (() => Promise<void>) | undefined;
  const pool = gatedPool(db.pool, () => summaryPause?.() ?? Promise.resolve());
  const service = auth.host.service;
  const app = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
  });
  const people = await createPersonas(app, { version: 1, pool, auth });
  await registerTestClient(service, { clientId, firstParty: true, scopes });

  async function signIn(accountId: string) {
    const signed = await auth.request('/signin', {
      account_id: accountId,
      password,
      client_id: clientId,
      scope: scopes,
    });
    if (signed.status !== 200) throw new Error(`Buyer read sign-in failed: ${signed.status}`);
    const issued = await auth.request('/token', {}, cookies(signed));
    if (issued.status !== 200) throw new Error(`Buyer read token issuance failed: ${issued.status}`);
    return { accountId, bearer: (await issued.json()).access_token as string };
  }

  async function setConsent(accountId: string, selectedScopes: string[]) {
    const signed = await auth.request('/signin', {
      account_id: accountId,
      password,
      client_id: clientId,
      scope: scopes,
    });
    if (signed.status !== 200) throw new Error(`Buyer read consent sign-in failed: ${signed.status}`);
    const response = await auth.request('/consent', { client_id: clientId, scope: selectedScopes }, cookies(signed));
    if (response.status !== 200) throw new Error(`Buyer read consent update failed: ${response.status}`);
  }

  async function sameRoutePeer() {
    for (let n = 0; n < 2_000_000; n++) {
      const handle = `buyer_read_peer_${people.alice.accountId.replaceAll('-', '')}_${n}`;
      if (routeOf(auth.COMMANDS.internalLifecycle.registrationTarget(handle)) === routeOf(people.alice.accountId))
        return signIn((await auth.person(handle)).accountId);
    }
    throw new Error('No same-route buyer registration key found');
  }
  const peer = await sameRoutePeer();

  async function request(
    path: string,
    as: { accountId: string; bearer: string | null } = people.alice,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const { body, headers = {} } = options;
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(as.bearer === null ? {} : { authorization: `Bearer ${as.bearer}` }),
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  async function seedRefundedOrder(buyer: { accountId: string }, suffix: string) {
    const route = routeOf(buyer.accountId)!;
    const offer: Offer = {
      id: newId(route),
      creatorAccountId: people.staff.accountId,
      targetSubjectId: newId(0x5500),
      title: `Captured ${suffix}`,
      currency: 'usd',
      unitAmountMinor: 2500,
      moneyUnit,
      taxBehavior: 'exclusive',
      taxCode: 'txcd_10302000',
      royaltyBasisPoints: 9000,
      state: 'delisted',
      revision: 2,
      contentEdition: null,
    };
    const orderId = newId(route);
    const transactionId = Bun.randomUUIDv7();
    await insertOrder(
      pool,
      route,
      { id: orderId, buyerAccountId: buyer.accountId, offer },
      { transactionId, time: new Date().toISOString() },
    );
    const sessionId = `cs_test_buyerread_${suffix}`;
    await db.admin.query(
      `UPDATE commerce.purchase_order
       SET settlement='paid', checkout_session_id=$3, checkout_url='https://checkout.test/captured',
           checkout_expires_at=now()+interval '1 hour', amount_tax_minor=0, observed_at=now(), revision=revision+1
       WHERE route=$1 AND order_id=$2`,
      [route, orderId, sessionId],
    );
    await db.admin.query(
      `INSERT INTO commerce.money_observation
       (route,order_id,buyer_account_id,provider_object_id,context,account_namespace,livemode,
        provider_api_version,request_api_version,response_api_version,money_unit,economics_hash,
        amounts,observed_at,recorded_at,transaction_id)
       VALUES ($1,$2,$3,$4,'checkout.integration','buyer-read-test',false,
        '2026-11-14','2026-11-14','2026-11-14',$5::jsonb,$6,$7::jsonb,now(),now(),$8)`,
      [
        route,
        orderId,
        buyer.accountId,
        sessionId,
        JSON.stringify(moneyUnit),
        'a'.repeat(64),
        JSON.stringify({ currency: 'usd', amount_subtotal: 2500, amount_total: 2500, 'total_details.amount_tax': 0 }),
        transactionId,
      ],
    );
    const entitlementId = newId(route);
    await db.admin.query(
      `INSERT INTO commerce.entitlement
       (route,entitlement_id,account_id,order_id,offer_id,target_subject_id,granted_at,revoked_at,revoke_reason,
        revision,transaction_id,content_edition)
       SELECT $1,$2,$3,p.order_id,p.offer_id,p.target_subject_id,now(),now(),'refund',2,$4,p.content_edition
       FROM commerce.purchase_order p WHERE p.route=$1 AND p.order_id=$5 AND p.buyer_account_id=$3`,
      [route, entitlementId, buyer.accountId, transactionId, orderId],
    );
    return { orderId, entitlementId, targetSubjectId: offer.targetSubjectId };
  }

  async function openPurchases() {
    const response = await request('/v1/platform/exposure/purchases:open', people.staff, { body: {} });
    if (response.status !== 200) throw new Error(`Buyer read exposure setup failed: ${response.status}`);
  }

  return {
    db,
    pool,
    auth,
    app,
    people,
    peer,
    request,
    signIn,
    setConsent,
    seedRefundedOrder,
    openPurchases,
    async pauseSummary() {
      let reached!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (reached = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      let first = true;
      summaryPause = async () => {
        if (!first) return;
        first = false;
        reached();
        await held;
      };
      return {
        entered,
        release() {
          summaryPause = undefined;
          release();
        },
      };
    },
    async close() {
      summaryPause = undefined;
      await auth.close();
      await db.close();
    },
  };
}
