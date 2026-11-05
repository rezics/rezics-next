import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxAddress = 2048;
const origin = 'https://rezics.invalid';

export const screenCurrentVisitParam = 'screenVisit';
export const screenCurrentReturnParam = 'screenReturn';

export type ScreenCurrentOccurrence = { holder: string; property: string; statement: string };
export type ScreenType = 'schema:Movie' | 'schema:TVSeries' | 'schema:TVSeason' | 'schema:Episode';
export type ScreenCurrentVisit = {
  version: 1;
  subject: string;
  type: ScreenType;
  context: string;
  realm?: string;
  locale: string;
  definition: string;
  source: string;
  occurrence?: ScreenCurrentOccurrence;
};
export type ScreenCurrentReturn = Omit<ScreenCurrentVisit, 'source'>;
export type ScreenCurrentVisitSearch =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'current'; visit: ScreenCurrentVisit };
export type ScreenCurrentReturnSearch =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'current'; visit: ScreenCurrentReturn };
const baseKeys = ['version', 'subject', 'type', 'context', 'realm', 'locale', 'definition', 'occurrence'];
const screenTypes = new Set<ScreenType>(['schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode']);

function decode(value: unknown): unknown {
  if (typeof value !== 'string' || !value.length || value.length > maxAddress || !/^[A-Za-z0-9_-]+$/u.test(value))
    return undefined;
  try {
    const encoded = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(encoded + '='.repeat((4 - (encoded.length % 4)) % 4));
    const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (data.byteLength > maxAddress) return undefined;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function validOccurrence(value: unknown, subject: string): value is ScreenCurrentOccurrence {
  if (!isRecord(value) || Object.keys(value).some((key) => !['holder', 'property', 'statement'].includes(key)))
    return false;
  return (
    typeof value.holder === 'string' &&
    uuid.test(value.holder) &&
    value.holder === subject &&
    typeof value.property === 'string' &&
    value.property.length > 0 &&
    value.property.length <= 256 &&
    typeof value.statement === 'string' &&
    uuid.test(value.statement)
  );
}

function validSource(value: unknown, subject: string, locale: string, realm?: string): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || bytes(value) > maxAddress) return false;
  try {
    const address = new URL(value, origin);
    const segments = address.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const realms = address.searchParams.getAll('realm');
    return (
      address.origin === origin &&
      segments.length === 4 &&
      segments[0] === locale &&
      segments[1] === 'subjects' &&
      segments[2] === subject &&
      !!segments[3] &&
      realms.length <= 1 &&
      (!realms.length || (uuid.test(realms[0]!) && realms[0] === (realm ?? ''))) &&
      (!realm || (realms.length === 1 && realms[0] === realm)) &&
      !address.searchParams.has('context') &&
      !address.searchParams.has(screenCurrentVisitParam) &&
      !address.searchParams.has(screenCurrentReturnParam)
    );
  } catch {
    return false;
  }
}

function validBase(value: unknown): value is ScreenCurrentReturn {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !baseKeys.includes(key)) ||
    value.version !== 1 ||
    typeof value.subject !== 'string' ||
    !uuid.test(value.subject) ||
    typeof value.type !== 'string' ||
    !screenTypes.has(value.type as ScreenType) ||
    typeof value.context !== 'string' ||
    !uuid.test(value.context) ||
    (value.realm !== undefined && (typeof value.realm !== 'string' || !uuid.test(value.realm))) ||
    (value.context !== PAGE_GLOBAL_CONTEXT && value.realm === undefined) ||
    typeof value.locale !== 'string' ||
    value.locale.length < 2 ||
    value.locale.length > 35 ||
    typeof value.definition !== 'string' ||
    value.definition.length < 1 ||
    value.definition.length > 128 ||
    (value.occurrence !== undefined && !validOccurrence(value.occurrence, value.subject))
  )
    return false;
  return true;
}

function validCurrent(value: unknown): value is ScreenCurrentVisit {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => ![...baseKeys, 'source'].includes(key)) ||
    !('source' in value) ||
    !validBase(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'source')))
  )
    return false;
  return validSource(value.source, value.subject as string, value.locale as string, value.realm as string | undefined);
}

export function screenCurrentVisit(value: unknown): ScreenCurrentVisitSearch {
  if (value === undefined) return { kind: 'none' };
  const decoded = decode(value);
  return validCurrent(decoded) ? { kind: 'current', visit: decoded } : { kind: 'invalid' };
}

export function screenCurrentReturn(value: unknown): ScreenCurrentReturnSearch {
  if (value === undefined) return { kind: 'none' };
  const decoded = decode(value);
  return validBase(decoded) ? { kind: 'current', visit: decoded } : { kind: 'invalid' };
}

