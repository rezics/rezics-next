import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { CurrentEntitlement, OrderPageData, Settlement } from './order';
import { UUID } from './price';
import { subjectCover } from './subject-cover';

type OrderRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['orders']>['get']>>['data']>;
type BuyerOrder = { kind: 'order'; order: OrderPageData } | { kind: 'missing' } | { kind: 'unavailable' };

const reads = new WeakMap<Request, Map<string, Promise<BuyerOrder>>>();
const entitlementReads = new WeakMap<Request, Map<string, Promise<CurrentEntitlement>>>();
const settlements = new Set<Settlement>(['pending', 'paid', 'failed', 'unknown']);

async function currentEntitlement(
  client: KernelClient,
  credential: string,
  orderId: string,
  entitlementId: string,
): Promise<CurrentEntitlement> {
  if (!UUID.test(entitlementId)) return { kind: 'unavailable' };
  try {
    const result = await client.entitlements({ entitlementId }).get({ headers: { authorization: credential } });
    const entitlement = result.data?.entitlement;
    if (
      result.error ||
      entitlement?.id !== entitlementId ||
      entitlement.orderId !== orderId ||
      typeof entitlement.active !== 'boolean'
    )
      return { kind: 'unavailable' };
    return { kind: 'current', active: entitlement.active };
  } catch {
    return { kind: 'unavailable' };
  }
}

function entitlementOnce(
  request: Request,
  client: KernelClient,
  credential: string,
  orderId: string,
  entitlementId: string | null,
): Promise<CurrentEntitlement> {
  if (entitlementId === null) return Promise.resolve({ kind: 'none' });
  if (typeof entitlementId !== 'string') return Promise.resolve({ kind: 'unavailable' });
  let pending = entitlementReads.get(request);
  if (!pending) {
    pending = new Map();
    entitlementReads.set(request, pending);
  }
  const key = `${orderId}\n${entitlementId}`;
  let entitlement = pending.get(key);
  if (!entitlement) {
    entitlement = currentEntitlement(client, credential, orderId, entitlementId);
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

export async function loadOrder(id: string, locale: string): Promise<OrderPageData> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const outcome = await buyerOrder(request, id, locale);
  if (outcome.kind === 'missing') throw notFound();
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  return outcome.order;
}

/** Compose current access only for the detail page, sharing its prepared order and credential. */
export async function loadOrderPage(id: string, locale: string): Promise<OrderPageData> {
  const order = await loadOrder(id, locale);
  const request = getRequest();
  const credential = viewerCredential(request);
  const entitlement = credential
    ? await entitlementOnce(request, kernelClient(), credential, id, order.entitlementId)
    : { kind: 'unavailable' as const };
  return { ...order, entitlement };
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
