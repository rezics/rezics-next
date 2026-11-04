import { subjectVisitReturn } from '../../pages/subject-visit-navigation';

const streamId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]{1,128}$/u;
const controls = /[\u0000-\u001f\u007f]/u;

export type MusicContextAddress = { stream?: string | undefined; cursor?: string | undefined };
export type MusicContextSearch = MusicContextAddress & { returnTo?: string | undefined };

export function isMusicContextStream(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && streamId.test(value);
}

export function isMusicContextCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !controls.test(value);
}

/** Admit one same-locale local destination without encoded path traversal or nested return payloads. */
export function validatedMusicContextReturn(value: unknown, locale: string): string | undefined {
  if (typeof value !== 'string' || value.length > 32768 || !value.startsWith('/') || value.startsWith('//')) return;
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
  return subjectVisitReturn(value, locale);
}

export function musicContextRouteSearch(
  search: Record<string, unknown>,
  locale: string,
): MusicContextSearch | undefined {
  if (Object.keys(search).some((key) => !['stream', 'cursor', 'returnTo'].includes(key))) return;
  const stream = search.stream;
  const cursor = search.cursor;
  const returnTo = search.returnTo;
  if (
    (stream !== undefined && !isMusicContextStream(stream)) ||
    (cursor !== undefined && (!isMusicContextCursor(cursor) || !stream)) ||
    (returnTo !== undefined && !validatedMusicContextReturn(returnTo, locale))
  )
    return;
  return {
    ...(typeof stream === 'string' ? { stream } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof returnTo === 'string' ? { returnTo: validatedMusicContextReturn(returnTo, locale)! } : {}),
  };
}
