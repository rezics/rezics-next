import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export const ORDER_HISTORY_PAGE_SIZE = 20;

export type BuyerOrder = {
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

export type BuyerOrderPage = { orders: BuyerOrder[]; next: string | null };

type OrdersListClient = {
  orders: {
    get(options: {
      query: { limit: number; cursor?: string };
      headers: { authorization: string };
    }): Promise<{ data?: unknown; error?: { status?: number }; status?: number }>;
  };
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
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) throw notFound();

  // The commerce collection route is being integrated with its generated client export; this narrow cast keeps the
  // web caller on that same Treaty client and exact owner-self GET /v1/orders contract.
  const orders = (client as unknown as OrdersListClient).orders;
  let result: Awaited<ReturnType<OrdersListClient['orders']['get']>>;
  try {
    result = await orders.get({
      query: { limit: ORDER_HISTORY_PAGE_SIZE, ...(input.cursor ? { cursor: input.cursor } : {}) },
      headers: { authorization },
    });
  } catch {
    throw new Error('Native order history is unavailable');
  }
  if (result.error || !result.data) {
    const status = result.status || result.error?.status;
    if (status === 404) throw notFound();
    throw new Error('Native order history is unavailable');
  }
  return buyerOrderPage(result.data);
}

export const readBuyerOrders = createServerFn({ method: 'GET' })
  .validator(validateCursor)
  .handler(async ({ data }): Promise<BuyerOrderPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerOrders(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
