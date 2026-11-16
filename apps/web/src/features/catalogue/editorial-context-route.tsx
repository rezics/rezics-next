import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime';
import { EditorialContextSession } from './editorial-context-session';
import { editorialCreateHref } from './editorial-context-location';


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
