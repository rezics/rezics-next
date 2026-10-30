import { randomUUID } from 'node:crypto';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const subjectTitle = 'A Field Guide to Stars';
const offerTitle = 'Digital edition';
const successUrl = 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=success';
const cancelUrl = 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=canceled';

export type NativePurchaseOrder = {
  id: string;
  offerId: string;
  sessionId: string;
  settlement: 'pending' | 'paid' | 'failed' | 'unknown';
  checkoutUrl: string | null;
};

type NativeCheckoutOrder = Omit<NativePurchaseOrder, 'sessionId'>;

export type NativeHistoryRow = {
  id: string;
  offerId: string;
  title: string;
  targetSubjectId: string;
  currency: string;
  unitAmountMinor: number;
  settlement: 'pending' | 'paid' | 'failed' | 'unknown';
  entitlementId: string | null;
  createdAt: string;
};

export type NativeHistoryPage = { orders: NativeHistoryRow[]; next: string | null; responseKeys: string[] };

export type NativePurchasesFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  stripe: ReturnType<typeof startFakeStripe>;
  offer: {
    id: string;
    title: string;
    subjectId: string;
    subjectTitle: string;
    unitAmountMinor: number;
  };
  paidOrderId: string | undefined;
  paidEntitlementId: string | undefined;
  failedOrderId: string | undefined;
  createOrder(persona?: 'alice' | 'bob'): Promise<NativePurchaseOrder>;
  orderFor(id: string, persona?: 'alice' | 'bob'): Promise<NativePurchaseOrder>;
  listOrders(persona: 'alice' | 'bob', cursor?: string, limit?: number): Promise<NativeHistoryPage>;
  delistOffer(): Promise<{ id: string; state: string }>;
  deliver(event: { bytes: Uint8Array; signature: string }): Promise<Response>;
  close(): Promise<void>;
};

async function expectStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status === status) return;
  throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
}

function idempotencyKey(): string {
  return JSON.stringify(randomUUID());
}

export async function startNativePurchasesFixture(): Promise<NativePurchasesFixture> {
  const stripe = startFakeStripe();
  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  try {
    stack = await startNativeWebStack({
      commerce: {
        apiHost: `http://127.0.0.1:${stripe.port}`,
        webhookSecret: stripe.webhookSecret,
        successUrl,
        cancelUrl,
      },
    });
    auth = await startAuthStack(stack);

    for (const group of ['purchases', 'selling']) {
      const opened = await stack.kernel(
        `/v1/platform/exposure/${group}:open`,
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } },
        'governor',
      );
      await expectStatus(opened, 200, `Open ${group} exposure`);
    }

    const alice = await stack.authPersona('alice');
    const grant = async (accountId: string, resource: { route: number; id: string }, actions: string[]) => {
      const response = await stack!.kernel(
        '/v1/grants',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
          body: JSON.stringify({
            resource,
            subject: { kind: 'account', id: accountId },
            actions,
            valid: '(,)',
          }),
        },
        'governor',
      );
      await expectStatus(response, 201, `Grant ${actions.join(', ')}`);
    };
    await grant(alice.accountId, { route: 0, id: GLOBAL_CONTEXT }, ['subject:create']);
    await grant(alice.accountId, { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }, ['offer:create']);

    const subjectResponse = await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: subjectTitle } }),
      },
      'alice',
    );
    await expectStatus(subjectResponse, 201, 'Create the bundled Book subject');
    const subject = ((await subjectResponse.json()) as { subject: { id: string } }).subject;

    const offerResponse = await stack.kernel(
      '/v1/offers',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({
          targetSubjectId: subject.id,
          title: offerTitle,
          currency: 'usd',
          unitAmountMinor: 1200,
          taxCode: 'txcd_10302000',
        }),
      },
      'alice',
    );
    await expectStatus(offerResponse, 201, 'Create the fixture offer');
    const offer = ((await offerResponse.json()) as { offer: { id: string } }).offer;
    const bob = await stack.authPersona('bob');
    const offerRoute = routeOf(offer.id);
    if (offerRoute === null) throw new Error(`Fixture offer ${offer.id} has no native route`);
    await grant(bob.accountId, { route: offerRoute, id: offer.id }, ['order:create']);
    async function createOrder(persona: 'alice' | 'bob' = 'alice'): Promise<NativePurchaseOrder> {
      const response = await stack!.kernel(
        '/v1/orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
          body: JSON.stringify({ offerId: offer.id }),
        },
        persona,
      );
      await expectStatus(response, 201, 'Create native Checkout order');
      const body = (await response.json()) as { order: NativeCheckoutOrder };
      const order = body.order;
      if (!order.checkoutUrl) throw new Error(`Native order ${order.id} has no provider Checkout URL`);
      const sessionId = new URL(order.checkoutUrl).pathname.split('/').at(-1);
      if (!sessionId) throw new Error(`Native order ${order.id} has no provider Session ID`);
      return { ...order, sessionId };
    }

    return {
      stack,
      auth,
      stripe,
      offer: { id: offer.id, title: offerTitle, subjectId: subject.id, subjectTitle, unitAmountMinor: 1200 },
      paidOrderId: undefined,
      paidEntitlementId: undefined,
      failedOrderId: undefined,
      createOrder,
      async orderFor(id, persona = 'alice') {
        const response = await stack!.kernel(`/v1/orders/${id}`, {}, persona);
        await expectStatus(response, 200, `Read native order ${id}`);
        const current = ((await response.json()) as { order: NativeCheckoutOrder }).order;
        const providerSession = [...stripe.sessions.values()].find((session) => session.client_reference_id === id);
        if (!providerSession) throw new Error(`No provider Session is bound to order ${id}`);
        const result = {
          ...current,
          sessionId: providerSession.id,
          checkoutUrl: current.checkoutUrl ?? providerSession.url,
        };
        return result;
      },
      async listOrders(persona, cursor, limit) {
        const query = new URLSearchParams();
        if (cursor) query.set('cursor', cursor);
        if (limit !== undefined) query.set('limit', String(limit));
        const suffix = query.size ? `?${query}` : '';
        const response = await stack!.kernel(`/v1/orders${suffix}`, {}, persona);
        await expectStatus(response, 200, 'Read native buyer order history');
        const body = (await response.json()) as Omit<NativeHistoryPage, 'responseKeys'>;
        return { ...body, responseKeys: Object.keys(body) };
      },
      async delistOffer() {
        const response = await stack!.kernel(
          `/v1/offers/${offer.id}:delist`,
          { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } },
          'alice',
        );
        await expectStatus(response, 200, 'Delist the captured offer');
        return ((await response.json()) as { offer: { id: string; state: string } }).offer;
      },
      async deliver(event) {
        return stack!.kernel('/v1/webhooks/stripe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
          body: event.bytes,
        });
      },
      async close() {
        const errors: unknown[] = [];
        for (const action of [async () => auth?.stop(), async () => stack?.stop(), async () => stripe.stop()]) {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Native purchase fixture cleanup failed');
      },
    };
  } catch (error) {
    try {
      await auth?.stop();
    } catch {}
    try {
      await stack?.stop();
    } catch {}
    stripe.stop();
    throw error;
  }
}
