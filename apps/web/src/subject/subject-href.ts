import { slug } from '@rezics/definitions/slug';
import type { PagePaths } from '../shell/head';
import { locales } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

export type SubjectHrefInput = { id: string; label: string };

export type SubjectHref = {
  to: '/subjects/$id/$slug';
  params: { id: string; slug: string };
  href: string;
};

/** The canonical localized overview address and the TanStack parameters for a subject link. */
export function subjectHref(subject: SubjectHrefInput, locale: string): SubjectHref {
  const label = subject.label || m.subject_value_unlabelled({}, { locale: locale as never });
  const subjectSlug = slug(label);
  return {
    to: '/subjects/$id/$slug',
    params: { id: subject.id, slug: subjectSlug },
    href: `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject.id)}/${subjectSlug}`,
  };
}

/** The canonical plain URL for one of a subject's views. */
export function subjectViewHref(subject: SubjectHrefInput, locale: string, view: string, query = ''): string {
  return keepSearch(subjectUrlForView(subjectHref(subject, locale), view), query);
}

export const subjectCompanionNames = ['graph', 'quotations', 'concepts', 'music-context'] as const;
export type SubjectCompanion = (typeof subjectCompanionNames)[number];

/** Explicit companion routes; these never widen the shared composition View enum. */
export function subjectCompanionHref(
  subject: SubjectHrefInput,
  locale: string,
  companion: SubjectCompanion,
  query = '',
): string {
  return keepSearch(`${subjectHref(subject, locale).href}/${companion}`, query);
}

/** Append the requested view to either canonical identity: catalogue subject or account. */
export function subjectUrlForView(subject: { href: string }, view?: string): string {
  return view && view !== 'overview' ? `${subject.href}/${encodeURIComponent(view)}` : subject.href;
}

export function accountHref(locale: string, handle: string, view?: string): string {
  return subjectUrlForView({ href: `/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}` }, view);
}

/** Paths are already encoded. Preserve the caller's query bytes and browser fragment. */
export function keepSearch(href: string, search = '', hash = ''): string {
  const fragment = hash ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  const path = href.replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
  const target = `${path}${search ? (search.startsWith('?') ? search : `?${search}`) : ''}`;
  return fragment ? `${target.split('#', 1)[0]}${fragment}` : target;
}

/** Canonical subjects use 301, account casing 308, and mutable former handles 302. */
export function canonicalRedirect(href: string, search = '', hash = '', statusCode: 301 | 308 | 302 = 301) {
  return { href: keepSearch(href, search, hash), statusCode, headers: { 'Cache-Control': 'private, no-store' } };
}

/** Add a view to each locale path for the root head's canonical and hreflang tags. */
export function subjectViewPaths(paths: PagePaths, view: string): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => [locale, subjectUrlForView({ href: paths[locale] ?? '' }, view)]),
  ) as PagePaths;
}
