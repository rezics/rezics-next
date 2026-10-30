import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { locales } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { UUID } from './price';

export const ENTITLEMENTS_PAGE_SIZE = 20;
type NativePage = NonNullable<Awaited<ReturnType<KernelClient['entitlements']['get']>>['data']>;
export type BuyerEntitlement = NativePage['entitlements'][number];
export type EntitlementsRead<T> =
  | { kind: 'ready'; data: T }
  | { kind: 'denied' | 'unavailable' | 'preparing' | 'cursor-error' };
export type BuyerEntitlementsPage = EntitlementsRead<NativePage>;
export type BuyerEntitlementPage = EntitlementsRead<BuyerEntitlement>;

export function entitlementSearch(input: Record<string, unknown>): { cursor?: string } {
  const cursor = input.cursor;
  if (cursor === undefined || cursor === '') return {};
  if (typeof cursor !== 'string' || cursor.length > 4096) throw notFound();
  return { cursor };
}

function validateInput(input: unknown): { locale: string; cursor?: string; id?: string } {
  if (!input || typeof input !== 'object' || !('locale' in input) || !locales.some((l) => l === input.locale))
    throw notFound();
  const cursor = entitlementSearch('cursor' in input ? { cursor: input.cursor } : {});
  if ('id' in input && (typeof input.id !== 'string' || !UUID.test(input.id))) throw notFound();
  return { locale: String(input.locale), ...cursor, ...('id' in input ? { id: String(input.id) } : {}) };
}

function failure(status: number): Exclude<BuyerEntitlementsPage, { kind: 'ready' }> {
  if (status === 401 || status === 403 || status === 404) return { kind: 'denied' };
  if (status === 400 || status === 409) return { kind: 'cursor-error' };
  if (status === 202) return { kind: 'preparing' };
  return { kind: 'unavailable' };
}

function validRecord(row: BuyerEntitlement): boolean {
  return (
    [row.id, row.orderId, row.offerId, row.targetSubjectId].every((id) => UUID.test(id)) &&
    Number.isFinite(Date.parse(row.grantedAt)) &&
    typeof row.active === 'boolean' &&
    (row.revokedAt === null || Number.isFinite(Date.parse(row.revokedAt))) &&
    (row.revokeReason === null || row.revokeReason === 'refund' || row.revokeReason === 'dispute') &&
    (row.summary === null || row.summary.id === row.targetSubjectId)
  );
}

/** One owner-self keyset page; native code batches the disclosed summaries within this same bounded read. */
export async function loadBuyerEntitlements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<BuyerEntitlementsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { kind: 'denied' };
  try {
    const result = await client.entitlements.get({
      query: { limit: ENTITLEMENTS_PAGE_SIZE, ...(input.cursor ? { cursor: input.cursor } : {}) },
      headers: { authorization },
    });
    if (result.error || result.status !== 200 || !result.data) return failure(result.status);
    const page = result.data;
    if (
      !Array.isArray(page.entitlements) ||
      page.entitlements.length > ENTITLEMENTS_PAGE_SIZE ||
      !page.entitlements.every(validRecord) ||
      !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096))
    )
      return { kind: 'unavailable' };
    return { kind: 'ready', data: page };
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return { kind: 'unavailable' };
  }
}

/** Native account equality, current grants and the purchase gate remain the authority for this exact record. */
export async function loadBuyerEntitlement(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<BuyerEntitlementPage> {
  if (!UUID.test(id)) return { kind: 'denied' };
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { kind: 'denied' };
  try {
    const result = await client.entitlements({ entitlementId: id }).get({ headers: { authorization } });
    if (result.error || result.status !== 200 || !result.data) return failure(result.status);
    const row = result.data.entitlement;
    if (row.id !== id || !validRecord(row)) return { kind: 'unavailable' };
    return { kind: 'ready', data: row };
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return { kind: 'unavailable' };
  }
}

export const readBuyerEntitlements = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<BuyerEntitlementsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerEntitlements(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readBuyerEntitlement = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = validateInput(input);
    if (!data.id) throw notFound();
    return { id: data.id, locale: data.locale };
  })
  .handler(async ({ data }): Promise<BuyerEntitlementPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerEntitlement(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>, data.id);
  });
