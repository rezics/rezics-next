import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { ReadCredentialMode } from '../kernel/credential';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { locales } from '../paraglide/runtime.js';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { capturedBenefit, type ContentEditionTerms } from './benefit';
import { recordedMoneyUnit, recordedTaxBehavior, type StripeMoneyUnit } from './money-schema';
import { UUID } from './price';

export const SUBJECT_OFFERS_PAGE_SIZE = 10;
export const SUBJECT_OFFERS_MAX_PAGE_SIZE = 20;
/** Closed public discovery DTO. No ownership, permission or source-body fields. */
export type SubjectOffer = {
  id: string;
  targetSubjectId: string;
  title: string;
  currency: string;
  unitAmountMinor: number;
  moneyUnit: StripeMoneyUnit | null;
  taxBehavior: 'exclusive' | null;
  revision: number;
  contentEdition: ContentEditionTerms | null;
};
export type SubjectOffersPage = {
  offers: SubjectOffer[];
  next: string | null;
  projectionState: 'ready' | 'preparing';
};
export type SubjectOffersData =
  | ({ kind: 'ready' } & SubjectOffersPage)
  | { kind: 'denied'; status: number; code: string | null }
  | { kind: 'unavailable' | 'preparing' | 'cursor-error' };
export type SubjectOffersInput = {
  subjectId: string;
  locale: string;
  credentialMode: ReadCredentialMode;
  cursor?: string;
};
export interface SubjectOffersApi {
  /** GET /v1/subjects/:id/offers; native source owns current disclosure and live offer confirmation. */
  read(input: {
    subjectId: string;
    locale: string;
    query: { limit: number; cursor?: string };
    authorization: string | null;
  }): Promise<{ status: number; data: unknown; code?: string | null }>;
}
/** The selected producer is declared, but this base has no module/generated caller for it. */
export const nativeSubjectOffersApi: SubjectOffersApi = {
  async read() {
    return { status: 503, data: null };
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => name in value);
}
function cursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
export function subjectOffersInput(value: unknown): SubjectOffersInput {
  if (
    !record(value) ||
    typeof value.subjectId !== 'string' ||
    !UUID.test(value.subjectId) ||
    !locales.some((locale) => locale === value.locale) ||
    (value.credentialMode !== 'anonymous' && value.credentialMode !== 'session') ||
    (value.cursor !== undefined && !cursor(value.cursor))
  )
    throw notFound();
  return {
    subjectId: value.subjectId,
    locale: String(value.locale),
    credentialMode: value.credentialMode,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  };
}

/** Validate the bounded closed wire before any projection can become shopper-facing data. */
export function parseSubjectOffersPage(value: unknown, subjectId: string): SubjectOffersPage | null {
  if (
    !record(value) ||
    !keys(value, ['offers', 'next', 'projectionState']) ||
    !Array.isArray(value.offers) ||
    value.offers.length > SUBJECT_OFFERS_PAGE_SIZE ||
    !(value.next === null || cursor(value.next)) ||
    (value.projectionState !== 'ready' && value.projectionState !== 'preparing')
  )
    return null;
  const offers: SubjectOffer[] = [];
  for (const row of value.offers) {
    if (
      !record(row) ||
      !keys(row, [
        'id',
        'targetSubjectId',
        'title',
        'currency',
        'unitAmountMinor',
        'moneyUnit',
        'taxBehavior',
        'revision',
        'contentEdition',
      ]) ||
      typeof row.id !== 'string' ||
      !UUID.test(row.id) ||
      row.targetSubjectId !== subjectId ||
      typeof row.title !== 'string' ||
      row.title.trim().length === 0 ||
      row.title.length > 1024 ||
      typeof row.currency !== 'string' ||
      !/^[a-z]{3}$/i.test(row.currency) ||
      typeof row.unitAmountMinor !== 'number' ||
      !Number.isSafeInteger(row.unitAmountMinor) ||
      row.unitAmountMinor <= 0 ||
      typeof row.revision !== 'number' ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      return null;
    const benefit = capturedBenefit(row.contentEdition, subjectId);
    if (benefit.kind === 'unavailable' || row.contentEdition === undefined) return null;
    offers.push({
      id: row.id,
      targetSubjectId: subjectId,
      title: row.title,
      currency: row.currency,
      unitAmountMinor: row.unitAmountMinor,
      moneyUnit: recordedMoneyUnit(row),
      taxBehavior: recordedTaxBehavior(row),
      revision: row.revision,
      contentEdition: benefit.kind === 'mapped' ? benefit.terms : null,
    });
  }
  if (new Set(offers.map((offer) => offer.id)).size !== offers.length) return null;
  return { offers, next: value.next, projectionState: value.projectionState };
}

/** One request/page, current credentials, no anonymous retry or per-card reads. */
export async function loadSubjectOffers(
  api: SubjectOffersApi,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: SubjectOffersInput,
): Promise<SubjectOffersData> {
  const data = subjectOffersInput(input);
  try {
    const staleSession = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (staleSession || (data.credentialMode === 'session' && !authorization))
      return { kind: 'denied', status: 401, code: null };
    if (!authorization && cookie(request, SESSION_COOKIE) !== undefined) return { kind: 'unavailable' };
    const result = await api.read({
      subjectId: data.subjectId,
      locale: data.locale,
      query: { limit: SUBJECT_OFFERS_PAGE_SIZE, ...(data.cursor ? { cursor: data.cursor } : {}) },
      authorization,
    });
    if ([401, 403, 404].includes(result.status))
      return { kind: 'denied', status: result.status, code: result.code ?? null };
    if (result.status === 202) return { kind: 'preparing' };
    if (result.status === 400 || result.status === 409) return { kind: 'cursor-error' };
    const page = result.status === 200 ? parseSubjectOffersPage(result.data, data.subjectId) : null;
    return page ? { kind: 'ready', ...page } : { kind: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return { kind: 'unavailable' };
  }
}

export const readSubjectOffers = createServerFn({ method: 'GET' })
  .validator(subjectOffersInput)
  .handler(async ({ data }): Promise<SubjectOffersData> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadSubjectOffers(nativeSubjectOffersApi, getRequest(), env as Partial<SessionEnv>, data);
  });
