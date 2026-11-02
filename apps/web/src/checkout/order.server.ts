import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { CurrentEntitlement, OrderMoney, OrderPageData, Settlement } from './order';
import { UUID } from './price';
import { subjectCover } from './subject-cover';
import { benefitCreatorName, capturedBenefit, sameCapturedBenefit, type CapturedBenefit } from './benefit';

// Named receipt wire seam also accepts retained client declarations predating presentment.
type ReceiptOrderRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['orders']>['get']>>['data']> & {
  order: { recordedPresentment?: OrderMoney['recordedPresentment'] };
};
type BuyerOrder = { kind: 'order'; order: OrderPageData } | { kind: 'missing' } | { kind: 'unavailable' };

type CurrentAccess = { entitlement: CurrentEntitlement; canUseBenefit: boolean };
type BuyerReader = {
  credential: string;
  subject: string | undefined;
  orders: Map<string, Promise<BuyerOrder>>;
  entitlements: Map<string, Promise<CurrentAccess>>;
};
const readers = new WeakMap<Request, BuyerReader>();
const settlements = new Set<Settlement>(['pending', 'paid', 'failed', 'unknown']);

async function prepareReader(request: Request): Promise<BuyerReader | undefined> {
  // Renew admission before consulting either private cache, including status-only reads.
  if (await prepareSession(request, env as Partial<SessionEnv>)) {
    readers.delete(request);
    return;
  }
  const credential = viewerCredential(request);
  if (!credential) {
    readers.delete(request);
    return;
  }
  // Explicit Authorization does not establish the subject retained by cookie preparation.
  const subject = request.headers.has('authorization') ? undefined : sessionSubject(request);
  let reader = readers.get(request);
  if (!reader || reader.credential !== credential || reader.subject !== subject) {
    reader = { credential, subject, orders: new Map(), entitlements: new Map() };
    readers.set(request, reader);
  }
  return reader;
}

