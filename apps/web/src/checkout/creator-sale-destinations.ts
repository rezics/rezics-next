import { localizeHref } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import type { CreatorSale } from './creator-sales';
import { UUID } from './price';

/** Identities alone select ordinary readers. No sale terms, buyer order or return URL crosses this boundary. */
export function creatorSaleDestinations(sale: Pick<CreatorSale, 'offerId' | 'targetSubjectId'>, locale: string) {
  return {
    offer: UUID.test(sale.offerId)
      ? localizeHref(`/offers/${encodeURIComponent(sale.offerId)}`, { locale: locale as never })
      : null,
    // A captured offer title is not the current work title or a work-kind discriminator.
    work: UUID.test(sale.targetSubjectId) ? subjectHref({ id: sale.targetSubjectId, label: '' }, locale).href : null,
  };
}
