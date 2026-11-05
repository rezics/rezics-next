import { candidateContext } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';

export type RelationPublicOrigin = {
  subject: string;
  context: string;
  realm?: string;
  locale: string;
  returnHref: string;
};

export type RelationPublicVisit =
  | { kind: 'legacy' }
  | { kind: 'origin'; origin: RelationPublicOrigin }
  | { kind: 'fresh'; returnHref: string }
  | { kind: 'invalid' };

export const relationPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localOrigin = 'https://rezics.invalid';
const locales = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']);

/** Bound the complete retained route address in characters and UTF-8 bytes. */
export function relationPublicIntentFits(address: string): boolean {
  return address.length <= relationPublicIntentLimit && encoder.encode(address).byteLength <= relationPublicIntentLimit;
}

function publicReturn(value: unknown, id: string, locale: string): { href: string; realm?: string } | undefined {
  if (typeof value !== 'string' || !relationPublicIntentFits(value)) return;
  const href = subjectVisitReturn(value, locale);
  if (!href || !relationPublicIntentFits(href)) return;
  const url = new URL(href, localOrigin);
  const route = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/subjects\/([0-9a-f-]{36})\/[^/?#]+$/iu.exec(url.pathname);
  const keys = [...url.searchParams.keys()];
  const realms = url.searchParams.getAll('realm');
  if (
    url.origin !== localOrigin ||
    !route ||
    route[1] !== locale ||
    route[2]?.toLowerCase() !== id.toLowerCase() ||
    url.hash !== '#connections' ||
    keys.some((key) => key !== 'realm') ||
    new Set(keys).size !== keys.length ||
    realms.length > 1 ||
    (realms[0] !== undefined && !uuid.test(realms[0]))
  )
    return;
  return { href, ...(realms[0] ? { realm: realms[0] } : {}) };
}

function normalizeOrigin(value: unknown, id: string, locale: string): RelationPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some((key) => !['subject', 'context', 'realm', 'locale', 'returnHref'].includes(key)) ||
    typeof origin.subject !== 'string' ||
    !uuid.test(origin.subject) ||
    origin.subject.toLowerCase() !== id.toLowerCase() ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm))) ||
    origin.locale !== locale ||
    !locales.has(locale)
  )
    return;
  const returned = publicReturn(origin.returnHref, id, locale);
  if (!returned || returned.realm !== origin.realm) return;
  return {
    subject: id,
    context: origin.context,
    ...(returned.realm ? { realm: returned.realm } : {}),
    locale,
    returnHref: returned.href,
  };
}

/** Build the menu observation only from the current admitted Subject page values. */
export function createRelationPublicOrigin(input: {
  id: string;
  label: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
}): RelationPublicOrigin | undefined {
  if (input.context === undefined) return;
  const publicUrl = new URL(subjectHref({ id: input.id, label: input.label }, input.locale).href, localOrigin);
  if (input.realm !== undefined) publicUrl.searchParams.set('realm', input.realm);
  return {
    subject: input.id,
    context: input.context,
    ...(input.realm === undefined ? {} : { realm: input.realm }),
    locale: input.locale,
    returnHref: `${publicUrl.pathname}${publicUrl.search}#connections`,
  };
}

/** The public menu and direct address use the same closed observation. */
export function relationPublicCorrectionHref(base: string, origin: RelationPublicOrigin): string {
  const href = `${base}?${new URLSearchParams({ origin: JSON.stringify(origin) })}`;
  return relationPublicIntentFits(href) ? href : `${base}?origin=!`;
}

/** A deliberate fresh Global visit keeps only its compatible public return. */
export function relationPublicFreshHref(base: string, returnHref: string): string {
  const href = `${base}?${new URLSearchParams({ publicReturn: returnHref })}`;
  return relationPublicIntentFits(href) ? href : `${base}?publicReturn=!`;
}

function parseOrigin(raw: string, id: string, locale: string): RelationPublicOrigin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof value === 'string') {
    const nested = value;
    try {
      value = JSON.parse(nested);
    } catch {
      return;
    }
    const origin = normalizeOrigin(value, id, locale);
    return origin && JSON.stringify(origin) === nested && JSON.stringify(nested) === raw ? origin : undefined;
  }
  const origin = normalizeOrigin(value, id, locale);
  return origin && JSON.stringify(origin) === raw ? origin : undefined;
}

function decodeSearch(rawSearch: string): [string, string][] | undefined {
  const raw = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  if (!raw) return [];
  const pairs: [string, string][] = [];
  try {
    for (const part of raw.split('&')) {
      if (!part) return;
      const separator = part.indexOf('=');
      const key = decodeURIComponent((separator < 0 ? part : part.slice(0, separator)).replace(/\+/gu, ' '));
      const value = decodeURIComponent((separator < 0 ? '' : part.slice(separator + 1)).replace(/\+/gu, ' '));
      if (!key || pairs.some(([seen]) => seen === key)) return;
      pairs.push([key, value]);
    }
  } catch {
    return;
  }
  return pairs;
}

/** Parse only the new public intent; legacy realm, via and specialized handoffs keep their own validators. */
export function parseRelationPublicVisit(
  rawSearch: string,
  id: string,
  locale: string,
  routePath: string,
): RelationPublicVisit {
  const raw = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  const hasMarker = /(?:^|&)(?:origin|publicReturn)(?:=|%|&|$)/iu.test(raw);
  const pairs = decodeSearch(rawSearch);
  if (!pairs) return hasMarker ? { kind: 'invalid' } : { kind: 'legacy' };
  const hasOrigin = pairs.some(([key]) => key === 'origin');
  const hasFreshReturn = pairs.some(([key]) => key === 'publicReturn');
  if (!hasOrigin && !hasFreshReturn) return { kind: 'legacy' };
  if (
    !uuid.test(id) ||
    !locales.has(locale) ||
    !relationPublicIntentFits(`${routePath}${rawSearch}`) ||
    rawSearch.includes('#') ||
    pairs.length !== 1
  )
    return { kind: 'invalid' };
  if (hasOrigin) {
    const origin = parseOrigin(pairs[0]![1], id, locale);
    return origin ? { kind: 'origin', origin } : { kind: 'invalid' };
  }
  const returned = publicReturn(pairs[0]![1], id, locale);
  return returned ? { kind: 'fresh', returnHref: returned.href } : { kind: 'invalid' };
}

export function relationPublicVisitUnsupported(visit: RelationPublicVisit): boolean {
  return visit.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}
