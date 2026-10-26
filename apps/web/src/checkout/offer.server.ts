import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import type { OfferPageData } from './offer';
import { formatOfferPrice } from './price';
import { subjectCover } from './subject-cover';

type OfferRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['offers']>['get']>>['data']>;

const reads = new WeakMap<Request, Map<string, Promise<OfferPageData>>>();

async function readOnce(id: string, locale: string): Promise<OfferPageData> {
  const result = await kernelClient()
    .offers({ offerId: id })
    .get({ query: { languages: locale } });
  if (result.error) {
    if (result.status === 404 || result.error.status === 404) throw notFound();
    throw new Error('Kernel offer read failed');
  }
  const offer = (result.data as OfferRead).offer;
  return {
    id: offer.id,
    title: offer.title,
    currency: offer.currency,
    unitAmountMinor: offer.unitAmountMinor,
    state: offer.state,
    price: formatOfferPrice(locale, offer.currency, offer.unitAmountMinor),
    idempotencyKey: crypto.randomUUID(),
    subject: subjectCover(locale, offer.targetSubjectId, offer.title, offer.subject),
  };
}

export async function loadOffer(id: string, locale: string): Promise<OfferPageData> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  let pending = reads.get(request);
  if (!pending) {
    pending = new Map();
    reads.set(request, pending);
  }
  const key = `${locale}\n${id}`;
  let offer = pending.get(key);
  if (!offer) {
    offer = readOnce(id, locale);
    pending.set(key, offer);
  }
  return offer;
}
