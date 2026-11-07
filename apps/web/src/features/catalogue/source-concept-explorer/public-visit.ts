import { candidateContext } from '../../pages/visit-host-port';
import { locales } from '../../../paraglide/runtime.js';
import { subjectVisitReturn } from '../../pages/subject-visit-navigation';

/** One public observation and its immediate return; it never carries a selected Concept reading. */
export type ConceptPublicOrigin = {
  subject: string;
  context: string;
  locale: string;
  realm?: string;
  returnHref: string;
};

export type ConceptPublicVisit =
  | { kind: 'origin'; origin: ConceptPublicOrigin }
  | { kind: 'unsupported'; origin: ConceptPublicOrigin; reason: 'context' | 'realm' | 'return' }
  | { kind: 'global'; returnHref: string }
  | { kind: 'invalid' };

export const conceptPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localOrigin = 'https://rezics.invalid';

export function conceptPublicIntentFits(address: string): boolean {
  return address.length <= conceptPublicIntentLimit && encoder.encode(address).byteLength <= conceptPublicIntentLimit;
}

function conceptPathMatches(pathname: string, id: string, locale: string): boolean {
  const parts = pathname.split('/');
  return (
    uuid.test(id) &&
    locales.includes(locale as (typeof locales)[number]) &&
    parts.length === 6 &&
    parts[1] === locale &&
    parts[2] === 'subjects' &&
    parts[3]?.toLowerCase() === id.toLowerCase() &&
    !!parts[4] &&
    parts[5] === 'concepts'
  );
}

function publicSubjectPathMatches(pathname: string, id: string, locale: string): boolean {
  const parts = pathname.split('/');
  return (
    parts.length >= 5 &&
    parts.length <= 6 &&
    parts[1] === locale &&
    parts[2] === 'subjects' &&
    parts[3]?.toLowerCase() === id.toLowerCase() &&
    !!parts[4] &&
    (parts[5] === undefined || ['contents', 'editions'].includes(parts[5]))
  );
}

/** Admit a public Subject address with the exact observed Context and Realm and no nested return. */
export function conceptPublicReturn(
  value: unknown,
  id: string,
  locale: string,
  context: string,
  realm?: string,
): string | undefined {
  if (
    typeof value !== 'string' ||
    !conceptPublicIntentFits(value) ||
    !uuid.test(id) ||
    !uuid.test(context) ||
    (realm !== undefined && !uuid.test(realm))
  )
    return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted || !conceptPublicIntentFits(accepted)) return;
  const url = new URL(accepted, localOrigin);
  const parts = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  if (
    url.origin !== localOrigin ||
    parts[1] !== locale ||
    parts[2] !== 'subjects' ||
    parts[3]?.toLowerCase() !== id.toLowerCase() ||
    !parts[4] ||
    parts.length < 5 ||
    parts.length > 6 ||
    (parts[5] !== undefined && !['contents', 'editions'].includes(parts[5])) ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'context' && key !== 'realm') ||
    url.searchParams.get('context')?.toLowerCase() !== context.toLowerCase() ||
    (url.searchParams.get('realm') ?? undefined)?.toLowerCase() !== realm?.toLowerCase() ||
    url.hash !== '#connections'
  )
    return;
  return accepted;
}

/** Build the same-locale return to the currently mounted public Subject heading. */
export function conceptPublicReturnHref(
  pathname: string,
  id: string,
  locale: string,
  context: string,
  realm?: string,
): string | undefined {
  if (!pathname.startsWith('/') || !conceptPublicIntentFits(pathname)) return;
  const path = new URL(pathname, localOrigin);
  if (path.origin !== localOrigin || path.search || path.hash || !publicSubjectPathMatches(path.pathname, id, locale))
    return;
  const url = new URL(path.pathname, localOrigin);
  url.searchParams.set('context', context);
  if (realm) url.searchParams.set('realm', realm);
  url.hash = '#connections';
  const address = `${url.pathname}${url.search}${url.hash}`;
  return conceptPublicReturn(address, id, locale, context, realm);
}

