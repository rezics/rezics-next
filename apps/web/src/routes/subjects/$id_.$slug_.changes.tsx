import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { SubjectChanges, SubjectChangesPage } from '../../features/catalogue/subject-changes-page';
import { loadSubjectChange, loadSubjectChanges } from '../../features/catalogue/subject-changes-actions';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
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
  const { state, subject } = useSession();
  const currentHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}`;
  const transport = useMemo(
    () => ({
      list: (cursor?: string, session?: string) =>
        loadSubjectChanges({ data: { id, locale, cursor, session }, headers: csrfHeaders() }),
      detail: (revision: number, session?: string) =>
        loadSubjectChange({ data: { id, locale, revision, session }, headers: csrfHeaders() }),
    }),
    [id, locale],
  );
  if (state === 'unknown')
    return <SubjectChangesPage state={{ loading: 'list' }} locale={locale} currentHref={currentHref} />;
  if (state === 'unavailable')
    return (
      <SubjectChangesPage
        state={{ failure: { kind: 'unavailable' } }}
        currentHref={currentHref}
        locale={locale}
        onRetry={() => {
          window.location.reload();
        }}
      />
    );
  return (
    <SubjectChanges
      key={`${id}:${locale}:${state}:${subject ?? ''}`}
      locale={locale}
      transport={transport}
      currentHref={currentHref}
    />
  );
}
