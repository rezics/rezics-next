import { slug } from '@rezics/definitions/slug';
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
  const href = `${subjectHref(subject, locale).href}/${encodeURIComponent(view)}`;
  return query ? `${href}${query.startsWith('?') ? query : `?${query}`}` : href;
}
