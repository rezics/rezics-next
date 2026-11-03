import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  candidateSession,
  captureCandidateSession,
  useCatalogueLifetime,
  type CandidateSessionLease,
} from '../../subject/candidate-lifetime';
import { sessionQuery, useSession } from '../../session/query';
import { normalizeSessionObservation } from '../../session/browser-state';
import { loadSubjectChange, loadSubjectChanges } from './subject-changes-actions';
import { SubjectChanges, SubjectChangesPage } from './subject-changes-page';
import { takeSubjectChangesReturn, type SubjectChangesReturn } from './subject-changes-navigation';

// useSession deliberately reports unknown for query errors. History also observes the
// installed query's transport state so those errors offer the same explicit recovery.
function useHistorySessionRead() {
  const client = useQueryClient();
  const subscribe = useCallback(
    (changed: () => void) =>
      client.getQueryCache().subscribe(({ query }) => {
        if (query.queryKey.length === 1 && query.queryKey[0] === sessionQuery.queryKey[0]) changed();
      }),
    [client],
  );
  const snapshot = useCallback(() => client.getQueryState(sessionQuery.queryKey), [client]);
  const read = useSyncExternalStore(subscribe, snapshot, () => undefined);
  return { client, read };
}

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
  const { client, read } = useHistorySessionRead();
  const work = useCatalogueLifetime('subject-history');
  const lease = useMemo(
    () =>
      observed.state === 'signed-in' && observed.subject
        ? captureCandidateSession(client, observed.subject)
        : undefined,
    [client, observed.state, observed.subject, observed.csrfToken],
  );
  const [restored, setRestored] = useState<{
    lease?: CandidateSessionLease;
    checked: boolean;
    visit?: SubjectChangesReturn;
  }>({ checked: false });
  useEffect(() => {
    const visit = lease ? takeSubjectChangesReturn(id, lease.reader) : undefined;
    setRestored({ ...(lease ? { lease } : {}), checked: true, ...(visit ? { visit } : {}) });
  }, [id, lease]);
  const transport = useMemo(() => {
    const headers = observed.csrfToken ? { 'X-CSRF-Token': observed.csrfToken } : {};
    const address = () => {
      const query = client.getQueryState(sessionQuery.queryKey);
      const current = query?.status === 'success' ? normalizeSessionObservation(query.data) : null;
      if (
        !work.active() ||
        !current ||
        current.state !== observed.state ||
        current.subject !== observed.subject ||
        current.csrfToken !== observed.csrfToken
      )
        throw new Error('Retired subject history');
      return { id, locale, expectedReader: work.reader || null };
    };
    return {
      list: (cursor?: string, session?: string) =>
        loadSubjectChanges({ data: { ...address(), cursor, session }, headers }),
      detail: (revision: number, session?: string) =>
        loadSubjectChange({ data: { ...address(), revision, session }, headers }),
    };
  }, [client, id, locale, work, observed.state, observed.subject, observed.csrfToken]);
  const unavailable = observed.state === 'unavailable' || read?.status === 'error';
  if (observed.state === 'unknown' || unavailable)
    return (
      <SubjectChangesPage
        state={
          read?.fetchStatus === 'fetching' || !unavailable ? { loading: 'list' } : { failure: { kind: 'unavailable' } }
        }
        locale={locale}
        currentHref={currentHref}
        onRetry={() => {
          if (!work.active() || client.getQueryState(sessionQuery.queryKey)?.fetchStatus === 'fetching') return;
          // fetchQuery replaces the installed observation; candidateSession then grants
          // a new lifetime only to its actual normalized reader and CSRF token.
          void client.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => {});
        }}
      />
    );
  if (lease && (!restored.checked || restored.lease !== lease))
    return <SubjectChangesPage state={{ loading: 'list' }} locale={locale} currentHref={currentHref} />;
  return (
    <SubjectChanges
      locale={locale}
      transport={transport}
      currentHref={currentHref}
        {...(lease ? { lease } : {})}
        {...(restored.lease === lease && restored.visit ? { initialReturn: restored.visit } : {})}
    />
  );
});
