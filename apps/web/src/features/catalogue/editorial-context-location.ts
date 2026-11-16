import { notFound } from '@tanstack/react-router';

export function editorialSubjectSearch(search: Record<string, unknown>): { subject?: string; slug?: string } {
  if (search.subject === undefined && search.slug === undefined) return {};
  if (
    typeof search.subject !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.subject) ||
    typeof search.slug !== 'string' ||
    search.slug.length > 128 ||
    !search.slug
  )
    throw notFound();
  return { subject: search.subject, slug: search.slug };
}

export function editorialCreateHref(locale: string, subject: string, slug: string) {
  return `/${locale}/contexts/new?${new URLSearchParams({ subject, slug })}`;
}
