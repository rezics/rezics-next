import {
  organizationHistoryVisitReturnFragment,
  subjectVisitReturn,
  withSubjectVisitReturn,
  type OrganizationHistoryVisitReturn,
} from '../../../pages/subject-visit-navigation';

const origin = 'https://rezics.invalid';

/** Build one bounded address for the current Organization page and Context. */
export function organizationHistoryAddress(
  currentHref: string | undefined,
  fallbackHref: string,
  locale: string,
  holder: string,
  context: string,
  realm?: string,
  selection?: OrganizationHistoryVisitReturn,
): string {
  const fallback = new URL(fallbackHref, origin);
  fallback.search = '';
  fallback.searchParams.set('context', context);
  if (realm) fallback.searchParams.set('realm', realm);
  fallback.hash = '#connections';
  const acceptedFallback = subjectVisitReturn(`${fallback.pathname}${fallback.search}${fallback.hash}`, locale);
  if (!acceptedFallback) return fallbackHref;

  const acceptedCurrent = subjectVisitReturn(currentHref, locale);
  const current = acceptedCurrent ? new URL(acceptedCurrent, origin) : new URL(acceptedFallback, origin);
  const currentPath = current.pathname.split('/');
  const fallbackPath = fallback.pathname.split('/');
  if (
    current.origin !== origin ||
    currentPath[1] !== locale ||
    currentPath[2] !== 'subjects' ||
    currentPath[3] !== holder ||
    currentPath.length !== 5 ||
    currentPath[3] !== fallbackPath[3]
  ) {
    current.pathname = fallback.pathname;
  }
  current.search = '';
  current.searchParams.set('context', context);
  if (realm) current.searchParams.set('realm', realm);
  const exactSelection =
    selection?.holder === holder &&
    selection.context === context &&
    selection.locale === locale &&
    selection.realm === realm
      ? selection
      : undefined;
  current.hash = exactSelection ? organizationHistoryVisitReturnFragment(exactSelection) : '#connections';
  return subjectVisitReturn(`${current.pathname}${current.search}${current.hash}`, locale) ?? acceptedFallback;
}

/** Keep the selected Context and Realm on Subject, Facts and source destinations. */
export function organizationHistoryDestinationHref(
  href: string,
  context: string,
  realm: string | undefined,
  returnHref: string,
  locale: string,
): string {
  const url = new URL(href, origin);
  if (url.origin !== origin || !url.pathname.startsWith(`/${locale}/subjects/`)) return href;
  url.searchParams.set('context', context);
  if (realm) url.searchParams.set('realm', realm);
  else url.searchParams.delete('realm');
  return withSubjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, returnHref, locale);
}

/** Replace only this visit's address; keep the router's existing history state. */
export function replaceOrganizationHistoryAddress(href: string): string | undefined {
  const accepted = subjectVisitReturn(href);
  if (!accepted || typeof window === 'undefined') return;
  const url = new URL(accepted, window.location.origin);
  if (url.origin !== window.location.origin) return;
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return url.hash;
}
