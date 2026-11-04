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

/** Statement navigation retains its ordinary list meaning; there is no supplied sale-to-line relation. */
export function creatorSaleStatementDestination(locale: string): string {
  return localizeHref('/creator/statements', { locale: locale as never });
}

/** Capture only an exact supported same-origin destination, with no arbitrary return URL. */
export function supportedCreatorSaleDeparture(
  sale: Pick<CreatorSale, 'offerId' | 'targetSubjectId'>,
  locale: string,
  href: string,
  origin: string,
): string | null {
  try {
    const target = new URL(href, origin);
    if (target.origin !== origin || target.username || target.password || target.search || target.hash) return null;
    const destinations = creatorSaleDestinations(sale, locale);
    const supported = [destinations.offer, destinations.work, creatorSaleStatementDestination(locale)];
    return supported.includes(target.pathname) ? target.pathname : null;
  } catch {
    return null;
  }
}
