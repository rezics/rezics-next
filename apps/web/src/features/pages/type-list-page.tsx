import { useContext, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnonymousSessionContext, sessionQuery, useSession } from '../../session/query';
import { Button } from '../../components/ui/button';
import { m } from '../../paraglide/messages.js';
import { useListReaderAdmission } from './list-reader-admission';
import { hasSelectedRealmTarget, typeListTargetFromPage } from './type-list-model';
import { typeListQuery, type TypeListAdmissionInput, type TypeListQueryResult } from './type-list-query';
import type { TypeListTarget } from './type-list-model';
import { findTypeList } from './type-list-model';
import type { SubjectPageData } from './subject';
import { PageData } from './data';
import { TypeList } from './type-list';
import { subjectPageMessages } from './route-support';

type ConfiguredListProps = {
  list: string;
  page: string;
  cursor?: string;
  locale: string;
  initialData?: TypeListQueryResult;
};

type ReaderRequest = TypeListQueryResult['admission']['request'];

function sameReaderRequest(
  request: ReaderRequest | undefined,
  input: { state: TypeListAdmissionInput['state']; expectedReader: string | null | undefined },
  locale: string,
  node: string,
  page: string,
  cursor?: string,
): request is ReaderRequest {
  return (
    !!request &&
    request.locale === locale &&
    request.node === node &&
    request.page === page &&
    request.cursor === cursor &&
    request.state === input.state &&
    request.expectedReader === input.expectedReader
  );
}

/** A route list observes the current session before admitting rows or continuation controls. */
export function ConfiguredList({ list, page, cursor, locale, initialData }: ConfiguredListProps) {
  const session = useSession();
  const anonymous = useContext(AnonymousSessionContext);
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const target = typeListTargetFromPage(page);
  const selectedRealm = hasSelectedRealmTarget(target);
  const reader = useListReaderAdmission(queryClient, JSON.stringify([locale, list, page, cursor ?? null]), {
    sourceFingerprint: initialData
      ? JSON.stringify([initialData.kind, initialData.admission.request])
      : 'no-loader-data',
    privateReading: selectedRealm,
    observeSession: selectedRealm && !anonymous,
    fallbackSession: session,
  });
  const currentSession = selectedRealm ? reader.session : session;
  const state: TypeListAdmissionInput['state'] = selectedRealm ? currentSession.state : 'public';
  const expectedReader =
    !selectedRealm || state === 'unknown' ? undefined : state === 'signed-in' ? (currentSession.subject ?? null) : null;
  const requestMatches = sameReaderRequest(
    initialData?.admission.request,
    { state, expectedReader },
    locale,
    list,
    page,
    cursor,
  );
  const mode: TypeListAdmissionInput['mode'] = !selectedRealm
    ? 'public'
    : state === 'unknown' && requestMatches && initialData.admission.request.mode === 'initial-hydration'
      ? 'initial-hydration'
      : 'current';
  const incarnation = selectedRealm ? reader.incarnation : 'public';
  const admission: TypeListAdmissionInput = {
    state,
    ...(expectedReader !== undefined ? { expectedReader } : {}),
    incarnation,
    mode,
  };
  const options = typeListQuery(
    locale,
    list,
    page,
    cursor,
    admission,
    selectedRealm ? { isCurrent: () => reader.current(incarnation) } : undefined,
  );
  const loaderResult =
    (!selectedRealm || state !== 'unavailable') &&
    requestMatches &&
    initialData?.admission.request.mode === mode &&
    (!selectedRealm || reader.initialAllowed(expectedReader))
      ? selectedRealm
        ? initialData.kind === 'ready'
          ? {
              ...initialData,
              admission: {
                ...initialData.admission,
                request: { ...initialData.admission.request, incarnation },
              },
            }
          : {
              ...initialData,
              admission: {
                request: { ...initialData.admission.request, incarnation },
              },
            }
        : initialData
      : undefined;
  const queryKey = options.queryKey;
  if (selectedRealm) reader.registerQuery('configured-list', queryKey);
  const query = useQuery({
    ...options,
    enabled:
      mode !== 'initial-hydration' &&
      (!selectedRealm || (reader.canRead && state !== 'unknown' && state !== 'unavailable')),
    ...(loaderResult ? { initialData: loaderResult, initialDataUpdatedAt: Date.now() } : {}),
  });

  async function retry() {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      if (selectedRealm) await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      else await query.refetch();
    } catch {
      // The unavailable state stays available for another deliberate retry.
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  const recovery = (unavailable: boolean) => (
    <div className="mx-auto max-w-5xl space-y-3" aria-busy={!unavailable}>
      <p role="status">
        {unavailable ? m.configured_list_recovery_unavailable() : m.configured_list_recovery_pending()}
      </p>
      {unavailable ? (
        <Button variant="outline" disabled={retrying} onClick={() => void retry()}>
          {m.configured_list_recovery_retry()}
        </Button>
      ) : null}
    </div>
  );

  if (selectedRealm && state === 'unavailable') return recovery(true);
  if (selectedRealm && (state === 'unknown' || !reader.current(incarnation))) return recovery(false);
  if (query.isError) return recovery(true);
  const result = query.data;
  if (!result) return recovery(false);
  if (result.kind !== 'ready') return recovery(true);
  const request = result.admission.request;
  const isCurrentResult =
    (!selectedRealm || state !== 'unavailable') &&
    request.locale === locale &&
    request.node === list &&
    request.page === page &&
    request.cursor === cursor &&
    request.state === state &&
    request.expectedReader === expectedReader &&
    request.incarnation === incarnation &&
    request.mode === mode &&
    request.realm === (selectedRealm ? target.realm : null) &&
    result.node === list &&
    JSON.stringify(result.target) === JSON.stringify(target) &&
    result.admission.context === (result.page.context?.id ?? null) &&
    (selectedRealm
      ? state === 'unknown'
        ? mode === 'initial-hydration' && !query.isFetchedAfterMount
        : result.admission.reader === expectedReader
      : result.admission.reader === null);
  if (!isCurrentResult) return recovery(true);
  return <TypeListPage page={result.page} target={result.target} node={result.node} locale={locale} />;
}

export function TypeListPage({
  page,
  target,
  node,
  locale,
}: {
  page: SubjectPageData;
  target: TypeListTarget;
  node: string;
  locale: string;
}) {
  const list = findTypeList(page.document, node);
  if (!list) return null;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageData
        locale={locale}
        subject={page.subject}
        document={page.document}
        reads={page.reads}
        context={page.context}
        continuation={page.continuation}
        {...(page.account ? { account: page.account } : {})}
        listTarget={target}
        fullList={node}
        messages={subjectPageMessages()}
      >
        <TypeList {...list.props} />
      </PageData>
    </div>
  );
}
