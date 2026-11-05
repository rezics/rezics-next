import type { PageContinuation } from '@rezics/composition';
import { subjectHref, subjectViewHref } from '../../../subject/subject-href';

/** A locator is browsing intent. It contains no assertion body, permission or correction operands. */
export type MangaOccurrence = {
  node: string;
  direction: 'forward' | 'inverse';
  property: string;
  holder: string;
  statement: string;
  target: string;
};

export const MANGA_ORIGIN_LIMIT = 2048;
const prefix = '#manga-reader?';
const fields = ['node', 'direction', 'property', 'holder', 'statement', 'target'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function token(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}

export function validMangaOccurrence(value: MangaOccurrence): boolean {
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(value.node) &&
    (value.direction === 'forward' || value.direction === 'inverse') &&
    token(value.property, 256) &&
    uuid.test(value.holder) &&
    token(value.statement, 128) &&
    uuid.test(value.target)
  );
}

/** Include every native association dimension; titles, target alone and list offsets cannot select a row. */
export function mangaOccurrenceKey(value: MangaOccurrence): string {
  return JSON.stringify(fields.map((field) => value[field]));
}

export function mangaOccurrenceFragment(value: MangaOccurrence): string {
  if (!validMangaOccurrence(value)) return '#manga-reader';
  const fragment = `${prefix}${new URLSearchParams(value)}`;
  return fragment.length <= MANGA_ORIGIN_LIMIT ? fragment : '#manga-reader';
}

/** Reject partial and duplicate locators instead of falling back to a similarly labelled occurrence. */
export function mangaOccurrenceFromFragment(fragment: string): MangaOccurrence | undefined {
  if (!fragment.startsWith(prefix) || fragment.length > MANGA_ORIGIN_LIMIT) return;
  const params = new URLSearchParams(fragment.slice(prefix.length));
  const keys = [...params.keys()];
  if (
    keys.length !== fields.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !fields.includes(key as never))
  )
    return;
  const value = Object.fromEntries(params) as MangaOccurrence;
  return validMangaOccurrence(value) ? value : undefined;
}

/** The exact supported current address stays finite; only its fragment describes an occurrence. */
export function mangaReaderAddress({
  id,
  label,
  locale,
  view,
  realm,
  continuation,
}: {
  id: string;
  label: string;
  locale: string;
  view: string;
  realm?: string | undefined;
  continuation?: PageContinuation | undefined;
}): string {
  const base = subjectViewHref({ id, label }, locale, view);
  const url = new URL(base, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  if (continuation) {
    url.searchParams.set('node', continuation.node);
    url.searchParams.set('cursor', continuation.cursor);
  }
  return `${url.pathname}${url.search}#manga-reader`;
}

/** `current` must first pass the ordinary Subject visit-address consumer. */
export function mangaCurrentAddress(current: string | undefined, fallback: string): string {
  if (!current) return fallback;
  const base = new URL(fallback, 'https://rezics.invalid');
  const supplied = new URL(current, base);
  if (
    supplied.origin !== base.origin ||
    supplied.pathname !== base.pathname ||
    supplied.searchParams.get('realm') !== base.searchParams.get('realm') ||
    supplied.searchParams.get('node') !== base.searchParams.get('node') ||
    supplied.searchParams.get('cursor') !== base.searchParams.get('cursor')
  )
    return fallback;
  // The outer visit has a separate owner. Do not build a nested opener chain.
  supplied.searchParams.delete('via');
  return `${supplied.pathname}${supplied.search}${supplied.hash || '#manga-reader'}`;
}

export function mangaSelectedAddress(address: string, occurrence?: MangaOccurrence): string {
  return `${address.split('#', 1)[0]}${occurrence ? mangaOccurrenceFragment(occurrence) : '#manga-reader'}`;
}

/** Retry keeps the failed node and cursor. Only an explicit restart drops its cursor. */
export function mangaRestartAddress(address: string): string {
  const url = new URL(address, 'https://rezics.invalid');
  url.searchParams.delete('cursor');
  return `${url.pathname}${url.search}#manga-reader`;
}

/** A full-view native continuation replaces this page. Overview previews enter the full view afresh. */
export function mangaWindowAddress(
  subject: { id: string; label: string },
  locale: string,
  view: 'contents' | 'editions',
  realm?: string,
  continuation?: PageContinuation,
): string {
  return mangaReaderAddress({ ...subject, locale, view, realm, continuation });
}

/** The native holder editor rereads its own authority; the locator is carried only in the public opener. */
export function mangaCorrectionAddress(holder: { id: string; label: string }, locale: string): string {
  return `${subjectHref(holder, locale).href}/relation-edit`;
}
