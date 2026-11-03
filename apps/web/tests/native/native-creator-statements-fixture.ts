import { randomUUID } from 'node:crypto';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { createNativeEditionFixture } from '../../../../services/kernel/test/commerce/support/native-edition-fixture.ts';
import { statementHref, statementsHref } from '../../src/checkout/creator-statements-page.tsx';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

type NativeStatement = {
  id: string;
  creatorAccountId: string;
  period: string;
  currency: string;
  moneyUnit: { system: 'stripe-api'; exponent: 0 | 2; factsVersion: 'stripe-money-v1' } | null;
  grossMinor: number;
  taxMinor: number;
  feeMinor: number;
  disputeFeeMinor: number;
  refundsMinor: number;
  chargebacksMinor: number;
  netReceiptsMinor: number;
  creatorShareMinor: number;
  rezicsShareMinor: number;
  weightedNetMinor: string;
  state: 'open' | 'paid';
  paidAt: string | null;
  paidReference: string | null;
  revision: number;
};

type NativeStatementLine = {
  balanceTransactionId: string;
  orderId: string;
  offerId: string;
  creatorAccountId: string;
  currency: string;
  moneyUnit: NativeStatement['moneyUnit'];
  kind: 'charge' | 'refund' | 'refund_reversal' | 'dispute' | 'dispute_reversal';
  created: string;
  grossMinor: number;
  taxMinor: number;
  feeMinor: number;
  disputeFeeMinor: number;
  netReceiptsMinor: number;
  royaltyBasisPoints: number;
  period: string;
  statementId: string;
  recordedAt: string;
};

type NativeStatementList = { payoutStatements: NativeStatement[]; next: string | null };
type NativeStatementLines = { lines: NativeStatementLine[]; next: string | null };
type NativePaidAttestation = {
  id: string;
  state: 'paid';
  paidAt: string;
  paidReference: string;
  revision: number;
};

export type NativeCreatorStatementsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  stripe: ReturnType<typeof startFakeStripe>;
  accounts: {
    creator: string;
    otherCreator: string;
    buyer: string;
    payoutOperator: string;
  };
  offers: { usd: string; eur: string; otherCreator: string };
  orders: { usd: string; eur: string; otherCreator: string };
  statements: { paid: NativeStatement; paged: NativeStatement; otherCreator: NativeStatement };
  lines: { first: NativeStatementLines; next: NativeStatementLines };
  commandKeys: Readonly<Record<string, string>>;
  listCursor: string;
  lineCursor: string;
  responses: {
    webhook: readonly Response[];
    markPaid: Response;
    listFirst: Response;
    listNext: Response;
    detail: Response;
    linesFirst: Response;
    linesNext: Response;
    otherCreatorDetail: Response;
    suspendedList: Response;
    webList: Response;
    webDetail: Response;
    otherCreatorWebDetail: Response;
  };
  addresses: {
    list: string;
    listContinuation: string;
    detail: string;
    detailLineContinuation: string;
    otherCreatorDetail: string;
  };
  close(): Promise<void>;
};

async function expectStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status === status) return;
  throw new Error(`${label} returned ${response.status}: ${await response.clone().text()}`);
}

function commandKey(): string {
  return JSON.stringify(randomUUID());
}

function json<T>(response: Response): Promise<T> {
  return response.clone().json() as Promise<T>;
}

function query(path: string, values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== undefined) params.set(name, value);
  return `${path}${params.size ? `?${params}` : ''}`;
}

