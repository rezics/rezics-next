import {
  organizationHistoryVisitReturn,
  subjectVisitReturn,
  withSubjectVisitReturn,
} from '../../pages/subject-visit-navigation';

const origin = 'https://rezics.invalid';
const intentLimit = 2048;

type ProducerHistoryAddress = {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function withinLimit(value: string): boolean {
  return value.length <= intentLimit && byteLength(value) <= intentLimit;
}

function isOrganizationOverview(url: URL, { id, locale }: ProducerHistoryAddress): boolean {
  const segments = url.pathname.split('/');
  return (
    url.origin === origin &&
    segments.length === 5 &&
    segments[1] === locale &&
    segments[2] === 'subjects' &&
    segments[3]?.toLowerCase() === id.toLowerCase() &&
    !!segments[4]
  );
}

function same(value: string | null, expected: string | undefined): boolean {
  return expected === undefined ? value === null : value?.toLowerCase() === expected.toLowerCase();
}

function outerSearchFits(url: URL): boolean {
  const search = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  return withinLimit(search);
}

/** Validate a single public Organization return without retaining a nested trail or reader payload. */
export function producerHistoryVisitReturn(value: unknown, address: ProducerHistoryAddress): string | undefined {
  if (typeof value !== 'string' || !withinLimit(value)) return;
  const accepted = subjectVisitReturn(value, address.locale);
  if (!accepted || !withinLimit(accepted)) return;
  const url = new URL(accepted, origin);
  if (!isOrganizationOverview(url, address)) return;

  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'context' && key !== 'realm' && key !== 'via') ||
    url.searchParams.has('via')
  )
    return;
  const context = url.searchParams.get('context');
  const realm = url.searchParams.get('realm');
  if ((address.context && !same(context, address.context)) || (address.realm && !same(realm, address.realm))) return;

  const history = organizationHistoryVisitReturn(url.hash);
  if (
    (url.hash !== '#connections' && !history) ||
    (history &&
      (history.locale !== address.locale ||
        !same(history.context, context ?? undefined) ||
        !same(history.realm ?? null, realm ?? undefined)))
  )
    return;

  const query = new URLSearchParams();
  if (address.context) query.set('context', address.context);
  if (address.realm) query.set('realm', address.realm);
  query.set('via', accepted);
  if (!withinLimit(query.toString())) return;
  return accepted;
}

/** Append the admitted immediate return to a producer address, enforcing its combined query budget. */
export function withProducerHistoryReturn(
  href: string,
  value: unknown,
  address: ProducerHistoryAddress,
): string | undefined {
  const accepted = producerHistoryVisitReturn(value, address);
  if (!accepted) return;
  const result = withSubjectVisitReturn(href, accepted, address.locale);
  const url = new URL(result, origin);
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'context' && key !== 'realm' && key !== 'via') ||
    !outerSearchFits(url)
  )
    return;
  return `${url.pathname}${url.search}${url.hash}`;
}

export type ProducerHistoryEntryVisit = { href: string; returnHref: string; restarted: boolean };

/** Preserve the current admitted Organization history locator when it fits; otherwise return to its overview. */
export function producerHistoryEntryVisit({
  href,
  currentHref,
  fallbackHref,
  id,
  locale,
  context,
  realm,
}: ProducerHistoryAddress & {
  href: string;
  currentHref?: string | undefined;
  fallbackHref: string;
}): ProducerHistoryEntryVisit | undefined {
  const address = { id, locale, context, realm };
  const acceptedCurrent = subjectVisitReturn(currentHref, locale);
  const current = acceptedCurrent ? new URL(acceptedCurrent, origin) : undefined;
  const currentMatches = !!current && isOrganizationOverview(current, address);
  const source = currentMatches ? current! : new URL(fallbackHref, origin);
  const selection = currentMatches ? organizationHistoryVisitReturn(source.hash) : undefined;
  const preserveSelection =
    selection?.locale === locale && same(selection.context, context) && same(selection.realm ?? null, realm);
  const buildReturn = (keepSelection: boolean, useFallbackPath = false) => {
    const result = new URL(useFallbackPath ? fallbackHref : source.pathname, origin);
    if (context) result.searchParams.set('context', context);
    if (realm) result.searchParams.set('realm', realm);
    result.hash = keepSelection && preserveSelection ? source.hash : '#connections';
    return subjectVisitReturn(`${result.pathname}${result.search}${result.hash}`, locale);
  };

  let returnHref = buildReturn(true);
  if (!returnHref) return;
  let entryHref = withProducerHistoryReturn(href, returnHref, address);
  let keptSelection = !!preserveSelection;
  if (!entryHref && preserveSelection) {
    returnHref = buildReturn(false, true);
    if (!returnHref) return;
    entryHref = withProducerHistoryReturn(href, returnHref, address);
    keptSelection = false;
  }
  if (!entryHref) return;
  return {
    href: entryHref,
    returnHref,
    restarted: !!selection && !keptSelection,
  };
}
