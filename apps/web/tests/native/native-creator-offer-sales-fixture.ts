import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { Page } from 'playwright';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { createNativeEditionFixture } from '../../../../services/kernel/test/commerce/support/native-edition-fixture.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const offerTitle = 'Exact edition offer';
const subjectTitle = 'Native offer subject';
const taxCode = 'txcd_10302000';
const successUrl = 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=success';
const cancelUrl = 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=canceled';

export type NativeCreatorOfferSalesFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  stripe: ReturnType<typeof startFakeStripe>;
  evidenceDir: string;
  edition: {
    contentEditionId: string;
    targetSubjectId: string;
    revisionId: string;
    sha256: string;
    title: string;
    subjectTitle: string;
  };
  accountIds: { alice: string; bob: string; buyer: string };
  signIn(persona: 'alice' | 'bob' | 'outsider'): Promise<AuthJourney>;
  anonymousPage(): Promise<Page>;
  kernel<T>(path: string, persona?: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  waitSubjectOffer(offerId: string): Promise<Record<string, unknown>>;
  grantBuyer(offerId: string): Promise<void>;
  payOrder(orderId: string): Promise<void>;
  waitCreatorSale(orderId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

function key(): string {
  return JSON.stringify(crypto.randomUUID());
}

async function expectStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status === status) return;
  throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
}

export async function startNativeCreatorOfferSalesFixture(): Promise<NativeCreatorOfferSalesFixture> {
  const stripe = startFakeStripe();
  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  let observer: Pool | undefined;
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
    observer = new Pool({
      connectionString: stack.databaseUrl,
      max: 1,
      options: '-c statement_timeout=5000',
    });
    observer.on('error', () => {});
    const native = stack;
    const sessions = auth;
    for (const group of ['purchases', 'selling']) {
      const opened = await native.kernel(
        `/v1/platform/exposure/${group}:open`,
        { method: 'POST', headers: { 'idempotency-key': key() } },
        'governor',
      );
      await expectStatus(opened, 200, `Open ${group} exposure`);
    }
    const alice = await native.authPersona('alice');
    const bob = await native.authPersona('bob');
    const buyer = await native.authPersona('outsider');
    const grant = async (accountId: string, resource: { route: number; id: string }, actions: string[]) => {
      const response = await native.kernel(
        '/v1/grants',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key() },
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
    await grant(alice.accountId, { route: 0, id: GLOBAL_CONTEXT }, ['subject:create', 'board:create']);
    await grant(alice.accountId, { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }, ['offer:create']);
    const publisher = await createNativeEditionFixture((method, path, body, headers = {}) =>
      native.kernel(
        path,
        {
          method,
          headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        'alice',
      ),
    );
    const published = await publisher.publish({
      title: offerTitle,
      subjectTitle,
      body: 'Persona-authored exact edition bytes',
    });
    const evidenceDir = resolve(import.meta.dir, '../../../../.temp/worker-tmp/creator-offer-sales');
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });

    async function kernel<T>(path: string, persona?: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
      const response = await native.kernel(path, init, persona);
      const text = await response.text();
      let body: T;
      try {
        body = text ? (JSON.parse(text) as T) : (null as T);
      } catch {
        body = text as T;
      }
      return { status: response.status, body };
    }
    async function waitSubjectOffer(offerId: string): Promise<Record<string, unknown>> {
      const path = `/v1/subjects/${published.targetSubjectId}/offers`;
      const deadline = Date.now() + 20_000;
      let last: { status: number; body: { offers?: { id: string }[] } } | undefined;
      while (Date.now() < deadline) {
        last = await kernel(path);
        const found = last.body.offers?.find((row) => row.id === offerId);
        if (last.status === 200 && found) return found as Record<string, unknown>;
        await Bun.sleep(200);
      }
      // Reylo SQL modules are registered only after the native stack starts.
      const { projectSubjectOffer } = await import('../../../../services/kernel/src/commerce/subject-offer-work.ts');
      await projectSubjectOffer(observer!, offerId, Date.now() + 5_000);
      const projected = await kernel<{ offers: Record<string, unknown>[] }>(path);
      const found = projected.body.offers?.find((row) => row.id === offerId);
      if (projected.status !== 200 || !found)
        throw new Error(`Subject directory did not list ${offerId}: ${JSON.stringify(last ?? projected)}`);
      return found;
    }
    async function waitCreatorSale(orderId: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 30_000;
      let last: { status: number; body: { sales?: { orderId: string }[] } } | undefined;
      while (Date.now() < deadline) {
        last = await kernel('/v1/commerceSales?limit=20', 'alice');
        const found = last.body.sales?.find((row) => row.orderId === orderId);
        if (last.status === 200 && found) return found as Record<string, unknown>;
        await Bun.sleep(200);
      }
      throw new Error(`Creator sales did not include ${orderId}: ${JSON.stringify(last)}`);
    }

    return {
      stack: native,
      auth: sessions,
      stripe,
      evidenceDir,
      edition: {
        contentEditionId: published.contentEditionId,
        targetSubjectId: published.targetSubjectId,
        revisionId: published.revisionId,
        sha256: published.sha256,
        title: offerTitle,
        subjectTitle,
      },
      accountIds: { alice: alice.accountId, bob: bob.accountId, buyer: buyer.accountId },
      signIn(persona) {
        return sessions.signIn(persona);
      },
      async anonymousPage() {
        return (await sessions.context('anonymous')).newPage();
      },
      kernel,
      waitSubjectOffer,
      async grantBuyer(offerId) {
        const offerRoute = routeOf(offerId);
        if (offerRoute === null) throw new Error(`Offer ${offerId} has no native route`);
        await grant(buyer.accountId, { route: offerRoute, id: offerId }, ['order:create']);
      },
      async payOrder(orderId) {
        const session = [...stripe.sessions.values()].find((value) => value.client_reference_id === orderId);
        if (!session) throw new Error(`No captured Checkout Session for ${orderId}`);
        await stripe.pay(session.id);
        const event = await stripe.event('checkout.session.completed', session.id);
        const webhook = await native.kernel('/v1/webhooks/stripe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
          body: event.bytes,
        });
        await expectStatus(webhook, 200, 'Deliver signed checkout completion');
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const current = await kernel<{ order: { settlement: string } }>(`/v1/orders/${orderId}`, 'outsider');
          if (current.status === 200 && current.body.order.settlement === 'paid') return;
          await Bun.sleep(100);
        }
        throw new Error(`Order ${orderId} did not settle as paid`);
      },
      waitCreatorSale,
      async close() {
        const errors: unknown[] = [];
        for (const action of [
          async () => sessions.stop(),
          async () => observer?.end(),
          async () => native.stop(),
          async () => stripe.stop(),
        ]) {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Creator offer sales fixture cleanup failed');
      },
    };
  } catch (error) {
    try {
      await auth?.stop();
    } catch {}
    try {
      await observer?.end();
    } catch {}
    try {
      await stack?.stop();
    } catch {}
    stripe.stop();
    throw error;
  }
}

export { offerTitle, subjectTitle, taxCode };
