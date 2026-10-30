import { notFound } from '@tanstack/react-router';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime';
import { EditorialContextSession } from './editorial-context-session';

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
export function EditorialContextPage({ id, subject, slug }: { id?: string; subject?: string; slug?: string }) {
  const locale = getLocale();
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeading>{id ? m.editorial_title() : m.editorial_create()}</PageHeading>
      <EditorialContextSession
        {...(id ? { id } : {})}
        locale={locale}
        {...(subject && slug
          ? {
              reviewHref: (context: string) =>
                `/${locale}/subjects/${encodeURIComponent(subject)}/${encodeURIComponent(slug)}/context-review?${new URLSearchParams({ context })}`,
              createHref: editorialCreateHref(locale, subject, slug),
            }
          : {})}
      />
    </article>
  );
}
