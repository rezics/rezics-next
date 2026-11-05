import { candidateContext } from '../../../subject/candidates';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

const streamId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]{1,128}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const controls = /[\u0000-\u001f\u007f]/u;
export const MUSIC_CONTEXT_ADDRESS_BYTE_CAP = 32768;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export type MusicContextAddress = {
  context?: string | undefined;
  realm?: string | undefined;
  stream?: string | undefined;
  cursor?: string | undefined;
};
export type MusicContextSearch = MusicContextAddress & {
  returnTo?: string | undefined;
  via?: string | undefined;
};
export type MusicContextRouteOptions = {
  subjectId?: string | undefined;
  pathname?: string | undefined;
};

export function isMusicContextStream(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && streamId.test(value);
}

export function isMusicContextCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !controls.test(value);
}

function subjectRoute(url: URL, locale: string, id?: string) {
  const segments = url.pathname.split('/');
  if (
    segments[1] !== locale ||
    segments[2] !== 'subjects' ||
    !uuid.test(segments[3] ?? '') ||
    !segments[4] ||
    (id !== undefined && segments[3] !== id)
  )
    return;
  return { id: segments[3]!, route: segments[5] };
}

function entriesOf(url: URL): Record<string, unknown> | undefined {
  const search = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(search, key)) return;
    search[key] = value;
  }
  return search;
}