async function currentEntitlement(
  client: KernelClient,
  credential: string,
  orderId: string,
  entitlementId: string,
  benefit: CapturedBenefit | undefined,
): Promise<CurrentAccess> {
  const unavailable = { entitlement: { kind: 'unavailable' as const }, canUseBenefit: false };
  if (!UUID.test(entitlementId)) return unavailable;
  try {
    const result = await client.entitlements({ entitlementId }).get({
      headers: { authorization: credential },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const entitlement = result.data?.entitlement;
    if (
      result.error ||
      entitlement?.id !== entitlementId ||
      entitlement.orderId !== orderId ||
      typeof entitlement.active !== 'boolean'
    )
      return unavailable;
    return {
      entitlement: { kind: 'current', active: entitlement.active },
      canUseBenefit:
        entitlement.active &&
        entitlement.revokedAt === null &&
        entitlement.revokeReason === null &&
        sameCapturedBenefit(benefit, capturedBenefit(entitlement.contentEdition, entitlement.targetSubjectId)),
    };
  } catch {
    return unavailable;
  }
}

function entitlementOnce(
  reader: BuyerReader,
  client: KernelClient,
  orderId: string,
  entitlementId: string | null,
  benefit: CapturedBenefit | undefined,
): Promise<CurrentAccess> {
  if (entitlementId === null) return Promise.resolve({ entitlement: { kind: 'none' }, canUseBenefit: false });
  if (typeof entitlementId !== 'string')
    return Promise.resolve({ entitlement: { kind: 'unavailable' }, canUseBenefit: false });
  const pending = reader.entitlements;
  const key = `${orderId}\n${entitlementId}`;
  let entitlement = pending.get(key);
  if (!entitlement) {
    entitlement = currentEntitlement(client, reader.credential, orderId, entitlementId, benefit);
    pending.set(key, entitlement);
  }
  return entitlement;
}

// Status rechecks read without a locale and never read current entitlement.
async function readOnce(credential: string, id: string, locale: string | undefined): Promise<BuyerOrder> {
  const client = kernelClient();
  const result = await client.orders({ orderId: id }).get({
    headers: { authorization: credential },
    ...(locale === undefined ? {} : { query: { languages: locale } }),
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (result.error) {
    const status = result.status || result.error.status;
    if (status === 404) return { kind: 'missing' };
    return { kind: 'unavailable' };
  }
  const order = (result.data as ReceiptOrderRead).order;
  if (order.id !== id) return { kind: 'unavailable' };
  const settlement = settlements.has(order.settlement) ? order.settlement : 'unknown';
  return {
    kind: 'order',
    order: {
      id: order.id,
      offerId: order.offerId,
      title: order.title,
      settlement,
      entitlementId: order.entitlementId,
      entitlement: { kind: 'refresh' },
      createdAt: order.createdAt,
      subject: subjectCover(locale ?? '', order.targetSubjectId, order.title, order.subject),
      benefit: capturedBenefit(order.contentEdition, order.targetSubjectId),
      money: {
        currency: order.currency,
        unitAmountMinor: order.unitAmountMinor,
        taxCode: order.taxCode,
        amountTaxMinor: order.amountTaxMinor,
        moneyUnit: order.moneyUnit,
        taxBehavior: order.taxBehavior,
        recordedCharge: order.recordedCharge,
        recordedPresentment: order.recordedPresentment ?? null,
      },
    },
  };
}

function buyerOrder(reader: BuyerReader, id: string, locale?: string): Promise<BuyerOrder> {
  const pending = reader.orders;
  const key = `${locale ?? ''}\n${id}`;
  let order = pending.get(key);
  if (!order) {
    order = readOnce(reader.credential, id, locale);
    pending.set(key, order);
  }
  return order;
}

async function loadRequestOrder(request: Request, id: string, locale: string) {
  setResponseHeader('cache-control', 'private, no-store');
  const reader = await prepareReader(request);
  if (!reader) throw notFound();
  const outcome = await buyerOrder(reader, id, locale);
  if (outcome.kind === 'missing') throw notFound();
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  return { order: outcome.order, reader };
}

export async function loadOrder(id: string, locale: string): Promise<OrderPageData> {
  return (await loadRequestOrder(getRequest(), id, locale)).order;
}

/** Compose current access only for the detail page, sharing its prepared order and credential. */
export async function loadOrderPage(id: string, locale: string): Promise<OrderPageData> {
  const request = getRequest();
  const { order, reader } = await loadRequestOrder(request, id, locale);
  const credential = reader.credential;
  const access = await entitlementOnce(reader, kernelClient(), id, order.entitlementId, order.benefit);
  let canReconcile = false;
  const accountId = reader.subject;
  if (credential && accountId && UUID.test(accountId)) {
    try {
      const result = await kernelClient().viewerActions.post(
        { resources: [{ type: 'access.account', id: accountId }] },
        { headers: { authorization: credential } },
      );
      canReconcile =
        !result.error &&
        result.data?.resources.some(
          (resource) =>
            resource.type === 'access.account' &&
            resource.id === accountId &&
            'viewerActions' in resource &&
            resource.viewerActions.some(
              (action) => action.action === 'order:reconcile' && action.operations.includes('order.reconcile'),
            ),
        ) === true;
    } catch {
      // Missing current authority never exposes a write control.
    }
  }
  return {
    ...order,
    ...access,
    canReconcile,
    creatorName: order.benefit ? await benefitCreatorName(kernelClient(locale), order.benefit) : undefined,
  };
}

export async function orderStatusResponse(request: Request, id: string): Promise<Response> {
  if (!UUID.test(id)) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  const reader = await prepareReader(request);
  const outcome = reader ? await buyerOrder(reader, id) : { kind: 'missing' as const };
  if (outcome.kind === 'missing')
    return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  const { id: orderId, offerId, settlement } = outcome.order;
  return Response.json({ id: orderId, offerId, settlement }, { headers: { 'cache-control': 'private, no-store' } });
}
