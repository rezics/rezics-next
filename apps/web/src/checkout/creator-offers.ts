import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { UUID } from './price';

type EditionTerms = NonNullable<Awaited<ReturnType<KernelClient['offers']['post']>>['data']>['offer']['contentEdition'];
/** Exact offer.list seller DTO. Replace this adapter with the generated offers.get when emitted. */
export type CreatorOffer = {
  id: string;
  targetSubjectId: string;
  title: string;
  currency: string;
  unitAmountMinor: number;
  taxCode: string;
  royaltyBasisPoints: number;
  state: 'active' | 'delisted';
  revision: number;
  contentEdition: EditionTerms;
};
export const CREATOR_OFFERS_PAGE_SIZE = 20;
export type CreatorOffersSearch = { cursor?: string };
export type CreatorOffersData =
  | { kind: 'ready'; offers: CreatorOffer[]; next: string | null }
  | { kind: 'denied' | 'unavailable' | 'error' | 'stale' | 'preparing' };
/** Temporary exact caller seam while the controller owns native client generation. */
export type CreatorOffersCaller = {
  get(input: {
    query: { limit: number; cursor?: string };
    headers: { authorization: string };
  }): Promise<{ status: number; data: { offers: CreatorOffer[]; next: string | null } | null }>;
};
// Never substitute public offer reads, receipts or a fabricated empty page for the absent binding.
export const unavailableCreatorOffersCaller: CreatorOffersCaller = {
  async get() {
    return { status: 503, data: null };
  },
};

export function creatorOffersSearch(value: Record<string, unknown>): CreatorOffersSearch {
  if (value.cursor === undefined || value.cursor === '') return {};
  if (typeof value.cursor !== 'string' || value.cursor.length > 4096) throw notFound();
  return { cursor: value.cursor };
}
function input(value: unknown): CreatorOffersSearch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw notFound();
  return creatorOffersSearch('cursor' in value ? { cursor: value.cursor } : {});
}
function validOffer(row: CreatorOffer): boolean {
  return (
    !!row &&
    UUID.test(row.id) &&
    UUID.test(row.targetSubjectId) &&
    typeof row.title === 'string' &&
    row.title.length > 0 &&
    typeof row.currency === 'string' &&
    /^[a-z]{3}$/i.test(row.currency) &&
    Number.isSafeInteger(row.unitAmountMinor) &&
    row.unitAmountMinor > 0 &&
    typeof row.taxCode === 'string' &&
    Number.isInteger(row.royaltyBasisPoints) &&
    row.royaltyBasisPoints >= 0 &&
    row.royaltyBasisPoints <= 10000 &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 1 &&
    (row.state === 'active' || row.state === 'delisted') &&
    (row.contentEdition === null ||
      (!!row.contentEdition &&
        row.contentEdition.benefit?.kind === 'content-edition' &&
        row.contentEdition.benefit.resourceType === 'content.edition' &&
        row.contentEdition.benefit.action === 'edition:read' &&
        UUID.test(row.contentEdition.benefit.resource?.id) &&
        UUID.test(row.contentEdition.benefit.version?.revisionId) &&
        /^[a-f0-9]{64}$/.test(row.contentEdition.benefit.version.sha256) &&
        row.contentEdition.targetSubjectId === row.targetSubjectId &&
        typeof row.contentEdition.source?.licence === 'string' &&
        row.contentEdition.delivery === 'fixed-content-edition' &&
        row.contentEdition.acquisition === 'one-time-account-bound' &&
        row.contentEdition.quantity === 1))
  );
}
/** One bounded private page using this request's current credential, with no owner selector or fanout. */
export async function loadCreatorOffers(
  caller: CreatorOffersCaller,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  search: CreatorOffersSearch,
): Promise<CreatorOffersData> {
  try {
    const query = creatorOffersSearch(search);
    if (await prepareSession(request, sessionEnv)) return { kind: 'denied' };
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const result = await caller.get({
      query: { limit: CREATOR_OFFERS_PAGE_SIZE, ...query },
      headers: { authorization },
    });
    if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
    if (result.status === 409) return { kind: 'stale' };
    if (result.status === 400) return { kind: 'error' };
    const page = result.data;
    if (
      result.status !== 200 ||
      !page ||
      !Array.isArray(page.offers) ||
      page.offers.length > CREATOR_OFFERS_PAGE_SIZE ||
      !page.offers.every(validOffer) ||
      !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096))
    )
      return { kind: 'unavailable' };
    // Construct the seller shape explicitly so an injected/malformed response cannot forward metadata.
    const offers = page.offers.map(
      ({
        id,
        targetSubjectId,
        title,
        currency,
        unitAmountMinor,
        taxCode,
        royaltyBasisPoints,
        state,
        revision,
        contentEdition,
      }) => ({
        id,
        targetSubjectId,
        title,
        currency,
        unitAmountMinor,
        taxCode,
        royaltyBasisPoints,
        state,
        revision,
        contentEdition:
          contentEdition === null
            ? null
            : {
                benefit: {
                  kind: contentEdition.benefit.kind,
                  resourceType: contentEdition.benefit.resourceType,
                  resource: { route: contentEdition.benefit.resource.route, id: contentEdition.benefit.resource.id },
                  version: {
                    revisionId: contentEdition.benefit.version.revisionId,
                    sha256: contentEdition.benefit.version.sha256,
                  },
                  action: contentEdition.benefit.action,
                },
                creatorAccountId: contentEdition.creatorAccountId,
                targetSubjectId: contentEdition.targetSubjectId,
                source: { licence: contentEdition.source.licence },
                saleTermsReference: contentEdition.saleTermsReference,
                delivery: contentEdition.delivery,
                acquisition: contentEdition.acquisition,
                quantity: contentEdition.quantity,
              },
      }),
    );
    return { kind: 'ready', offers, next: page.next };
  } catch {
    return { kind: 'unavailable' };
  }
}

export const readCreatorOffers = createServerFn({ method: 'GET' })
  .validator(input)
  .handler(async ({ data }): Promise<CreatorOffersData> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    return loadCreatorOffers(unavailableCreatorOffersCaller, getRequest(), env as Partial<SessionEnv>, data);
  });
