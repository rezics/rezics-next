import { candidateContext } from '../../subject/candidates';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';

/** Public observation only. It contains no supplied spelling, disclosure state or correction operand. */
export type TermsPublicOrigin = {
  subject: string;
  context: string;
  realm?: string;
  locale: string;
  returnHref: string;
};

export type TermsPublicVisit =
  | { kind: 'legacy' }
  | { kind: 'origin'; origin: TermsPublicOrigin; via?: string }
  | { kind: 'fresh'; returnHref: string; via?: string }
  | { kind: 'invalid' };

export const termsPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localOrigin = 'https://rezics.invalid';
const locales = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']);

/** Charge the complete retained query after URL encoding by both existing address measures. */
export function termsPublicIntentFits(value: string): boolean {
  return value.length <= termsPublicIntentLimit && encoder.encode(value).byteLength <= termsPublicIntentLimit;
}

type PublicAddress = { href: string; context: string; realm?: string };

function publicAddress(
  value: unknown,
  subject: string,
  locale: string,
  expected?: { context: string; realm?: string },
): PublicAddress | undefined {
  if (typeof value !== 'string' || !termsPublicIntentFits(value) || !value.startsWith('/') || value.startsWith('//'))
    return;
  const href = subjectVisitReturn(value, locale);
  if (href !== value) return;
  const url = new URL(href, localOrigin);
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const contexts = url.searchParams.getAll('context');
  const realms = url.searchParams.getAll('realm');
  const context = contexts[0];
  const realm = realms[0];
  if (
    url.origin !== localOrigin ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3] !== subject ||
    path.length !== 5 ||
    !path[4] ||
    url.hash !== '#connections' ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'context' && key !== 'realm') ||
    contexts.length !== 1 ||
    !context ||
    !uuid.test(context) ||
    realms.length > 1 ||
    (realm !== undefined && !uuid.test(realm)) ||
    (expected !== undefined && (context !== expected.context || realm !== expected.realm))
  )
    return;
  return { href, context, ...(realm ? { realm } : {}) };
}

function namesReturn(
  value: unknown,
  subject: string,
  locale: string,
  expected: { context: string; realm?: string },
): string | undefined {
  if (typeof value !== 'string' || !termsPublicIntentFits(value)) return;
  const href = subjectVisitReturn(value, locale);
  if (href !== value) return;
  const url = new URL(href, localOrigin);
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const contexts = url.searchParams.getAll('context');
  const realms = url.searchParams.getAll('realm');
  if (
    url.origin !== localOrigin ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3] !== subject ||
    path.length !== 5 ||
    !path[4] ||
    url.hash !== '#supplied-names' ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'context' && key !== 'realm') ||
    contexts.length > 1 ||
    (contexts[0] !== undefined && contexts[0] !== expected.context) ||
    realms.length > 1 ||
    (realms[0] !== undefined && realms[0] !== expected.realm)
  )
    return;
  return href;
}

function normalizeOrigin(value: unknown, subject: string, locale: string): TermsPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some((key) => !['subject', 'context', 'realm', 'locale', 'returnHref'].includes(key)) ||
    origin.subject !== subject ||
    !uuid.test(subject) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm))) ||
    origin.locale !== locale ||
    !locales.has(locale)
  )
    return;
  const realm = origin.realm as string | undefined;
  const returned = publicAddress(origin.returnHref, subject, locale, {
    context: origin.context,
    ...(realm ? { realm } : {}),
  });
  if (!returned) return;
  return {
    subject,
    context: origin.context,
    ...(realm ? { realm } : {}),
    locale,
    returnHref: returned.href,
  };
}

function searchFor(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** The entry and collected menu carry the same bounded observation without a producer read. */
export function termsPublicCorrectionHref(base: string, subject: string, locale: string, origin: TermsPublicOrigin) {
  const invalid = `${base}?origin=!`;
  const admitted = normalizeOrigin(origin, subject, locale);
  if (!admitted) return invalid;
  const params = new URLSearchParams({ origin: JSON.stringify(admitted) });
  const href = `${base}${searchFor(params)}`;
  return termsPublicIntentFits(searchFor(params)) ? href : invalid;
}

/** A deliberate Global visit keeps only the one admitted public return and optional NamesTermsReturn intent. */
export function termsGlobalVisitHref(
  base: string,
  subject: string,
  locale: string,
  returnHref: string,
  via?: string,
): string {
  const returned = publicAddress(returnHref, subject, locale);
  if (!returned) return `${base}?publicReturn=!`;
  const safeVia = via === undefined ? undefined : namesReturn(via, subject, locale, returned);
  if (via !== undefined && !safeVia) return `${base}?publicReturn=!`;
  const params = new URLSearchParams({ publicReturn: returned.href, ...(safeVia ? { via: safeVia } : {}) });
  const href = `${base}${searchFor(params)}`;
  return termsPublicIntentFits(searchFor(params)) ? href : `${base}?publicReturn=!`;
}

function malformedSelectorKey(search: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query.split('&').some((part) => {
    const key = part.split('=', 1)[0] ?? '';
    if (!/(?:origin|publicReturn)/iu.test(key)) return false;
    try {
      const decoded = decodeURIComponent(key.replaceAll('+', ' '));
      return (decoded === 'origin' || decoded === 'publicReturn') && decoded !== key;
    } catch {
      return true;
    }
  });
}

function parseOrigin(raw: string, subject: string, locale: string): TermsPublicOrigin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  const origin = normalizeOrigin(value, subject, locale);
  return origin && JSON.stringify(origin) === raw ? origin : undefined;
}

/** HTTP route/search boundary. Missing intent remains the legacy Terms route. */
export function parseTermsPublicVisit(search: string, subject: string, locale: string): TermsPublicVisit {
  if (malformedSelectorKey(search)) return { kind: 'invalid' };
  const query = search.split('#', 1)[0] ?? '';
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  const hasOrigin = params.has('origin');
  const hasFreshReturn = params.has('publicReturn');
  if (!hasOrigin && !hasFreshReturn) return { kind: 'legacy' };
  if (
    !termsPublicIntentFits(query) ||
    /%(?![0-9a-f]{2})/iu.test(query) ||
    search.includes('#') ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['origin', 'publicReturn', 'via'].includes(key)) ||
    hasOrigin === hasFreshReturn
  )
    return { kind: 'invalid' };
  const viaValue = params.get('via');
  if (viaValue !== null && params.getAll('via').length !== 1) return { kind: 'invalid' };
  if (hasOrigin) {
    const raw = params.get('origin');
    if (!raw) return { kind: 'invalid' };
    const origin = parseOrigin(raw, subject, locale);
    if (!origin) return { kind: 'invalid' };
    const via = viaValue === null ? undefined : namesReturn(viaValue, subject, locale, origin);
    return viaValue !== null && !via ? { kind: 'invalid' } : { kind: 'origin', origin, ...(via ? { via } : {}) };
  }
  const returnHref = publicAddress(params.get('publicReturn'), subject, locale);
  if (!returnHref) return { kind: 'invalid' };
  const via = viaValue === null ? undefined : namesReturn(viaValue, subject, locale, returnHref);
  return viaValue !== null && !via
    ? { kind: 'invalid' }
    : { kind: 'fresh', returnHref: returnHref.href, ...(via ? { via } : {}) };
}

export function termsPublicVisitUnsupported(visit: TermsPublicVisit): boolean {
  return visit.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}
