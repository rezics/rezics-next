import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { locales } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { assertPublicCacheReadAllowed } from '../security/page-cache';
import { UUID } from './price';
import { benefitCreatorName, capturedBenefit } from './benefit';

export const ENTITLEMENTS_PAGE_SIZE = 20;
type NativePage = NonNullable<Awaited<ReturnType<KernelClient['entitlements']['get']>>['data']>;
export type BuyerEntitlement = NativePage['entitlements'][number];
export type EntitlementsRead<T> =
  | { kind: 'ready'; data: T }
  | { kind: 'denied' | 'unavailable' | 'preparing' | 'cursor-error' };
export type BuyerEntitlementsPage = EntitlementsRead<NativePage>;
export type BuyerEntitlementPage = EntitlementsRead<BuyerEntitlement> & { creatorName?: string | undefined };
export type EntitlementsAddress =
  | { kind: 'list'; locale: string; cursor: string | null }
  | { kind: 'detail'; locale: string; id: string };
export type BuyerEntitlementsCurrentRead<T = BuyerEntitlementsPage> = {
  sessionSubject: string | null;
  requested: EntitlementsAddress;
  page: T;
};
export type BuyerEntitlementCurrentRead = BuyerEntitlementsCurrentRead<BuyerEntitlementPage>;

export function sameEntitlementsAddress(a: EntitlementsAddress, b: EntitlementsAddress): boolean {
  return (
    a.locale === b.locale &&
    (a.kind === 'list' && b.kind === 'list'
      ? a.cursor === b.cursor
      : a.kind === 'detail' && b.kind === 'detail' && a.id === b.id)
  );
}

type PreparedRead<T> = { sessionSubject: string | null; page: T };

async function prepareBuyer(request: Request, sessionEnv: Partial<SessionEnv>) {
  if (await prepareSession(request, sessionEnv)) return null;
  const authorization = viewerCredential(request);
  if (!authorization) return null;
  // Snapshot the association consumed by this native call, before IO or optional enrichment.
  // Explicit bearer authority is still supported, but does not identify a browser session.
  const subject = request.headers.has('authorization') ? null : sessionSubject(request) || null;
  return { authorization, subject };
}

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
    (row.summary === null || row.summary.id === row.targetSubjectId) &&
    capturedBenefit(row.contentEdition, row.targetSubjectId).kind !== 'unavailable'
  );
}

/** One owner-self keyset page; native code batches the disclosed summaries within this same bounded read. */
export async function loadBuyerEntitlements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<BuyerEntitlementsPage> {
  return (await loadEntitlementsBody(client, request, sessionEnv, input)).page;
}

async function loadEntitlementsBody(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<PreparedRead<BuyerEntitlementsPage>> {
  const prepared = await prepareBuyer(request, sessionEnv);
  if (!prepared) return { sessionSubject: null, page: { kind: 'denied' } };
  const { authorization, subject: sessionSubject } = prepared;
  const finish = (page: BuyerEntitlementsPage) => ({ sessionSubject, page });
  try {
    const result = await client.entitlements.get({
      query: { limit: ENTITLEMENTS_PAGE_SIZE, ...(input.cursor ? { cursor: input.cursor } : {}) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error || result.status !== 200 || !result.data) return finish(failure(result.status));
    const page = result.data;
    if (
      !Array.isArray(page.entitlements) ||
      page.entitlements.length > ENTITLEMENTS_PAGE_SIZE ||
      !page.entitlements.every(validRecord) ||
      !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096))
    )
      return finish({ kind: 'unavailable' });
    return finish({ kind: 'ready', data: page });
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return finish({ kind: 'unavailable' });
  }
}

/** Native account equality, current grants and the purchase gate remain the authority for this exact record. */
export async function loadBuyerEntitlement(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<BuyerEntitlementPage> {
  return (await loadEntitlementBody(client, request, sessionEnv, id)).page;
}

async function loadEntitlementBody(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<PreparedRead<BuyerEntitlementPage>> {
  if (!UUID.test(id)) return { sessionSubject: null, page: { kind: 'denied' } };
  const prepared = await prepareBuyer(request, sessionEnv);
  if (!prepared) return { sessionSubject: null, page: { kind: 'denied' } };
  const { authorization, subject: sessionSubject } = prepared;
  const finish = (page: BuyerEntitlementPage) => ({ sessionSubject, page });
  try {
    const result = await client.entitlements({ entitlementId: id }).get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error || result.status !== 200 || !result.data) return finish(failure(result.status));
    const row = result.data.entitlement;
    if (row.id !== id || !validRecord(row)) return finish({ kind: 'unavailable' });
    const benefit = capturedBenefit(row.contentEdition, row.targetSubjectId);
    const creatorName = await benefitCreatorName(client, benefit);
    return finish({ kind: 'ready', data: row, ...(creatorName ? { creatorName } : {}) });
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return finish({ kind: 'unavailable' });
  }
}

export const readBuyerEntitlements = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<BuyerEntitlementsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerEntitlements(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>, data);
  });

function validateDetailInput(input: unknown) {
  const data = validateInput(input);
  if (!data.id) throw notFound();
  return { id: data.id, locale: data.locale };
}

function freshBuyerRequest() {
  const request = getRequest();
  assertPublicCacheReadAllowed(request, 'session');
  return new Request(request);
}

export const readBuyerEntitlement = createServerFn({ method: 'GET' })
  .validator(validateDetailInput)
  .handler(async ({ data }): Promise<BuyerEntitlementPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBuyerEntitlement(kernelClient(data.locale), getRequest(), env as Partial<SessionEnv>, data.id);
  });

/** Fresh request maps ensure a skipped/refused preparation cannot certify retained associations. */
export const readBuyerEntitlementsCurrent = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<BuyerEntitlementsCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadEntitlementsBody(
      kernelClient(data.locale),
      freshBuyerRequest(),
      env as Partial<SessionEnv>,
      data,
    );
    return { ...result, requested: { kind: 'list', locale: data.locale, cursor: data.cursor ?? null } };
  });

export const readBuyerEntitlementCurrent = createServerFn({ method: 'GET' })
  .validator(validateDetailInput)
  .handler(async ({ data }): Promise<BuyerEntitlementCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadEntitlementBody(
      kernelClient(data.locale),
      freshBuyerRequest(),
      env as Partial<SessionEnv>,
      data.id,
    );
    return { ...result, requested: { kind: 'detail', locale: data.locale, id: data.id } };
  });