function encode(value: ScreenCurrentReturn | ScreenCurrentVisit): string | undefined {
  const json = JSON.stringify(value);
  const data = new TextEncoder().encode(json);
  if (data.byteLength > maxAddress) return undefined;
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function screenCurrentSourceAddress(
  pathname: string,
  search: string,
  hash: string,
  locale: string,
  subject: string,
): string | undefined {
  try {
    const address = new URL(`${pathname}${search}${hash}`, origin);
    if (address.origin !== origin) return undefined;
    const realm = address.searchParams.get('realm') ?? undefined;
    if (realm && !uuid.test(realm)) return undefined;
    address.searchParams.delete(screenCurrentVisitParam);
    address.searchParams.delete(screenCurrentReturnParam);
    const relative = `${address.pathname}${address.search}${address.hash}`;
    return validSource(relative, subject, locale, realm) && relative.length <= maxAddress ? relative : undefined;
  } catch {
    return undefined;
  }
}

export function screenCurrentVisitHref(entry: string, visit: ScreenCurrentVisit): string | undefined {
  if (!validCurrent(visit)) return undefined;
  const token = encode(visit);
  if (!token) return undefined;
  const address = new URL(entry, origin);
  if (address.origin !== origin) return undefined;
  address.searchParams.set(screenCurrentVisitParam, token);
  const href = `${address.pathname}${address.search}${address.hash}`;
  return address.search.length <= maxAddress && bytes(href) <= maxAddress * 2 ? href : undefined;
}

export function screenCurrentVisitAvailable(entry: string, visit: ScreenCurrentVisit): boolean {
  return !!screenCurrentVisitHref(entry, visit) && !!screenCurrentReturnHref(visit);
}

export function screenCurrentReturnHref(visit: ScreenCurrentVisit): string | undefined {
  if (!validCurrent(visit)) return undefined;
  const { source, ...current } = visit;
  const token = encode(current);
  if (!token) return undefined;
  const address = new URL(source, origin);
  address.searchParams.set(screenCurrentReturnParam, token);
  const href = `${address.pathname}${address.search}${address.hash}`;
  return address.search.length <= maxAddress && bytes(href) <= maxAddress * 2 ? href : undefined;
}

export function screenCurrentReturnValue(search: string): ScreenCurrentReturnSearch {
  if (search.length > maxAddress || bytes(search) > maxAddress) return { kind: 'invalid' };
  const params = new URLSearchParams(search);
  const values = params.getAll(screenCurrentReturnParam);
  if (!values.length) return { kind: 'none' };
  if (values.length !== 1 || params.has(screenCurrentVisitParam)) return { kind: 'invalid' };
  return screenCurrentReturn(values[0]);
}

export function screenCurrentVisitValue(search: string): ScreenCurrentVisitSearch {
  if (search.length > maxAddress || bytes(search) > maxAddress) return { kind: 'invalid' };
  const params = new URLSearchParams(search);
  const values = params.getAll(screenCurrentVisitParam);
  if (!values.length) return { kind: 'none' };
  if (values.length !== 1 || params.has(screenCurrentReturnParam)) return { kind: 'invalid' };
  return screenCurrentVisit(values[0]);
}

export function screenCurrentGlobalHref(entry: string, handoff?: string): string | undefined {
  const address = new URL(entry, origin);
  if (address.origin !== origin) return undefined;
  address.search = '';
  address.hash = '';
  if (handoff) address.searchParams.set('classificationHandoff', handoff);
  const href = `${address.pathname}${address.search}`;
  return address.search.length <= maxAddress ? href : undefined;
}

/** Installed correction routes carry Context and Realm only inside their separately validated visit. */
export function screenCurrentRouteVisit(search: string, handoff?: string): ScreenCurrentVisitSearch {
  const parsed = screenCurrentVisitValue(search);
  const params = new URLSearchParams(search);
  if (params.has(screenCurrentReturnParam)) return { kind: 'invalid' };
  if (parsed.kind === 'none') return params.has('context') || params.has('realm') ? { kind: 'invalid' } : parsed;
  if (parsed.kind !== 'current') return parsed;
  if (params.has('context') || params.has('realm')) return { kind: 'invalid' };
  if (handoff && parsed.visit.context !== PAGE_GLOBAL_CONTEXT) return { kind: 'invalid' };
  return parsed;
}

export function screenCurrentInspectionId(statement: string) {
  return `screen-current-evidence-${statement}`;
}

export function screenCurrentEntryId(subject: string) {
  return `screen-current-entry-${subject}`;
}

export function screenCurrentIdentity(visit: ScreenCurrentVisit | ScreenCurrentReturn, incarnation: string) {
  return JSON.stringify([
    'source' in visit ? visit.source : '',
    visit.subject,
    visit.type,
    visit.context,
    visit.realm ?? '',
    visit.locale,
    visit.definition,
    visit.occurrence?.holder ?? '',
    visit.occurrence?.property ?? '',
    visit.occurrence?.statement ?? '',
    incarnation,
  ]);
}

