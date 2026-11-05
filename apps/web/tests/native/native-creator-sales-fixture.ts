import { Pool } from 'pg';
import type { Page, Response as BrowserResponse } from 'playwright';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { createNativeEditionFixture } from '../../../../services/kernel/test/commerce/support/native-edition-fixture.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type SalesViewer = 'alice' | 'bob' | 'moderator' | 'anonymous';
export type SalesResponse = { address: string; status: number; headers: Record<string, string>; body: string };
export type SalesPage = {
  sales: { orderId: string; offerId: string; title: string; settlement: string; [key: string]: unknown }[];
  next: string | null;
  projectionState: 'ready' | 'preparing';
};
export type SaleDelivery = {
  orderId: string;
  creatorAccountId: string;
  revision: number;
  transactionId: string;
  workState: string | null;
  gap: string | null;
  sourceRevision: number | null;
  sourceTransactionId: string | null;
  sourceEventId: string | null;
  sourceEpoch: string | null;
  sourcePosition: string | null;
  sourceEventSeq: number | null;
  transitionId: string | null;
  resultId: string | null;
  outcome: string | null;
};
export type SalesPayment = {
  creator: 'alice' | 'bob';
  orderId: string;
  sessionId: string;
  event: { bytes: string; signature: string };
  webhook: SalesResponse;
  order: SalesResponse;
  delivery: SaleDelivery | null;
};
export type SalesRecording = {
  viewer: SalesViewer;
  accountId: string | null;
  requested: { cursor: string | null; address: string };
  current: string;
  next: { cursor: string; address: string } | null;
  api: SalesResponse;
  document: SalesResponse;
  navigation: SalesResponse;
  serverFunctions: SalesResponse[];
  nativeReads: { address: string; accountId: string | null; cursor: string | null }[];
  rendered: { text: string; rows: string[]; settlements: (string | null)[]; next: string | null };
};
export type SalesPreparation = {
  state: 'available' | 'unavailable';
  stage: string;
  /** The last actual interface response, including an unavailable producer response. */
  response: SalesResponse | null;
  payments: SalesPayment[];
};
export type SalesRefund = {
  event: { bytes: string; signature: string };
  webhook: SalesResponse;
  order: SalesResponse;
  entitlement: SalesResponse | null;
  delivery: SaleDelivery | null;
};
export type NativeCreatorSalesFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  prerequisites: readonly string[];
  accountIds: Record<Exclude<SalesViewer, 'anonymous'> | 'buyer', string>;
  pages: Record<SalesViewer, Page>;
  payments: SalesPayment[];
  /** Creates 21 Alice purchases and one Bob purchase through installed producer APIs. */
  prepare(): Promise<SalesPreparation>;
  record(viewer: SalesViewer, cursor?: string): Promise<SalesRecording>;
  read(viewer: SalesViewer, cursor?: string): Promise<SalesResponse>;
  refund(payment: SalesPayment): Promise<SalesRefund>;
  retireAlice(): Promise<SalesResponse>;
  payoutRepairAttempt(orderId: string): Promise<SalesResponse>;
  close(): Promise<void>;
};

export function salesAddress(origin: string, cursor?: string): string {
  const address = new URL('/en/creator/sales', origin);
  if (cursor !== undefined) address.searchParams.set('cursor', cursor);
  return address.href;
}