/** Admit one same-locale public origin. The caller supplies the current Subject and Context when known. */
export function validatedMusicContextReturn(
  value: unknown,
  locale: string,
  subjectId?: string,
  context?: string,
  realm?: string,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MUSIC_CONTEXT_ADDRESS_BYTE_CAP ||
    utf8Bytes(value) > MUSIC_CONTEXT_ADDRESS_BYTE_CAP ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return;
  const rawPath = value.split(/[?#]/u, 1)[0] ?? '';
  if (/%(?:2f|5c)/iu.test(rawPath)) return;
  try {
    const decodedPath = decodeURIComponent(rawPath);
    if (
      controls.test(decodedPath) ||
      decodedPath.includes('\\') ||
      decodedPath.split('/').some((segment) => segment === '.' || segment === '..') ||
      /%(?:25|2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(decodedPath)
    )
      return;
  } catch {
    return;
  }
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  if (realm !== undefined) return;
  try {
    const url = new URL(accepted, 'https://rezics.invalid');
    if (utf8Bytes(`${url.pathname}${url.search}${url.hash}`) > MUSIC_CONTEXT_ADDRESS_BYTE_CAP) return;
    const identity = subjectRoute(url, locale, subjectId);
    if (!identity || identity.route === 'music-context') return;
    const selectedContext = url.searchParams.get('context');
    const selectedRealm = url.searchParams.get('realm');
    const expectedContext = context ?? candidateContext;
    if (
      (selectedContext !== null && !uuid.test(selectedContext)) ||
      (selectedContext !== null && selectedContext !== expectedContext) ||
      (expectedContext !== candidateContext && identity.route !== 'quotations' && identity.route !== 'release') ||
      (expectedContext !== candidateContext && selectedContext !== expectedContext) ||
      selectedRealm !== null
    )
      return;
    return accepted;
  } catch {
    return;
  }
}

function musicContextVisit(value: unknown, locale: string) {
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  try {
    const url = new URL(accepted, 'https://rezics.invalid');
    const identity = subjectRoute(url, locale);
    if (identity?.route !== 'music-context' || url.searchParams.has('realm')) return;
    const search = entriesOf(url);
    if (
      !search ||
      search.returnTo !== undefined ||
      search.via !== undefined ||
      !musicContextRouteSearch(search, locale, { subjectId: identity.id, pathname: url.pathname })
    )
      return;
    return accepted;
  } catch {
    return;
  }
}

export function musicContextRouteSearch(
  search: Record<string, unknown>,
  locale: string,
  options: MusicContextRouteOptions = {},
): MusicContextSearch | undefined {
  if (Object.keys(search).some((key) => !['context', 'realm', 'stream', 'cursor', 'returnTo', 'via'].includes(key)))
    return;
  const context = search.context;
  const realm = search.realm;
  const stream = search.stream;
  const cursor = search.cursor;
  const returnTo = search.returnTo;
  const via = search.via;
  if (
    (context !== undefined && (typeof context !== 'string' || !uuid.test(context))) ||
    (realm !== undefined && (typeof realm !== 'string' || !uuid.test(realm))) ||
    (stream !== undefined && !isMusicContextStream(stream)) ||
    (cursor !== undefined && (!isMusicContextCursor(cursor) || !stream)) ||
    (returnTo !== undefined &&
      !validatedMusicContextReturn(
        returnTo,
        locale,
        options.subjectId,
        typeof context === 'string' ? context : undefined,
        typeof realm === 'string' ? realm : undefined,
      )) ||
    (via !== undefined && !musicContextVisit(via, locale)) ||
    (returnTo !== undefined && via !== undefined) ||
    (via !== undefined && realm !== undefined)
  )
    return;
  if (typeof via === 'string' && options.subjectId !== undefined) {
    const origin = new URL(via, 'https://rezics.invalid');
    const originSubject = subjectRoute(origin, locale);
    if (
      !originSubject ||
      originSubject.route !== 'music-context' ||
      originSubject.id === options.subjectId ||
      (origin.searchParams.get('context') ?? candidateContext) !==
        (typeof context === 'string' ? context : candidateContext)
    )
      return;
  }
  const params = new URLSearchParams();
  if (typeof context === 'string') params.set('context', context);
  if (typeof realm === 'string') params.set('realm', realm);
  if (typeof stream === 'string') params.set('stream', stream);
  if (typeof cursor === 'string') params.set('cursor', cursor);
  if (typeof returnTo === 'string') params.set('returnTo', returnTo);
  if (typeof via === 'string') params.set('via', via);
  const retained = `${options.pathname ?? ''}${params.size ? `?${params.toString()}` : ''}`;
  if (utf8Bytes(retained) > MUSIC_CONTEXT_ADDRESS_BYTE_CAP) return;
  return {
    ...(typeof context === 'string' ? { context } : {}),
    ...(typeof realm === 'string' ? { realm } : {}),
    ...(typeof stream === 'string' ? { stream } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof returnTo === 'string' ? { returnTo } : {}),
    ...(typeof via === 'string' ? { via } : {}),
  };
}

/** Build the current public reader address within the same encoded-byte budget as a retained return. */
export function musicContextAddressHref(
  href: string,
  address: MusicContextSearch,
  locale: string,
  subjectId: string,
): string | undefined {
  const target = new URL(href, 'https://rezics.invalid');
  if (address.context !== undefined) target.searchParams.set('context', address.context);
  if (address.realm !== undefined) target.searchParams.set('realm', address.realm);
  if (address.stream !== undefined) target.searchParams.set('stream', address.stream);
  if (address.cursor !== undefined && address.stream !== undefined) target.searchParams.set('cursor', address.cursor);
  if (address.returnTo !== undefined) target.searchParams.set('returnTo', address.returnTo);
  if (address.via !== undefined) target.searchParams.set('via', address.via);
  const retained = `${target.pathname}${target.search}`;
  const search = entriesOf(target);
  return search &&
    utf8Bytes(retained) <= MUSIC_CONTEXT_ADDRESS_BYTE_CAP &&
    musicContextRouteSearch(search, locale, {
      subjectId,
      pathname: target.pathname,
    })
    ? retained
    : undefined;
}

/** Add one immediate music-reader return while keeping the target route's exact Context selector. */
export function musicContextTargetHref(
  href: string,
  via: string,
  locale: string,
  subjectId: string,
): string | undefined {
  const target = new URL(withSubjectVisitReturn(href, via, locale), 'https://rezics.invalid');
  const retained = `${target.pathname}${target.search}`;
  const search = entriesOf(target);
  return search &&
    utf8Bytes(retained) <= MUSIC_CONTEXT_ADDRESS_BYTE_CAP &&
    musicContextRouteSearch(search, locale, {
      subjectId,
      pathname: target.pathname,
    })
    ? retained
    : undefined;
}
