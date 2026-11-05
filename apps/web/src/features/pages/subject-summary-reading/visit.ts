import {
  subjectVisitReturn,
  summaryReadingReturn,
  withSubjectVisitReturn,
  type SummaryReadingReturn,
} from '../subject-visit-navigation';

// The authored route's existing outer address budget is stricter than the fragment budget.
export const SUMMARY_VISIT_ADDRESS_BYTE_CAP = 2048;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export type SynopsisVisit =
  | { kind: 'ordinary'; returnTo?: string }
  | { kind: 'invalid' }
  | { kind: 'selected'; returnTo: string; selection: SummaryReadingReturn };

/** Admit an external visit address once; a broken explicit selection never becomes a default field visit. */
export function synopsisVisit(value: unknown, subject: string, locale: string): SynopsisVisit {
  if (value === undefined || value === null) return { kind: 'ordinary' };
  const returnTo = subjectVisitReturn(value, locale);
  if (!returnTo || bytes(returnTo) > SUMMARY_VISIT_ADDRESS_BYTE_CAP) return { kind: 'invalid' };
  const url = new URL(returnTo, 'https://rezics.invalid');
  if (!url.hash.startsWith('#subject-summary-reading?')) return { kind: 'ordinary', returnTo };
  const selection = summaryReadingReturn(url.hash);
  const path = url.pathname.split('/');
  if (
    !selection ||
    bytes(url.hash) > 2048 ||
    selection.locale !== locale ||
    !selection.context ||
    path.length !== 5 ||
    path[3] !== subject ||
    (url.searchParams.get('realm') ?? undefined) !== selection.realm
  )
    return { kind: 'invalid' };
  return { kind: 'selected', returnTo, selection };
}

/** Charge the whole encoded destination, including via expansion, before exposing a real browser link. */
export function synopsisVisitHref(destination: string, returnTo: string, locale: string): string | undefined {
  if (!subjectVisitReturn(returnTo, locale)) return;
  const href = withSubjectVisitReturn(destination, returnTo, locale);
  return bytes(href) <= SUMMARY_VISIT_ADDRESS_BYTE_CAP ? href : undefined;
}
