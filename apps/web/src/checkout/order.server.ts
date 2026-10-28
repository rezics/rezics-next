import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { OrderPageData, Settlement } from './order';
import { UUID } from './price';
import { subjectCover } from './subject-cover';

type OrderRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['orders']>['get']>>['data']>;
type BuyerOrder = { kind: 'order'; order: OrderPageData } | { kind: 'missing' } | { kind: 'unavailable' };

const reads = new WeakMap<Request, Map<string, Promise<BuyerOrder>>>();
const settlements = new Set<Settlement>(['pending', 'paid', 'failed', 'unknown']);

// The status route reads without a locale: its rechecks need the settlement alone.
async function readOnce(request: Request, id: string, locale: string | undefined): Promise<BuyerOrder> {
  const credential = viewerCredential(request);
  if (!credential) return { kind: 'missing' };
  const result = await kernelClient()
    .orders({ orderId: id })
    .get({ headers: { authorization: credential }, ...(locale === undefined ? {} : { query: { languages: locale } }) });
  if (result.error) {
    const status = result.status || result.error.status;
    if (status === 404) return { kind: 'missing' };
    return { kind: 'unavailable' };
  }
  const order = (result.data as OrderRead).order;
  const settlement = settlements.has(order.settlement) ? order.settlement : 'unknown';
  return {
    kind: 'order',
    order: {
      id: order.id,
      offerId: order.offerId,
      title: order.title,
      settlement,
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
  await prepareSession(request, env as Partial<SessionEnv>);
  const outcome = await buyerOrder(request, id, locale);
  if (outcome.kind === 'missing') throw notFound();
  if (outcome.kind === 'unavailable') throw new Error('Kernel order read failed');
  return outcome.order;
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