function originValue(value: unknown, id: string, locale: string): ConceptPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some((key) => !['subject', 'context', 'locale', 'realm', 'returnHref'].includes(key)) ||
    origin.subject !== id ||
    !uuid.test(id) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    origin.locale !== locale ||
    !locales.includes(locale as (typeof locales)[number]) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm))) ||
    typeof origin.returnHref !== 'string'
  )
    return;
  const returnHref = conceptPublicReturn(
    origin.returnHref,
    id,
    locale,
    origin.context,
    origin.realm as string | undefined,
  );
  if (!returnHref || returnHref !== origin.returnHref) return;
  return {
    subject: id,
    context: origin.context,
    locale,
    ...(origin.realm ? { realm: origin.realm as string } : {}),
    returnHref,
  };
}

/** The complete encoded local route and outer observation pay the 2,048-character/byte budget. */
export function conceptPublicOriginHref(base: string, origin: ConceptPublicOrigin): string {
  const url = new URL(base, localOrigin);
  url.searchParams.set(
    'origin',
    JSON.stringify({
      subject: origin.subject,
      context: origin.context,
      locale: origin.locale,
      ...(origin.realm ? { realm: origin.realm } : {}),
      returnHref: origin.returnHref,
    }),
  );
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (conceptPublicIntentFits(href)) return href;
  return `${url.pathname}?origin=!`;
}

function outerFieldFits(pathname: string, search: string, name: 'origin' | 'publicReturn'): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  let fields: string[];
  try {
    fields = query.split('&').filter((field) => {
      const rawName = field.split('=', 1)[0] ?? '';
      return decodeURIComponent(rawName.replace(/\+/gu, ' ')) === name;
    });
  } catch {
    return false;
  }
  if (fields.length !== 1) return false;
  const address = `${pathname}?${fields[0]}`;
  return conceptPublicIntentFits(address);
}

function publicReturnValue(value: unknown, id: string, locale: string): string | undefined {
  if (typeof value !== 'string') return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted || accepted !== value) return;
  const url = new URL(accepted, localOrigin);
  const context = url.searchParams.get('context');
  const realm = url.searchParams.get('realm') ?? undefined;
  return conceptPublicReturn(accepted, id, locale, context ?? '', realm);
}

/** Parse only the two outer selectors; legacy inner Concept search keeps its installed grammar. */
export function parseConceptPublicVisit(
  search: string,
  id: string,
  locale: string,
  pathname: string,
  hash = '',
): ConceptPublicVisit | undefined {
  const params = new URLSearchParams(search);
  const origins = params.getAll('origin');
  const returns = params.getAll('publicReturn');
  const hasContext = params.has('context') || params.has('realm');
  if (!origins.length && !returns.length) return hasContext ? { kind: 'invalid' } : undefined;
  if (
    !conceptPathMatches(pathname, id, locale) ||
    hash !== '' ||
    /%(?![0-9a-f]{2})/iu.test(search) ||
    origins.length > 1 ||
    returns.length > 1 ||
    (origins.length > 0 && returns.length > 0) ||
    hasContext
  )
    return { kind: 'invalid' };
  const field = origins.length ? 'origin' : 'publicReturn';
  if (!outerFieldFits(pathname, search, field)) return { kind: 'invalid' };
  if (field === 'publicReturn') {
    if (params.has('returnTo')) return { kind: 'invalid' };
    const returnHref = publicReturnValue(returns[0], id, locale);
    return returnHref ? { kind: 'global', returnHref } : { kind: 'invalid' };
  }
  const raw = origins[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  const origin = originValue(parsed, id, locale);
  if (!origin || JSON.stringify(origin) !== raw) return { kind: 'invalid' };
  const reason = origin.realm
    ? 'realm'
    : origin.context.toLowerCase() !== candidateContext.toLowerCase()
      ? 'context'
      : undefined;
  if (reason) return { kind: 'unsupported', origin, reason };
  if (params.has('returnTo')) return { kind: 'unsupported', origin, reason: 'return' };
  return { kind: 'origin', origin };
}

/** A deliberate fresh Global visit retains only the validated public heading return. */
export function conceptGlobalVisitHref(pathname: string, returnHref: string): string {
  const url = new URL(pathname, localOrigin);
  url.search = '';
  url.hash = '';
  url.searchParams.set('publicReturn', returnHref);
  return `${url.pathname}${url.search}`;
}
