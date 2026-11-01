import { useMemo } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { loadSubjectChange, loadSubjectChanges } from './subject-changes-actions';
import { SubjectChanges, SubjectChangesPage } from './subject-changes-page';

/** One admitted visit owns both its observed reader and its submitted CSRF header. */
export const SubjectChangesSession = candidateSession(function SubjectChangesSession({
  id,
  locale,
  currentHref,
}: {
  id: string;
  locale: string;
  currentHref: string;
}) {
  const observed = useSession();
  const work = useCatalogueLifetime('subject-history');
  const transport = useMemo(() => {
    const headers = observed.csrfToken ? { 'X-CSRF-Token': observed.csrfToken } : {};
    const address = () => {
      if (!work.active()) throw new Error('Retired subject history');
      return { id, locale, expectedReader: work.reader || null };
    };
    return {
      list: (cursor?: string, session?: string) =>
        loadSubjectChanges({ data: { ...address(), cursor, session }, headers }),
      detail: (revision: number, session?: string) =>
        loadSubjectChange({ data: { ...address(), revision, session }, headers }),
    };
  }, [id, locale, work, observed.csrfToken]);
  if (observed.state === 'unknown')
    return <SubjectChangesPage state={{ loading: 'list' }} locale={locale} currentHref={currentHref} />;
  if (observed.state === 'unavailable')
    return (
      <SubjectChangesPage
        state={{ failure: { kind: 'unavailable' } }}
        locale={locale}
        currentHref={currentHref}
        onRetry={() => {
          if (work.active()) window.location.reload();
        }}
      />
    );
  return <SubjectChanges locale={locale} transport={transport} currentHref={currentHref} />;
});
