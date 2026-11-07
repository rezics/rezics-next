import { candidateContext } from '../pages/visit-host-port';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';

/** A public observation only. It never names an assertion, document body, draft or command. */
export type AuthoredPublicOrigin = {
  subject: string;
  context: string;
  realm?: string;
  locale: string;
  returnHref: string;
};

export type AuthoredPublicVisit =
  | { kind: 'legacy' }
  | { kind: 'origin'; origin: AuthoredPublicOrigin }
  | { kind: 'fresh'; returnHref: string }
  | { kind: 'invalid' };

export const authoredPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localOrigin = 'https://rezics.invalid';

/** The entire retained address pays both authored-route search ceilings after encoding. */
export function authoredPublicIntentFits(value: string): boolean {
  return value.length <= authoredPublicIntentLimit && encoder.encode(value).byteLength <= authoredPublicIntentLimit;
}

function publicReturn(value: unknown, subject: string, locale: string): { href: string; realm?: string } | undefined {
  if (typeof value !== 'string' || !authoredPublicIntentFits(value) || !value.startsWith('/') || value.startsWith('//'))
    return;
  const href = subjectVisitReturn(value, locale);
  if (!href || !authoredPublicIntentFits(href)) return;
  const url = new URL(href, localOrigin);
  const source = new URL(value, localOrigin);
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const realms = url.searchParams.getAll('realm');
  if (
    source.origin !== localOrigin ||
    url.origin !== localOrigin ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3] !== subject ||
    path.length !== 5 ||
    !path[4] ||
    url.hash !== '#connections' ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'realm') ||
    realms.length > 1 ||
    (realms[0] !== undefined && !uuid.test(realms[0]))
  )
    return;
  return { href, ...(realms[0] ? { realm: realms[0] } : {}) };
}

function normalizeOrigin(value: unknown, subject: string, locale: string): AuthoredPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some((key) => !['subject', 'context', 'realm', 'locale', 'returnHref'].includes(key)) ||
    origin.subject !== subject ||
    !uuid.test(subject) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm))) ||
    origin.locale !== locale
  )
    return;
  const realm = origin.realm as string | undefined;
  const returned = publicReturn(origin.returnHref, subject, locale);
  if (!returned || returned.realm !== realm) return;
  return {
    subject,
    context: origin.context,
    ...(realm ? { realm } : {}),
    locale,
    returnHref: returned.href,
  };
}

/** Build the same closed public descriptor for the direct entry and collected contribution menu. */
export function authoredPublicCorrectionHref(base: string, origin: AuthoredPublicOrigin): string {
  const path = new URL(base, localOrigin);
  const admitted = normalizeOrigin(origin, origin.subject, origin.locale);
  if (!admitted || path.origin !== localOrigin || path.pathname.split('/')[1] !== origin.locale)
    return `${base}?origin=!`;
  const href = `${base}?${new URLSearchParams({ origin: JSON.stringify(admitted) })}`;
  const full = new URL(href, localOrigin);
  return authoredPublicIntentFits(`${full.pathname}${full.search}${full.hash}`) ? href : `${base}?origin=!`;
}

/** A deliberate fresh Global authored visit carries only the already admitted public return. */
export function authoredGlobalVisitHref(base: string, subject: string, locale: string, returnHref: string): string {
  const returned = publicReturn(returnHref, subject, locale);
  if (!returned) return `${base}?publicReturn=!`;
  const href = `${base}?${new URLSearchParams({ publicReturn: returned.href })}`;
  const full = new URL(href, localOrigin);
  return authoredPublicIntentFits(`${full.pathname}${full.search}${full.hash}`) ? href : `${base}?publicReturn=!`;
}

function parseOrigin(raw: string, subject: string, locale: string): AuthoredPublicOrigin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  const origin = normalizeOrigin(value, subject, locale);
  return origin && JSON.stringify(origin) === raw ? origin : undefined;
}

/** Route boundary admission. Missing generic intent stays distinct from malformed supplied intent. */
export function parseAuthoredPublicVisit(
  search: string,
  subject: string,
  locale: string,
  canonicalPath: string,
): AuthoredPublicVisit {
  const query = search.split('#', 1)[0] ?? '';
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  const hasOrigin = params.has('origin');
  const hasFreshReturn = params.has('publicReturn');
  if (/(?:^|[?&])(?:origin|publicReturn)%(?![0-9a-f]{2})/i.test(search)) return { kind: 'invalid' };
  if (!hasOrigin && !hasFreshReturn) return { kind: 'legacy' };
  if (
    !authoredPublicIntentFits(`${canonicalPath}${search}`) ||
    /%(?![0-9a-f]{2})/i.test(search) ||
    search.includes('#') ||
    new Set(keys).size !== keys.length ||
    keys.length !== 1
  )
    return { kind: 'invalid' };
  if (hasOrigin) {
    const raw = params.get('origin');
    if (!raw) return { kind: 'invalid' };
    const origin = parseOrigin(raw, subject, locale);
    return origin ? { kind: 'origin', origin } : { kind: 'invalid' };
  }
  const returned = publicReturn(params.get('publicReturn'), subject, locale);
  return returned ? { kind: 'fresh', returnHref: returned.href } : { kind: 'invalid' };
}

export function authoredPublicVisitUnsupported(visit: AuthoredPublicVisit): boolean {
  return visit.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}
