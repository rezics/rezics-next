import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { CurrentEntitlement, OrderPageData, Settlement } from './order';
import { UUID } from './price';
import { subjectCover } from './subject-cover';
import { benefitCreatorName, capturedBenefit, sameCapturedBenefit, type CapturedBenefit } from './benefit';

type OrderRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['orders']>['get']>>['data']>;
type BuyerOrder = { kind: 'order'; order: OrderPageData } | { kind: 'missing' } | { kind: 'unavailable' };

const reads = new WeakMap<Request, Map<string, Promise<BuyerOrder>>>();
type CurrentAccess = { entitlement: CurrentEntitlement; canUseBenefit: boolean };
const entitlementReads = new WeakMap<Request, Map<string, Promise<CurrentAccess>>>();
const settlements = new Set<Settlement>(['pending', 'paid', 'failed', 'unknown']);

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
    const result = await client.entitlements({ entitlementId }).get({ headers: { authorization: credential } });
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
  request: Request,
  client: KernelClient,
  credential: string,
  orderId: string,
  entitlementId: string | null,
  benefit: CapturedBenefit | undefined,
): Promise<CurrentAccess> {
  if (entitlementId === null) return Promise.resolve({ entitlement: { kind: 'none' }, canUseBenefit: false });
  if (typeof entitlementId !== 'string')
    return Promise.resolve({ entitlement: { kind: 'unavailable' }, canUseBenefit: false });
  let pending = entitlementReads.get(request);
  if (!pending) {
    pending = new Map();
    entitlementReads.set(request, pending);
  }
  const key = `${orderId}\n${entitlementId}`;
  let entitlement = pending.get(key);
  if (!entitlement) {
    entitlement = currentEntitlement(client, credential, orderId, entitlementId, benefit);
    pending.set(key, entitlement);
  }
  return entitlement;
}

// Status rechecks read without a locale and never read current entitlement.
async function readOnce(request: Request, id: string, locale: string | undefined): Promise<BuyerOrder> {
  if (locale !== undefined) await prepareSession(request, env as Partial<SessionEnv>);
  const credential = viewerCredential(request);
  if (!credential) return { kind: 'missing' };
  const client = kernelClient();
  const result = await client
    .orders({ orderId: id })
    .get({ headers: { authorization: credential }, ...(locale === undefined ? {} : { query: { languages: locale } }) });
  if (result.error) {
    const status = result.status || result.error.status;
    if (status === 404) return { kind: 'missing' };
    return { kind: 'unavailable' };
  }
  const order = (result.data as OrderRead).order;
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
      },
    },
  };
}

function buyerOrder(request: Request, id: string, locale?: string): Promise<BuyerOrder> {
  let pending = reads.get(request);
  if (!pending) {
    pending = new Map();
    reads.set(request, pending);
  }
  const key = `${locale ?? ''}\n${id}`;
  let order = pending.get(key);
  if (!order) {
    order = readOnce(request, id, locale);
    pending.set(key, order);
  }
  return order;
}

async function loadRequestOrder(request: Request, id: string, locale: string): Promise<OrderPageData> {
  setResponseHeader('cache-control', 'private, no-store');
  const outcome = await buyerOrder(request, id, locale);
  if (outcome.kind === 'missing') throw notFound();
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  return outcome.order;
}

export async function loadOrder(id: string, locale: string): Promise<OrderPageData> {
  return loadRequestOrder(getRequest(), id, locale);
}

/** Compose current access only for the detail page, sharing its prepared order and credential. */
export async function loadOrderPage(id: string, locale: string): Promise<OrderPageData> {
  const request = getRequest();
  const order = await loadRequestOrder(request, id, locale);
  const credential = viewerCredential(request);
  const access = credential
    ? await entitlementOnce(request, kernelClient(), credential, id, order.entitlementId, order.benefit)
    : { entitlement: { kind: 'unavailable' as const }, canUseBenefit: false };
  let canReconcile = false;
  const accountId = sessionSubject(request);
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
  const outcome = await buyerOrder(request, id);
  if (outcome.kind === 'missing')
    return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  const { id: orderId, offerId, settlement } = outcome.order;
  return Response.json({ id: orderId, offerId, settlement }, { headers: { 'cache-control': 'private, no-store' } });
}