export async function startNativeCreatorStatementsFixture(): Promise<NativeCreatorStatementsFixture> {
  const stripe = startFakeStripe();
  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  try {
    stack = await startNativeWebStack({
      commerce: {
        apiHost: `http://127.0.0.1:${stripe.port}`,
        webhookSecret: stripe.webhookSecret,
        successUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=success',
        cancelUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=canceled',
      },
    });
    auth = await startAuthStack(stack);

    const commandKeys: Record<string, string> = {};
    const keyed = (name: string) => (commandKeys[name] = commandKey());
    for (const group of ['purchases', 'selling']) {
      const idempotencyKey = keyed(`exposure:${group}`);
      const opened = await stack.kernel(
        `/v1/platform/exposure/${group}:open`,
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey } },
        'governor',
      );
      await expectStatus(opened, 200, `Open ${group} exposure`);
    }

    const creator = await stack.authPersona('alice');
    const otherCreator = await stack.authPersona('bob');
    const buyer = otherCreator;
    const payoutOperator = otherCreator;
    const grant = async (accountId: string, resource: { route: number; id: string }, actions: string[]) => {
      const label = `grant:${accountId}:${actions.join(',')}`;
      const response = await stack!.kernel(
        '/v1/grants',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': keyed(label) },
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
    for (const accountId of [creator.accountId, otherCreator.accountId]) {
      await grant(accountId, { route: 0, id: GLOBAL_CONTEXT }, ['subject:create', 'board:create']);
      await grant(accountId, { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }, ['offer:create']);
    }
    await grant(payoutOperator.accountId, { route: 0, id: GLOBAL_CONTEXT }, ['payout_statement:mark_paid']);

    const createOffer = async (persona: 'alice' | 'bob', currency: 'usd' | 'eur', title: string) => {
      const publisher = await createNativeEditionFixture((method, path, body, headers = {}) =>
        stack!.kernel(
          path,
          {
            method,
            headers: {
              ...headers,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          persona,
        ),
      );
      const edition = await publisher.publish({
        title,
        subjectTitle: `${title} subject`,
        body: `Native creator statement source for ${title}`,
      });
      const created = await stack!.kernel(
        '/v1/offers',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': keyed(`offer:${persona}:${currency}`) },
          body: JSON.stringify({
            targetSubjectId: edition.targetSubjectId,
            contentEditionId: edition.contentEditionId,
            title,
            currency,
            unitAmountMinor: 1200,
            taxCode: 'txcd_10302000',
          }),
        },
        persona,
      );
      await expectStatus(created, 201, `Create ${persona} ${currency} offer`);
      const offerId = ((await json<{ offer: { id: string } }>(created)).offer.id);
      const current = await stack!.kernel(`/v1/offers/${offerId}`, {}, persona);
      await expectStatus(current, 200, `Read ${persona} ${currency} offer`);
      const offer = (await json<{ offer: { id: string; revision: number } }>(current)).offer;
      return { ...offer, currency };
    };

    const [usd, eur, otherCreatorOffer] = await Promise.all([
      createOffer('alice', 'usd', 'Native statement USD edition'),
      createOffer('alice', 'eur', 'Native statement EUR edition'),
      createOffer('bob', 'usd', 'Other creator statement edition'),
    ]);

    const createSale = async (
      offer: { id: string; revision: number; currency: string },
      seller: 'alice' | 'bob',
      purchaser: 'alice' | 'bob',
      name: string,
    ) => {
      const route = routeOf(offer.id);
      if (route === null) throw new Error(`Offer ${offer.id} has no native route`);
      const purchaserId = purchaser === 'alice' ? creator.accountId : otherCreator.accountId;
      await grant(purchaserId, { route, id: offer.id }, ['order:create']);
      const response = await stack!.kernel(
        '/v1/orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': keyed(`order:${name}`) },
          body: JSON.stringify({ offerId: offer.id, expectedOfferRevision: offer.revision }),
        },
        purchaser,
      );
      await expectStatus(response, 201, `Create ${name} order`);
      const order = (await json<{ order: { id: string; checkoutUrl: string | null } }>(response)).order;
      if (!order.checkoutUrl) throw new Error(`Native order ${order.id} has no provider Checkout URL`);
      const sessionId = new URL(order.checkoutUrl).pathname.split('/').at(-1);
      if (!sessionId) throw new Error(`Native order ${order.id} has no provider Session ID`);

      await stripe.pay(sessionId);
      stripe.refundRemaining(sessionId, 125);
      const event = await stripe.event('checkout.session.completed', sessionId);
      const webhook = await stack!.kernel('/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
        body: event.bytes,
      });
      await expectStatus(webhook, 200, `Deliver ${name} Stripe event`);
      return { id: order.id, sessionId, seller, purchaser, webhook };
    };

    const [usdSale, eurSale, otherSale] = await Promise.all([
      createSale(usd, 'alice', 'bob', 'alice-usd'),
      createSale(eur, 'alice', 'bob', 'alice-eur'),
      createSale(otherCreatorOffer, 'bob', 'alice', 'bob-usd'),
    ]);

    const list = async (persona: 'alice' | 'bob' | 'suspended', cursor?: string, limit = 100) =>
      stack!.kernel(`/v1/payoutStatements${query('', { cursor, limit: String(limit) })}`, {}, persona);
    const waitForCurrency = async (persona: 'alice' | 'bob', currency: string): Promise<NativeStatement> => {
      const deadline = Date.now() + 30_000;
      let latest = 'no list response';
      while (Date.now() < deadline) {
        const response = await list(persona);
        latest = `${response.status} ${await response.clone().text()}`;
        if (response.ok) {
          const page = await json<NativeStatementList>(response);
          const statement = page.payoutStatements.find((item) => item.currency === currency);
          if (statement) return statement;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Native ${persona} ${currency} statement did not arrive: ${latest}`);
    };
    const paidStatement = await waitForCurrency('alice', 'usd');
    const eurStatement = await waitForCurrency('alice', 'eur');
    const otherStatement = await waitForCurrency('bob', 'usd');
    const beforePaid = await stack.kernel(`/v1/payoutStatements/${paidStatement.id}`, {}, 'alice');
    await expectStatus(beforePaid, 200, 'Read open creator statement');
    const originalStatement = (await json<{ statement: NativeStatement }>(beforePaid)).statement;
    const paidReference = `external-test-reference:${randomUUID()}`;
    const markPaidKey = keyed('mark-paid:alice-usd');
    const markPaid = await stack.kernel(`/v1/payoutStatements/${paidStatement.id}:markPaid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': markPaidKey },
      body: JSON.stringify({ paidReference }),
    }, 'bob');
    await expectStatus(markPaid, 200, 'Record authorized external-payment attestation');
    const paidAttestation = (await json<{ statement: NativePaidAttestation }>(markPaid)).statement;
    if (
      paidAttestation.id !== originalStatement.id ||
      paidAttestation.revision !== originalStatement.revision + 1 ||
      paidAttestation.paidReference !== paidReference ||
      !Number.isFinite(Date.parse(paidAttestation.paidAt))
    )
      throw new Error('The mark-paid response did not preserve its reference, time, and revision');

    const listFirst = await list('alice', undefined, 1);
    await expectStatus(listFirst, 200, 'Read first creator statement page');
    const firstPage = await json<NativeStatementList>(listFirst);
    if (!firstPage.next) throw new Error('Alice needs a list continuation for the native statement fixture');
    const listCursor = firstPage.next;
    const listNext = await list('alice', listCursor, 1);
    await expectStatus(listNext, 200, 'Read creator statement continuation');
    const secondPage = await json<NativeStatementList>(listNext);
    const pagedStatement = secondPage.payoutStatements[0];
    if (!pagedStatement) throw new Error('Alice statement continuation returned no statement');

    const linesFirst = await stack.kernel(
      `/v1/payoutStatements/${pagedStatement.id}/lines?limit=1`,
      {},
      'alice',
    );
    await expectStatus(linesFirst, 200, 'Read first statement line page');
    const firstLines = await json<NativeStatementLines>(linesFirst);
    if (!firstLines.next) throw new Error('The native creator statement needs a line continuation');
    const lineCursor = firstLines.next;
    const linesNext = await stack.kernel(
      `/v1/payoutStatements/${pagedStatement.id}/lines${query('', { cursor: lineCursor, limit: '1' })}`,
      {},
      'alice',
    );
    await expectStatus(linesNext, 200, 'Read statement line continuation');
    const nextLines = await json<NativeStatementLines>(linesNext);
    if (firstLines.lines.length !== 1 || nextLines.lines.length !== 1 || nextLines.next !== null)
      throw new Error('The native line continuation did not return the independent second adjustment line');
    if (!nextLines.lines.some((line) => line.kind === 'refund' && line.grossMinor < 0 && line.netReceiptsMinor < 0))
      throw new Error('The provider refund did not produce a signed adjustment line');

    const detail = await stack.kernel(`/v1/payoutStatements/${pagedStatement.id}`, {}, 'alice');
    await expectStatus(detail, 200, 'Read creator statement detail');
    const otherCreatorDetail = await stack.kernel(`/v1/payoutStatements/${paidStatement.id}`, {}, 'bob');
    await expectStatus(otherCreatorDetail, 404, 'Conceal another creator statement');
    const suspendedList = await list('suspended');
    await expectStatus(suspendedList, 404, 'Deny a suspended account statement list');

    const firstListAddress = statementsHref('en');
    const listContinuationAddress = statementsHref('en', listCursor);
    const detailAddress = statementHref('en', pagedStatement.id, undefined, listCursor);
    const detailLineContinuationAddress = statementHref('en', pagedStatement.id, lineCursor, listCursor);
    const otherCreatorDetailAddress = statementHref('en', paidStatement.id);
    const aliceJourney = await auth.signIn('alice');
    const bobJourney = await auth.signIn('bob');
    const cookieValue = async (persona: 'alice' | 'bob', context: Awaited<ReturnType<typeof auth.signIn>>['context']) => {
      const cookie = (await context.cookies(stack!.web)).find(({ name }) => name === '__Host-rezics_session');
      if (!cookie?.value) throw new Error(`The native ${persona} website session cookie is missing`);
      return `${cookie.name}=${cookie.value}`;
    };
    const [aliceCookie, bobCookie] = await Promise.all([
      cookieValue('alice', aliceJourney.context),
      cookieValue('bob', bobJourney.context),
    ]);
    const readWeb = async (cookie: string, path: string) =>
      fetch(new URL(path, stack!.web), {
        headers: { cookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
      });
    const [webList, webDetail, otherCreatorWebDetail] = await Promise.all([
      readWeb(aliceCookie, listContinuationAddress),
      readWeb(aliceCookie, detailLineContinuationAddress),
      readWeb(bobCookie, otherCreatorDetailAddress),
    ]);
    await expectStatus(webList, 200, 'Read served creator statement list with Auth session');
    await expectStatus(webDetail, 200, 'Read served creator statement detail with Auth session');
    await expectStatus(otherCreatorWebDetail, 200, 'Read concealed other-creator detail with Auth session');

    return {
      stack,
      auth,
      stripe,
      accounts: {
        creator: creator.accountId,
        otherCreator: otherCreator.accountId,
        buyer: buyer.accountId,
        payoutOperator: payoutOperator.accountId,
      },
      offers: { usd: usd.id, eur: eur.id, otherCreator: otherCreatorOffer.id },
      orders: { usd: usdSale.id, eur: eurSale.id, otherCreator: otherSale.id },
      statements: { paid: paidStatement, paged: pagedStatement, otherCreator: otherStatement },
      lines: { first: firstLines, next: nextLines },
      commandKeys,
      listCursor,
      lineCursor,
      responses: {
        webhook: [usdSale.webhook, eurSale.webhook, otherSale.webhook],
        markPaid,
        listFirst,
        listNext,
        detail,
        linesFirst,
        linesNext,
        otherCreatorDetail,
        suspendedList,
        webList,
        webDetail,
        otherCreatorWebDetail,
      },
      addresses: {
        list: new URL(firstListAddress, stack.web).href,
        listContinuation: new URL(listContinuationAddress, stack.web).href,
        detail: new URL(detailAddress, stack.web).href,
        detailLineContinuation: new URL(detailLineContinuationAddress, stack.web).href,
        otherCreatorDetail: new URL(otherCreatorDetailAddress, stack.web).href,
      },
      async close() {
        await auth!.stop();
        await stack!.stop();
        stripe.close();
      },
    };
  } catch (error) {
    try {
      await auth?.stop();
    } finally {
      try {
        await stack?.stop();
      } finally {
        stripe.close();
      }
    }
    throw error;
  }
}
