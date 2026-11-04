import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { creditWindowHref } from './navigation';
import type { CreditAssertion, CreditVisit } from './model';

/** Carry one validated source address; the receiving native page resolves its own current Context. */
export function creditDestinationHref(
  href: string,
  visit: CreditVisit,
  credit: CreditAssertion,
  locale: string,
): string {
  if (!/^\/[^/]+\/subjects\//.test(href)) return href;
  const target = new URL(href, 'https://rezics.invalid');
  if (visit.realm) target.searchParams.set('realm', visit.realm);
  return withSubjectVisitReturn(
    `${target.pathname}${target.search}${target.hash}`,
    creditWindowHref(visit, locale, credit),
    locale,
  );
}
