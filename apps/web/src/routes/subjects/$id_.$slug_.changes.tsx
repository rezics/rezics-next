import { createFileRoute } from '@tanstack/react-router';
import { SubjectChangesSession } from '../../features/catalogue/subject-changes-session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/changes')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.changes_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ChangesRoute,
});
function ChangesRoute() {
  const { id } = Route.useParams();
  const locale = getLocale();
  const currentHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}`;
  return <SubjectChangesSession id={id} locale={locale} currentHref={currentHref} />;
}
