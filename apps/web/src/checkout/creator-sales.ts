import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { recordedMoneyUnit, recordedTaxBehavior, type StripeMoneyUnit } from './money-schema';
import { UUID } from './price';

export const CREATOR_SALES_PAGE_SIZE = 20;
export type CreatorSalesQuery = { cursor?: string };
export type CreatorSalesSearch = CreatorSalesQuery | { kind: 'invalid-address'; cursor?: string };
export type CreatorSale = {
  orderId: string;
  offerId: string;
  title: string;
  targetSubjectId: string;
  currency: string;
  unitAmountMinor: number;
  moneyUnit: StripeMoneyUnit | null;
  taxBehavior: 'exclusive' | null;
  settlement: 'paid' | 'pending' | 'failed' | 'unknown';
  createdAt: string;
};
export type CreatorSalesPage = {
  sales: CreatorSale[];
  next: string | null;
  projectionState: 'ready' | 'preparing';
};
export type CreatorSalesData =
  | ({ kind: 'ready' } & CreatorSalesPage)
  | { kind: 'denied' | 'unavailable' | 'error' | 'stale' | 'loading' };
export type CreatorSalesCurrentRead = {
  sessionSubject: string | null;
  requested: { cursor: string | null };
  selling: boolean;
  page: CreatorSalesData;
};

/** GET /v1/commerceSales; commerce_sale.list, exact commerce_sale:list, own-account. */
export interface CreatorSalesCaller {
  get(input: {
    query: { limit: 20; cursor?: string };
    headers: { authorization: string };
  }): Promise<{ status: number; data: unknown }>;
}

/** Narrow bridge until the controller's canonical generated client includes this mounted endpoint. */
type CreatorSalesKernelClient = {
  commerceSales: {
    get(
      input: Parameters<CreatorSalesCaller['get']>[0] & {
        fetch: { cache: 'no-store'; redirect: 'manual' };
      },
    ): Promise<{ status: number; data?: unknown; error?: unknown }>;
  };
};

const nativeCreatorSalesCaller: CreatorSalesCaller = {
  async get(input) {
    const client = kernelClient() as unknown as CreatorSalesKernelClient;
    const result = await client.commerceSales.get({
      ...input,
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return { status: result.status, data: result.error ? null : result.data };
  },
};

/** Explicit unavailable source for injected callers without a native binding. */
export const unavailableCreatorSalesCaller: CreatorSalesCaller = {
  async get() {
    return { status: 503, data: null };
  },
};

const id = v.pipe(v.string(), v.regex(UUID));
const cursorSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const pageSchema = v.object({
  sales: v.pipe(
    v.array(
      v.object({
        orderId: id,
        offerId: id,
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
        targetSubjectId: id,
        currency: v.pipe(v.string(), v.regex(/^[a-z]{3}$/i)),
        unitAmountMinor: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        moneyUnit: v.optional(v.unknown()),
        taxBehavior: v.optional(v.unknown()),
        settlement: v.picklist(['paid', 'pending', 'failed', 'unknown']),
        createdAt: v.pipe(
          v.string(),
          v.check((value) => Number.isFinite(Date.parse(value))),
        ),
      }),
    ),
    v.maxLength(CREATOR_SALES_PAGE_SIZE),
  ),
  next: v.nullable(cursorSchema),
  projectionState: v.picklist(['ready', 'preparing']),
});

export function creatorSalesSearch(value: Record<string, unknown>): CreatorSalesSearch {
  if (value.cursor === undefined || value.cursor === '') return {};
  const cursor = v.safeParse(cursorSchema, value.cursor);
  if (!cursor.success)
    return { kind: 'invalid-address', ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) };
  // Extra search parameters never select an account or become native filters.
  return { cursor: cursor.output };
}

export function creatorSalesAddressLoad<T>(
  address: CreatorSalesSearch,
  read: (query: CreatorSalesQuery) => T,
): T | null {
  return 'kind' in address ? null : read(address);
}

function input(value: unknown): CreatorSalesQuery {
  const parsed = v.safeParse(v.object({ cursor: v.optional(v.unknown()) }), value);
  if (!parsed.success) throw notFound();
  const search = creatorSalesSearch(parsed.output);
  if ('kind' in search) throw notFound();
  return search;
}

export function parseCreatorSalesPage(value: unknown): CreatorSalesPage | null {
  const parsed = v.safeParse(pageSchema, value);
  if (!parsed.success) return null;
  const page = parsed.output;
  if (new Set(page.sales.map((sale) => sale.orderId)).size !== page.sales.length) return null;
  return {
    sales: page.sales.map((sale) => ({
      ...sale,
      moneyUnit: recordedMoneyUnit(sale),
      taxBehavior: recordedTaxBehavior(sale),
    })),
    next: page.next,
    projectionState: page.projectionState,
  };
}

/** One bounded source read with this request's credential. Native alone decides current authority. */
export async function loadCreatorSales(
  caller: CreatorSalesCaller,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  search: CreatorSalesQuery,
): Promise<CreatorSalesData> {
  const query = creatorSalesSearch(search);
  if ('kind' in query) throw notFound();
  try {
    const stale = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'denied' };
    return await loadPreparedCreatorSales(caller, authorization, query);
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
  }
}

