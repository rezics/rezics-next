import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { locales } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

export const ORDER_HISTORY_PAGE_SIZE = 20;

type NativeOrderHistory = NonNullable<Awaited<ReturnType<KernelClient['orders']['get']>>['data']>;
export type BuyerOrder = NativeOrderHistory['orders'][number];
export type BuyerOrderPage = Pick<NativeOrderHistory, 'orders' | 'next'>;
export type BuyerOrdersAddress = { cursor: string | null; locale: string };
export type BuyerOrdersCurrentRead = {
  sessionSubject: string | null;
  requested: BuyerOrdersAddress;
  page: BuyerOrderPage;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settlements = new Set(['pending', 'paid', 'failed', 'unknown']);

function validateCursor(value: unknown): { cursor?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw notFound();
  const cursor = (value as Record<string, unknown>).cursor;
  if (cursor === undefined || cursor === '') return {};
  if (typeof cursor !== 'string' || cursor.length > 4096) throw notFound();
  return { cursor };
}

function validateCurrentInput(value: unknown): { cursor?: string; locale: string } {
  const cursor = validateCursor(value);
  if (!value || typeof value !== 'object' || !('locale' in value) || !locales.some((l) => l === value.locale))
    throw notFound();
  return { ...cursor, locale: String(value.locale) };
}

function isBuyerOrder(value: unknown): value is BuyerOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    uuid.test(row.id) &&
    typeof row.offerId === 'string' &&
    uuid.test(row.offerId) &&
    typeof row.title === 'string' &&
    typeof row.targetSubjectId === 'string' &&
    uuid.test(row.targetSubjectId) &&
    typeof row.currency === 'string' &&
    /^[a-z]{3}$/i.test(row.currency) &&
    typeof row.unitAmountMinor === 'number' &&
    Number.isSafeInteger(row.unitAmountMinor) &&
    row.unitAmountMinor >= 0 &&
    typeof row.settlement === 'string' &&
    settlements.has(row.settlement) &&
    (row.entitlementId === null || (typeof row.entitlementId === 'string' && uuid.test(row.entitlementId))) &&
    typeof row.createdAt === 'string' &&
    Number.isFinite(Date.parse(row.createdAt))
  );
}

function buyerOrderPage(value: unknown): BuyerOrderPage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native order history response');
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.orders) ||
    body.orders.length > ORDER_HISTORY_PAGE_SIZE ||
    !body.orders.every(isBuyerOrder) ||
    !(body.next === null || (typeof body.next === 'string' && body.next.length <= 4096))
  )
    throw new Error('Invalid native order history response');
  return { orders: body.orders, next: body.next };
}

/** One private, bounded call to the owner-self native order collection route. */
export async function loadBuyerOrders(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<BuyerOrderPage> {
  return (await loadPreparedBuyerOrders(client, request, sessionEnv, input)).page;
}

async function loadPreparedBuyerOrders(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<{ sessionSubject: string | null; page: BuyerOrderPage }> {
  if (await prepareSession(request, sessionEnv)) throw notFound();
  const authorization = viewerCredential(request);
  if (!authorization) throw notFound();
  // Capture the subject associated with the credential this dispatch actually consumes.
  // An explicit API credential alone cannot certify a browser session.
  const subject = request.headers.has('authorization') ? null : (sessionSubject(request) ?? null);

  // Keep the history read on the generated owner-self Treaty route with no account selector.
  let result: Awaited<ReturnType<KernelClient['orders']['get']>>;
  try {
    result = await client.orders.get({
      query: { limit: ORDER_HISTORY_PAGE_SIZE, ...(input.cursor ? { cursor: input.cursor } : {}) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  } catch {
    throw new Error('Native order history is unavailable');
  }
  if (result.error || !result.data) {
    const status = result.status || result.error?.status;
    if (status === 404) throw notFound();
    throw new Error('Native order history is unavailable');
  }
  return { sessionSubject: subject, page: buyerOrderPage(result.data) };
}

export const readBuyerOrders = createServerFn({ method: 'GET' })
  .validator(validateCursor)
  .handler(async ({ data }): Promise<BuyerOrderPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerOrders(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** Actual-reader provenance for the private route; legacy callers keep their original page API. */
export const readBuyerOrdersCurrent = createServerFn({ method: 'GET' })
  .validator(validateCurrentInput)
  .handler(async ({ data }): Promise<BuyerOrdersCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    // A fresh Request prevents a missing preparation from certifying retained WeakMap entries.
    const read = await loadPreparedBuyerOrders(
      kernelClient(data.locale),
      new Request(getRequest()),
      env as Partial<SessionEnv>,
      data,
    );
    return { ...read, requested: { cursor: data.cursor ?? null, locale: data.locale } };
  });