export async function recordSalesResponse(address: string, response: Response): Promise<SalesResponse> {
  return {
    address,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

async function recordBrowserResponse(response: BrowserResponse): Promise<SalesResponse> {
  return {
    address: response.url(),
    status: response.status(),
    headers: await response.allHeaders(),
    body: await response.text(),
  };
}

export function salesPage(response: SalesResponse): SalesPage | null {
  if (response.status !== 200 && response.status !== 202) return null;
  try {
    const body = JSON.parse(response.body) as SalesPage;
    return Array.isArray(body.sales) &&
      (body.next === null || typeof body.next === 'string') &&
      ['ready', 'preparing'].includes(body.projectionState)
      ? body
      : null;
  } catch {
    return null;
  }
}

function subject(authorization: string | null): string | null {
  if (!authorization) return null;
  const payload = authorization.split('.')[1];
  if (!payload) return null;
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub;
}

class ProducerUnavailable extends Error {
  constructor(readonly response: SalesResponse) {
    super(`${response.address} returned ${response.status}: ${response.body}`);
  }
}

/** Real Auth forms, native Checkout/webhooks and the existing creator-sale worker only.
 * The observer connection is read-only; it neither advances work nor certifies global coverage.
 * Call prepare(), inspect its state, then record(). An unavailable preparation is never positive Sales evidence.
 * These records are browser inputs for later review, not visual acceptance or cost evidence.
 */
export async function startNativeCreatorSalesFixture(): Promise<NativeCreatorSalesFixture> {
  const stripe = startFakeStripe();
  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  let observer: Pool | undefined;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      try {
        await auth?.stop();
      } finally {
        try {
          await observer?.end();
        } finally {
          try {
            await stack?.stop();
          } finally {
            stripe.stop();
          }
        }
      }
    })());
  try {
    stack = await startNativeWebStack({
      observePersonalAccess: true,
      commerce: {
        apiHost: `http://127.0.0.1:${stripe.port}`,
        webhookSecret: stripe.webhookSecret,
        successUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=success',
        cancelUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=canceled',
      },
    });
    const native = stack;
    auth = await startAuthStack(native);
    const sessions = auth;
    observer = new Pool({
      connectionString: native.databaseUrl,
      max: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=2000',
    });
    observer.on('error', () => {});
    const identities = {
      alice: await native.authPersona('alice'),
      bob: await native.authPersona('bob'),
      moderator: await native.authPersona('moderator'),
      buyer: await native.authPersona('outsider'),
    };
    const accountIds = Object.fromEntries(
      Object.entries(identities).map(([key, value]) => [key, value.accountId]),
    ) as NativeCreatorSalesFixture['accountIds'];
    const pages = {} as Record<SalesViewer, Page>;
    for (const viewer of ['alice', 'bob', 'moderator'] as const) {
      const journey = await sessions.signIn(viewer);
      const page = journey.context.pages().at(-1);
      if (!page) throw new Error(`Auth did not retain ${viewer}'s signed-in page`);
      pages[viewer] = page;
    }
    pages.anonymous = await (await sessions.context('anonymous')).newPage();
    const authorizations = new Map<SalesViewer, string>();
    const payments: SalesPayment[] = [];
    const offers = new Map<'alice' | 'bob', { id: string; revision: number }>();
    let preparation: Promise<SalesPreparation> | undefined;
    let retired = false;

    async function request(path: string, persona?: string, body?: unknown): Promise<SalesResponse> {
      const response = await native.kernel(
        path,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
              body: JSON.stringify(body),
            },
        persona,
      );
      return recordSalesResponse(new URL(path, native.kernelOrigin).href, response);
    }
    async function required(path: string, persona: string, body: unknown, status: number) {
      const response = await request(path, persona, body);
      if (response.status !== status) throw new ProducerUnavailable(response);
      return JSON.parse(response.body);
    }
    async function grant(accountId: string, resource: { route: number; id: string }, actions: string[]) {
      await required(
        '/v1/grants',
        'governor',
        {
          resource,
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        },
        201,
      );
    }
    async function delivery(orderId: string, creatorAccountId: string): Promise<SaleDelivery | null> {
      // Observe the exact committed source revision and matching receiving result.
      // A scheduler status, a covered frontier or a copied source is insufficient.
      const result = await observer!.query<SaleDelivery>(
        `
        SELECT o.order_id AS "orderId",o.creator_account_id AS "creatorAccountId",
          o.revision,o.transaction_id AS "transactionId",w.state AS "workState",w.gap,
          p.source_revision AS "sourceRevision",p.source_transaction_id AS "sourceTransactionId",
          p.source_event_id AS "sourceEventId",p.source_epoch::text AS "sourceEpoch",
          p.source_position::text AS "sourcePosition",p.source_event_seq AS "sourceEventSeq",t.transition_id AS "transitionId",
          g.result_id AS "resultId",g.outcome
        FROM commerce.purchase_order o
        LEFT JOIN commerce.creator_sale_work w ON (w.route,w.order_id)=(o.route,o.order_id)
        LEFT JOIN commerce.creator_sale p ON p.route=$3 AND p.order_id=o.order_id AND p.creator_account_id=o.creator_account_id
        LEFT JOIN access.live_copy_gate g ON g.route=p.route AND g.module='commerce.creator-sale'
          AND NOT g.retired AND g.outcome='applied'
          AND g.payload->>'creatorAccountId'=p.creator_account_id::text
          AND g.payload->'view'->>'orderId'=p.order_id::text
          AND (g.payload->>'revision')::integer=p.source_revision
          AND g.payload->>'transactionId'=p.source_transaction_id::text
          AND g.payload->>'eventId'=p.source_event_id::text
          AND (g.payload->>'epoch')::bigint=p.source_epoch
          AND (g.payload->>'position')::bigint=p.source_position
          AND (g.payload->>'eventSeq')::integer=p.source_event_seq
        LEFT JOIN access.live_copy_transition t ON t.route=o.route AND t.transition_id=g.transition_id
          AND t.source_domain=g.source_domain AND t.receiver_route=g.route
          AND t.receiver_domain=g.receiver_domain AND t.receiver_epoch=g.receiver_epoch
          AND t.result_id=g.result_id AND t.outcome=g.outcome AND t.state='complete'
        WHERE o.route=$1 AND o.order_id=$2 AND o.creator_account_id=$4 ORDER BY p.source_revision DESC LIMIT 1`,
        [routeOf(orderId), orderId, routeOf(creatorAccountId), creatorAccountId],
      );
      return result.rows[0] ?? null;
    }
    async function waitOrder(orderId: string): Promise<SalesResponse> {
      const deadline = Date.now() + 30_000;
      let response: SalesResponse;
      do {
        response = await request(`/v1/orders/${orderId}`, 'outsider');
        if (response.status !== 200) return response;
        const order = JSON.parse(response.body).order;
        if (order.settlement === 'paid') return response;
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      return response;
    }
    async function waitDelivery(orderId: string, creatorAccountId: string): Promise<SaleDelivery | null> {
      const deadline = Date.now() + 30_000;
      let result: SaleDelivery | null;
      do {
        result = await delivery(orderId, creatorAccountId);
        if (deliveredSale(result)) return result;
        if (result?.gap) return result;
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      return result;
    }
    async function deliver(event: { bytes: string; signature: string }) {
      return recordSalesResponse(
        new URL('/v1/webhooks/stripe', native.kernelOrigin).href,
        await native.kernel('/v1/webhooks/stripe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
          body: event.bytes,
        }),
      );
    }
    async function prepare(): Promise<SalesPreparation> {
      let stage = 'exposure';
      let last: SalesResponse | null = null;
      try {
        for (const feature of ['purchases', 'selling'])
          await required(`/v1/platform/exposure/${feature}:open`, 'governor', {}, 200);
        // The operator has only payout authority, which grants no creator rows or buyer repair authority.
        await grant(accountIds.moderator, { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }, [
          'payout_statement:mark_paid',
        ]);
        stage = 'offer';
        for (const creator of ['alice', 'bob'] as const) {
          await grant(accountIds[creator], { route: 0, id: '00000000-0000-8000-8000-000000000000' }, [
            'subject:create',
            'board:create',
          ]);
          await grant(accountIds[creator], { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }, [
            'offer:create',
          ]);
          const publisher = await createNativeEditionFixture((method, path, body, headers = {}) =>
            native.kernel(
              path,
              {
                method,
                headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              },
              creator,
            ),
          );
          const edition = await publisher.publish({
            title: `${creator}'s captured Sales edition`,
            body: 'Sales fixture edition',
          });
          const created = await required(
            '/v1/offers',
            creator,
            {
              targetSubjectId: edition.targetSubjectId,
              contentEditionId: edition.contentEditionId,
              title: `${creator}'s captured Sales edition`,
              currency: 'usd',
              unitAmountMinor: 1200,
              taxCode: 'txcd_10302000',
            },
            201,
          );
          const read = await request(`/v1/offers/${created.offer.id}`, creator);
          if (read.status !== 200) throw new ProducerUnavailable(read);
          const offer = JSON.parse(read.body).offer as { id: string; revision: number };
          offers.set(creator, offer);
          await grant(accountIds.buyer, { route: routeOf(offer.id)!, id: offer.id }, ['order:create']);
        }
        for (const creator of [...Array<'alice'>(21).fill('alice'), 'bob'] as const) {
          stage = 'checkout';
          const offer = offers.get(creator)!;
          const created = await required(
            '/v1/orders',
            'outsider',
            { offerId: offer.id, expectedOfferRevision: offer.revision },
            201,
          );
          const orderId = created.order.id as string;
          const session = [...stripe.sessions.values()].find((value) => value.client_reference_id === orderId);
          if (!session) throw new Error(`No captured Checkout Session for ${orderId}`);
          await stripe.pay(session.id);
          const event = await stripe.event('checkout.session.completed', session.id);
          stage = 'signed-payment';
          const webhook = (last = await deliver(event));
          const order = await waitOrder(orderId);
          stage = 'creator-sale-receiving';
          const received = await waitDelivery(orderId, accountIds[creator]);
          payments.push({ creator, orderId, sessionId: session.id, event, webhook, order, delivery: received });
          if (
            webhook.status !== 200 ||
            order.status !== 200 ||
            JSON.parse(order.body).order.settlement !== 'paid' ||
            !deliveredSale(received)
          )
            return { state: 'unavailable', stage, response: webhook.status !== 200 ? webhook : order, payments };
        }
        return { state: 'available', stage, response: last, payments };
      } catch (error) {
        if (!(error instanceof ProducerUnavailable)) throw error;
        return { state: 'unavailable', stage, response: error.response, payments };
      }
    }

    async function read(viewer: SalesViewer, cursor?: string): Promise<SalesResponse> {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor !== undefined) query.set('cursor', cursor);
      const path = `/v1/commerceSales?${query}`;
      const authorization = authorizations.get(viewer);
      if (viewer !== 'anonymous' && !authorization)
        throw new Error(`Record ${viewer}'s served route before reading its native response`);
      return recordSalesResponse(
        new URL(path, native.kernelOrigin).href,
        await native.kernel(path, { headers: authorization ? { authorization } : {} }),
      );
    }
    return {
      stack: native,
      auth: sessions,
      accountIds,
      pages,
      payments,
      prerequisites: [
        'installed real Auth/native Web stack',
        'owned fake Stripe with signed webhook delivery',
        'native creator-sale source admission and live-copy receiving',
        'read-only access to the owned kernel database',
      ],
      prepare() {
        return (preparation ??= prepare());
      },
      read,
      async record(viewer, cursor) {
        const page = pages[viewer];
        const address = salesAddress(native.web, cursor);
        await native.flushKernelRequests();
        const before = native.kernelRequests().length;
        const functions: Promise<SalesResponse>[] = [];
        const observe = (response: BrowserResponse) => {
          if (new URL(response.url()).pathname.startsWith('/_serverFn/'))
            functions.push(recordBrowserResponse(response));
        };
        page.on('response', observe);
        try {
          // Keep the served route response even if the ordinary browser follows its sign-in redirect.
          const served = await page.context().request.get(address, { maxRedirects: 0 });
          const document: SalesResponse = {
            address: served.url(),
            status: served.status(),
            headers: served.headers(),
            body: await served.text(),
          };
          await served.dispose();
          const navigation = await page.goto(address, { waitUntil: 'domcontentloaded' });
          if (!navigation) throw new Error(`No served document at ${address}`);
          await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
          const onSales = new URL(page.url()).pathname.replace(/\/$/, '') === '/en/creator/sales';
          if (onSales) {
            await page.locator('#creator-sales-heading').waitFor();
            await page
              .locator('#creator-sales-heading')
              .locator('..')
              .getByRole('link', { name: 'Refresh', exact: true })
              .waitFor();
          }
          await native.flushKernelRequests();
          const observed = native.kernelRequests().slice(before);
          const reads = observed.filter(
            (item) => !item.fixtureRequest && new URL(item.url, native.kernelOrigin).pathname === '/v1/commerceSales',
          );
          for (const item of observed.filter((item) => !item.fixtureRequest && item.authorization)) {
            const expected = viewer === 'anonymous' ? null : accountIds[viewer];
            if (subject(item.authorization) !== expected) throw new Error('Served Sales read used another viewer');
            if (item.authorization && !(retired && viewer === 'alice')) authorizations.set(viewer, item.authorization);
          }
          const api = await read(viewer, cursor);
          const section = onSales
            ? page.locator('section[aria-labelledby="creator-sales-heading"]')
            : page.locator('body');
          const nextLink = section.getByRole('link', { name: 'Older sales', exact: true });
          const nextHref = (await nextLink.count()) ? await nextLink.getAttribute('href') : null;
          const nextAddress = nextHref === null ? null : new URL(nextHref, native.web);
          const next = nextAddress?.searchParams.get('cursor') ?? null;
          return {
            viewer,
            accountId: viewer === 'anonymous' ? null : accountIds[viewer],
            requested: { cursor: cursor ?? null, address },
            current: page.url(),
            next: next === null ? null : { cursor: next, address: nextAddress!.href },
            api,
            document,
            navigation: await recordBrowserResponse(navigation),
            serverFunctions: await Promise.all(functions),
            nativeReads: reads.map((item) => ({
              address: new URL(item.url, native.kernelOrigin).href,
              accountId: subject(item.authorization),
              cursor: new URL(item.url, native.kernelOrigin).searchParams.get('cursor'),
            })),
            rendered: {
              text: await section.innerText(),
              rows: await section.locator('[data-settlement]').allTextContents(),
              settlements: await section
                .locator('[data-settlement]')
                .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-settlement'))),
              next: nextHref,
            },
          };
        } finally {
          page.off('response', observe);
        }
      },
      async refund(payment) {
        const refundId = stripe.refundRemaining(payment.sessionId, 'remaining');
        const event = await stripe.event('refund.created', refundId);
        const webhook = await deliver(event);
        const deadline = Date.now() + 30_000;
        let order: SalesResponse;
        let entitlement: SalesResponse | null;
        do {
          order = await waitOrder(payment.orderId);
          const entitlementId = order.status === 200 ? JSON.parse(order.body).order.entitlementId : null;
          entitlement = entitlementId ? await request(`/v1/entitlements/${entitlementId}`, 'outsider') : null;
          if (entitlement?.status === 200 && JSON.parse(entitlement.body).entitlement.revokeReason === 'refund') break;
          if (webhook.status !== 200 || order.status !== 200) break;
          await Bun.sleep(100);
        } while (Date.now() < deadline);
        return {
          event,
          webhook,
          order,
          entitlement,
          delivery: await waitDelivery(payment.orderId, accountIds[payment.creator]),
        };
      },
      async retireAlice() {
        const page = pages.alice;
        const saved = await page.context().cookies(native.web);
        await page.locator('#account-menu-button').click();
        const response = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/auth/sign-out' && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        const result = await recordBrowserResponse(await response);
        retired = true;
        // Replay the exact old website cookie; current Auth must reject its retired session.
        await page.context().addCookies(saved);
        return result;
      },
      payoutRepairAttempt(orderId) {
        return request(`/v1/orders/${orderId}:reconcile`, 'moderator', {});
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export function deliveredSale(row: SaleDelivery | null): boolean {
  return (
    !!row &&
    row.sourceRevision === row.revision &&
    row.sourceTransactionId === row.transactionId &&
    !!row.sourceEventId &&
    !!row.transitionId &&
    !!row.resultId &&
    row.outcome === 'applied'
  );
}
