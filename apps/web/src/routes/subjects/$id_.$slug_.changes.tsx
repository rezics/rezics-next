import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { createFileRoute } from '@tanstack/react-router';
import { SubjectChangesSession } from '../../features/catalogue/subject-changes-session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/changes')({
  validateSearch: (input: Record<string, unknown>) => ({ via: subjectVisitReturn(input.via, getLocale()) }),
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.changes_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ChangesRoute,
});
function ChangesRoute() {
  const { via } = Route.useSearch();
  const { id } = Route.useParams();
  const locale = getLocale();
  const currentHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}`;
  return (
    <>
      {via && (
        <a className="inline-flex min-h-11 underline" href={via}>
          {m.release_fidelity_origin()}
        </a>
      )}
      <SubjectChangesSession id={id} locale={locale} currentHref={currentHref} />
    </>
  );
}
