import { isUuid, type SearchParams, single, withQuery } from '../discover/scope.ts';

// `/search?q&scope&realm&lang&term` as the URL gives it. Pure functions shared
// by the route, its components and tests.

/** Main's phrase bounds (`services/main/src/routes/search.ts`), measured after trimming. */
export const PHRASE = { min: 2, max: 80 } as const;

/** Phrase search covers Global and public Realms; Main has no personal phrase profile. */
export type SearchScope = { kind: 'global' } | { kind: 'realm'; realm: string };

export interface SearchState {
  phrase: string;
  scope: SearchScope;
  /** A content language tag: only texts published in it match. */
  language: string | null;
  /** A classification Sense: only Works classified under it match. */
  term: string | null;
}

export type ParsedSearch = { ok: true; state: SearchState }
  /** `scope=mine`: shown as unsupported, never silently searched as Global. */
  | { ok: false; reason: 'mine'; phrase: string }
  | { ok: false; reason: 'malformed'; phrase: string };

// Main's page-request language pattern: subtags after the first have 2–8 characters.
const languageTag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A tag as Main compares it: the primary subtag lower-cased, the rest as written. */
export function normalizeLanguage(raw: string): string | null {
  const [primary = '', ...rest] = raw.trim().split('-');
  const tag = [primary.toLowerCase(), ...rest].join('-');
  return tag.length <= 35 && languageTag.test(tag) ? tag : null;
}

/** The phrase Main receives: trimmed, inner whitespace collapsed, NFC. */
export const normalizePhrase = (raw: string) => raw.normalize('NFC').trim().replace(/\s+/gu, ' ');

export function phraseStatus(phrase: string): 'empty' | 'short' | 'long' | 'ok' {
  const length = [...phrase].length;
  if (!length) return 'empty';
  if (length < PHRASE.min) return 'short';
  return length > PHRASE.max ? 'long' : 'ok';
}

export function parseSearchState(params: SearchParams): ParsedSearch {
  const phrase = normalizePhrase(single(params.q) ?? '');
  const scope = single(params.scope);
  const realm = single(params.realm);
  const rawLanguage = single(params.lang);
  const term = single(params.term) ?? null;
  if (scope === 'mine') return { ok: false, reason: 'mine', phrase };
  const language = rawLanguage === undefined || rawLanguage === '' ? null : normalizeLanguage(rawLanguage);
  const parsedScope: SearchScope | null = (scope === undefined || scope === 'global') && realm === undefined
    ? { kind: 'global' } : scope === 'realm' && isUuid(realm) ? { kind: 'realm', realm } : null;
  const repeated = [params.q, params.scope, params.realm, params.lang, params.term].some(Array.isArray);
  if (repeated || !parsedScope || (rawLanguage && !language) || (term !== null && !isUuid(term))) {
    return { ok: false, reason: 'malformed', phrase };
  }
  return { ok: true, state: { phrase, scope: parsedScope, language, term } };
}

export function searchHref(state: SearchState): string {
  return withQuery('/search', { q: state.phrase, ...(state.scope.kind === 'realm'
    ? { scope: 'realm', realm: state.scope.realm } : {}), lang: state.language, term: state.term });
}

/**
 * Content languages the filter offers. Main has no language facet counts yet,
 * so these are the languages REZICS publishes most, named in the reader's locale.
 */
export const searchLanguages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de'] as const;
