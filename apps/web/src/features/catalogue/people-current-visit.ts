import { candidateContext } from '../pages/visit-host-port';
import { personBiographyReturn, subjectVisitReturn } from '../pages/subject-visit-navigation';
import { subjectHref } from '../../subject/subject-href';
import { peopleUuid } from './people-profile';

const visitLimit = 2048;
const visitQueryKeys = new Set(['visit', 'correction']);
const locales = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']);

export type PeopleCurrentVisitOrigin = {
  version: 1;
  id: string;
  context: string;
  realm?: string;
  locale: string;
  definition: string;
  reader?: string;
  returnAddress: string;
};

export type PeopleCurrentVisitSearch =
  | { kind: 'legacy' }
  | { kind: 'invalid' }
  | { kind: 'biography'; returnHref?: string }
  | { kind: 'origin'; origin: PeopleCurrentVisitOrigin; correction: 'global' | undefined };

export type PeopleCurrentVisitInput = {
  id: string;
  label: string;
  locale: string;
  context: string;
  realm?: string;
  definition: string;
  reader?: string | null;
  sourceAddress?: string;
};

function queryWithinLimit(search: string): boolean {
  return search.length <= visitLimit && new TextEncoder().encode(search).length <= visitLimit;
}

function routeSearch(visit?: string, correction?: 'global') {
  const params = new URLSearchParams();
  if (visit !== undefined) params.set('visit', visit);
  if (correction) params.set('correction', correction);
  return params.toString();
}

function overviewSourceAddress(input: PeopleCurrentVisitInput): string {
  const fallback = new URL(
    subjectHref({ id: input.id, label: input.label }, input.locale).href,
    'https://rezics.invalid',
  );
  fallback.searchParams.set('context', input.context);
  if (input.realm) fallback.searchParams.set('realm', input.realm);

  const accepted = input.sourceAddress && subjectVisitReturn(input.sourceAddress, input.locale);
  if (!accepted) return `${fallback.pathname}${fallback.search}`;
  const source = new URL(accepted, 'https://rezics.invalid');
  const segments = source.pathname.split('/');
  if (
    source.origin !== 'https://rezics.invalid' ||
    segments.length !== 5 ||
    segments[1] !== input.locale ||
    segments[2] !== 'subjects' ||
    decodeURIComponent(segments[3] ?? '') !== input.id ||
    source.searchParams.getAll('context').length !== 1 ||
    source.searchParams.get('context') !== input.context ||
    source.searchParams.getAll('realm').length !== (input.realm ? 1 : 0) ||
    (input.realm !== undefined && source.searchParams.get('realm') !== input.realm) ||
    [...source.searchParams.keys()].some((key) => key !== 'context' && key !== 'realm')
  )
    return `${fallback.pathname}${fallback.search}`;
  return `${source.pathname}${source.search}`;
}

/** Carry one bounded, non-authorizing public origin to the existing Global correction route. */
export function peopleCurrentVisitHref(input: PeopleCurrentVisitInput): string {
  const base = `${subjectHref({ id: input.id, label: input.label }, input.locale).href}/people`;
  const origin: PeopleCurrentVisitOrigin = {
    version: 1,
    id: input.id,
    context: input.context,
    ...(input.realm ? { realm: input.realm } : {}),
    locale: input.locale,
    definition: input.definition,
    ...(input.reader ? { reader: input.reader } : {}),
    returnAddress: overviewSourceAddress(input),
  };
  const encoded = JSON.stringify(origin);
  const search = routeSearch(encoded);
  const choiceSearch = routeSearch(encoded, 'global');
  return `${base}?${queryWithinLimit(search) && queryWithinLimit(choiceSearch) ? search : 'visit=invalid'}`;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function definitionValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validReturnAddress(address: string, origin: PeopleCurrentVisitOrigin): boolean {
  const accepted = subjectVisitReturn(address, origin.locale);
  if (!accepted) return false;
  const source = new URL(address, 'https://rezics.invalid');
  if (source.hash || accepted !== `${source.pathname}${source.search}#connections`) return false;
  const segments = source.pathname.split('/');
  return (
    source.origin === 'https://rezics.invalid' &&
    !source.hash &&
    segments.length === 5 &&
    segments[1] === origin.locale &&
    segments[2] === 'subjects' &&
    decodeURIComponent(segments[3] ?? '') === origin.id &&
    source.searchParams.getAll('context').length === 1 &&
    source.searchParams.get('context') === origin.context &&
    source.searchParams.getAll('realm').length === (origin.realm ? 1 : 0) &&
    (origin.realm === undefined || source.searchParams.get('realm') === origin.realm) &&
    [...source.searchParams.keys()].every((key) => key === 'context' || key === 'realm')
  );
}

function validOrigin(
  value: unknown,
  encoded: string,
  id: string,
  locale: string,
): PeopleCurrentVisitOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ['version', 'id', 'context', 'locale', 'definition', 'returnAddress'], ['realm', 'reader']) ||
    record.version !== 1 ||
    typeof record.id !== 'string' ||
    record.id !== id ||
    !peopleUuid.test(record.id) ||
    typeof record.context !== 'string' ||
    !peopleUuid.test(record.context) ||
    (record.realm !== undefined && (typeof record.realm !== 'string' || !peopleUuid.test(record.realm))) ||
    (record.realm !== undefined && record.context === candidateContext) ||
    typeof record.locale !== 'string' ||
    !locales.has(record.locale) ||
    record.locale !== locale ||
    !definitionValue(record.definition) ||
    (record.reader !== undefined &&
      (typeof record.reader !== 'string' ||
        record.reader.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(record.reader))) ||
    typeof record.returnAddress !== 'string' ||
    record.returnAddress.length > visitLimit
  )
    return;
  const origin = record as PeopleCurrentVisitOrigin;
  if (JSON.stringify(origin) !== encoded || !validReturnAddress(origin.returnAddress, origin)) return;
  return origin;
}