async function loadPreparedCreatorSales(
  caller: CreatorSalesCaller,
  authorization: string,
  query: CreatorSalesQuery,
): Promise<CreatorSalesData> {
  try {
    const result = await caller.get({
      query: { limit: CREATOR_SALES_PAGE_SIZE, ...query },
      headers: { authorization },
    });
    const failure = creatorSalesFailure(result.status);
    if (failure) return failure;
    if (result.status !== 200 && result.status !== 202) return { kind: 'unavailable' };
    const page = parseCreatorSalesPage(result.data);
    if (!page || (result.status === 202 && page.projectionState !== 'preparing')) return { kind: 'unavailable' };
    return { kind: 'ready', ...page };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
  }
}

function creatorSalesFailure(status: number): CreatorSalesData | null {
  if ([401, 403, 404].includes(status)) return { kind: 'denied' };
  if (status === 409) return { kind: 'stale' };
  if (status === 400) return { kind: 'error' };
  return null;
}

export const readCreatorSales = createServerFn({ method: 'GET' })
  .validator(input)
  .handler(async ({ data }): Promise<CreatorSalesData> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    return loadCreatorSales(nativeCreatorSalesCaller, getRequest(), env as Partial<SessionEnv>, data);
  });

/** Viewer/address evidence and both reads belong to this one fresh session preparation. */
export const readCreatorSalesCurrent = createServerFn({ method: 'GET' })
  .validator(input)
  .handler(async ({ data }): Promise<CreatorSalesCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    const result: CreatorSalesCurrentRead = {
      sessionSubject: null,
      requested: { cursor: data.cursor ?? null },
      selling: false,
      page: { kind: 'denied' },
    };
    try {
      const request = new Request(getRequest());
      if (await prepareSession(request, env as Partial<SessionEnv>)) return result;
      const authorization = viewerCredential(request);
      const subject = request.headers.has('authorization') ? null : sessionSubject(request);
      if (!authorization || !subject) return result;
      result.sessionSubject = subject;
      const client = kernelClient();
      const exposure = await client.platform.exposure.get({
        headers: { authorization },
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
      const failure = creatorSalesFailure(exposure.status);
      if (failure) return { ...result, page: failure };
      if (exposure.error || !exposure.data) return { ...result, page: { kind: 'unavailable' } };
      if (!exposure.data.admitted.includes('commerce_sale.list')) return result;
      result.selling = true;
      result.page = await loadPreparedCreatorSales(nativeCreatorSalesCaller, authorization, data);
      return result;
    } catch (error) {
      return { ...result, page: { kind: isPlatformClosedError(error) ? 'denied' : 'unavailable' } };
    }
  });
