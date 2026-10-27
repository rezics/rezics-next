import { slug } from '@rezics/definitions/slug';

const memoryKey = '__rezicsThreadSlugs';

/** The slug of a thread title. A thread whose title is null is `thread`. */
export function threadSlug(title: string | null | undefined): string {
  return title ? slug(title) : 'thread';
}

/** A title carried on a thread read, or null when the opening post was erased. */
export function threadTitle(thread: { title?: string | null }): string | null {
  return typeof thread.title === 'string' && thread.title ? thread.title : null;
}

/** The canonical path of a thread, without a locale prefix. The id alone decides the page. */
export function threadHref(thread: { id: string; title: string | null }): string {
  return `/threads/${encodeURIComponent(thread.id)}/${encodeURIComponent(threadSlug(thread.title))}`;
}

/** The locale path of a thread, keeping an opaque cursor when the reader is past the first page. */
export function threadLocation(locale: string, thread: { id: string; title: string | null }, cursor?: string): string {
  const path = `/${locale}${threadHref(thread)}`;
  return cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * The latest slug seen in thread or board data. This lets a canonical page start its established
 * thread and post reads together while URLs known to be outdated can redirect after the thread read.
 */
function slugs(): Map<string, string> {
  const host = globalThis as typeof globalThis & { [memoryKey]?: Map<string, string> };
  return (host[memoryKey] ??= new Map());
}

export function rememberedThreadSlug(id: string): string | undefined {
  return slugs().get(id);
}

export function rememberThreadSlug(id: string, title: string | null): void {
  slugs().set(id, threadSlug(title));
}

export function forgetThreadSlug(id: string): void {
  slugs().delete(id);
}

export function slugMatches(requested: string, canonical: string): boolean {
  if (requested === canonical) return true;
  try {
    return decodeURIComponent(requested) === canonical;
  } catch {
    return false;
  }
}

export function sameThreadSlug(requested: string, title: string | null): boolean {
  return slugMatches(requested, threadSlug(title));
}