/** Validate route input before mounting the editor; malformed intent never becomes a Global visit. */
export function validatePeopleCurrentVisitSearch(
  search: Record<string, unknown>,
  id: string,
  locale: string,
  hash = '',
): PeopleCurrentVisitSearch {
  const keys = Object.keys(search);
  const biography = personBiographyReturn(hash);
  if (biography) {
    if (
      !peopleUuid.test(id) ||
      !locales.has(locale) ||
      keys.some((key) => key !== 'context' && key !== 'via') ||
      search.context !== biography.context ||
      search.context !== candidateContext
    )
      return { kind: 'invalid' };
    if (search.via === undefined) return { kind: 'biography' };
    if (
      typeof search.via !== 'string' ||
      !queryWithinLimit(new URLSearchParams({ context: biography.context, via: search.via }).toString())
    )
      return { kind: 'invalid' };
    const via = subjectVisitReturn(search.via, locale);
    if (!via) return { kind: 'invalid' };
    const outer = new URL(via, 'https://rezics.invalid');
    const segments = outer.pathname.split('/');
    if (
      segments.length !== 5 ||
      segments[2] !== 'subjects' ||
      segments[3] !== id ||
      outer.hash !== '#connections' ||
      [...outer.searchParams.keys()].some((key) => key !== 'context' && key !== 'realm')
    )
      return { kind: 'invalid' };
    outer.hash = 'person-biography';
    return { kind: 'biography', returnHref: `${outer.pathname}${outer.search}${outer.hash}` };
  }
  if (hash.startsWith('#person-biography?')) return { kind: 'invalid' };
  if (keys.length === 0) return { kind: 'legacy' };
  if (
    keys.some((key) => !visitQueryKeys.has(key)) ||
    !keys.includes('visit') ||
    (search.correction !== undefined && search.correction !== 'global') ||
    typeof search.visit !== 'string'
  )
    return { kind: 'invalid' };
  const correction = search.correction as 'global' | undefined;
  const query = routeSearch(search.visit, correction);
  if (
    !queryWithinLimit(query) ||
    !queryWithinLimit(routeSearch(search.visit, 'global')) ||
    !peopleUuid.test(id) ||
    !locales.has(locale)
  )
    return { kind: 'invalid' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(search.visit);
  } catch {
    return { kind: 'invalid' };
  }
  const origin = validOrigin(decoded, search.visit, id, locale);
  return origin ? { kind: 'origin', origin, correction } : { kind: 'invalid' };
}

export function peopleCurrentVisitNeedsGlobal(origin: PeopleCurrentVisitOrigin): boolean {
  return origin.context !== candidateContext || origin.realm !== undefined;
}

/** Return to the existing public Person reader heading after its Subject route loads again. */
export function peopleCurrentVisitReturnHref(origin: PeopleCurrentVisitOrigin): string {
  return `${origin.returnAddress}#person-biography`;
}

export function peopleCurrentVisitGlobalHref(pathname: string, origin: PeopleCurrentVisitOrigin): string {
  return `${pathname}?${routeSearch(JSON.stringify(origin), 'global')}`;
}
