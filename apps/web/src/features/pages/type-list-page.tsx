import { useContext, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnonymousSessionContext, sessionQuery, useSession } from '../../session/query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { isLocale } from '../../paraglide/runtime.js';
import { useListReaderAdmission, type ListReaderSession } from './list-reader-admission';
import { createConfiguredListRetryController } from './configured-list-retry';
import { configuredListRetryWaiting } from './configured-list-retry-admission';
import { useConfiguredListRetryFocus } from './configured-list-retry-focus';
import { hasSelectedRealmTarget, typeListTargetFromPage } from './type-list-model';
import { typeListQuery, type TypeListAdmissionInput, type TypeListQueryResult } from './type-list-query';
import type { TypeListTarget } from './type-list-model';
import { findTypeList } from './type-list-model';
import type { SubjectPageData } from './subject';
import { PageData } from './data';
import { TypeList } from './type-list';
import { subjectPageMessages } from './route-support';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { pageText } from './shared';

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

function healthySession(session: ListReaderSession) {
  return session.state !== 'unknown' && session.state !== 'unavailable';
}

function sameSession(left: ListReaderSession, right: ListReaderSession) {
  return (
    left.state === right.state &&
    (left.subject ?? null) === (right.subject ?? null) &&
    left.csrfToken === right.csrfToken
  );
}

function listMessageOptions(locale: string) {
  return { locale: isLocale(locale) ? locale : 'en' };
}

/** A route list observes the current session before admitting rows or continuation controls. */
export function ConfiguredList({ list, page, cursor, locale, initialData }: ConfiguredListProps) {
  const session = useSession();
  const anonymous = useContext(AnonymousSessionContext);
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const retryControllerRef = useRef<ReturnType<typeof createConfiguredListRetryController> | null>(null);
  if (!retryControllerRef.current) retryControllerRef.current = createConfiguredListRetryController();
  const retryController = retryControllerRef.current;
  const target = typeListTargetFromPage(page);
  const selectedRealm = hasSelectedRealmTarget(target);
  const sourceFingerprint = initialData
    ? JSON.stringify([initialData.kind, initialData.admission.request])
    : 'no-loader-data';
  const reader = useListReaderAdmission(queryClient, JSON.stringify([locale, list, page, cursor ?? null]), {
    sourceFingerprint,
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
  const queryIdentity = JSON.stringify(queryKey);
  const routeIdentity = JSON.stringify([locale, list, page, cursor ?? null, sourceFingerprint]);
  const sessionIdentity = healthySession(currentSession)
    ? JSON.stringify([currentSession.state, currentSession.subject ?? null, currentSession.csrfToken])
    : null;
  const focusReader = useRef<string | null>(null);
  if (sessionIdentity) focusReader.current = sessionIdentity;
  const retryOwner = selectedRealm
    ? {
        routeKey: routeIdentity,
        sessionKey: sessionIdentity,
        queryKey: queryIdentity,
        isCurrent: () => reader.current(incarnation),
        read: () => {
          if (!reader.current(incarnation)) return Promise.reject(new Error('Retired configured list'));
          return queryClient.fetchQuery({ ...options, staleTime: 0 });
        },
      }
    : null;

  useLayoutEffect(() => {
    retryController.attach();
    return () => retryController.detach();
  }, [retryController]);
  useLayoutEffect(() => retryController.select(retryOwner));

  if (selectedRealm) reader.registerQuery('configured-list', queryKey);
  const query = useQuery({
    ...options,
    enabled:
      mode !== 'initial-hydration' &&
      (!selectedRealm || (reader.canRead && state !== 'unknown' && state !== 'unavailable')) &&
      !retryController.shouldSuppressAutomaticRead(queryIdentity),
    ...(loaderResult ? { initialData: loaderResult, initialDataUpdatedAt: Date.now() } : {}),
  });
  const isCurrentRequest = (request: ReaderRequest | undefined) =>
    !!request &&
    request.locale === locale &&
    request.node === list &&
    request.page === page &&
    request.cursor === cursor &&
    request.state === state &&
    request.expectedReader === expectedReader &&
    request.incarnation === incarnation &&
    request.mode === mode &&
    request.realm === (selectedRealm ? target.realm : null) &&
    JSON.stringify(request.target) === JSON.stringify(target);
  const queryResult = query.data;
  const retryAt =
    queryResult?.kind === 'unavailable' && isCurrentRequest(queryResult.admission.request)
      ? queryResult.retryAt
      : undefined;
  const retryWaiting = useSearchRetryWait(retryAt);

  async function retry() {
    if (retryingRef.current || configuredListRetryWaiting(retryAt)) return;
    retryingRef.current = true;
    setRetrying(true);
    const attempt = selectedRealm ? retryController.begin() : null;
    try {
      if (selectedRealm) {
        if (!attempt) return;
        const beforeQuery = queryClient.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
        const before = beforeQuery?.state;
        const beforeSession = before?.data as ListReaderSession | undefined;
        if (
          !before ||
          before.status !== 'success' ||
          before.fetchStatus !== 'idle' ||
          !beforeSession ||
          !healthySession(beforeSession) ||
          !sameSession(beforeSession, currentSession)
        )
          return;

        const refreshed = (await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })) as ListReaderSession;
        const afterQuery = queryClient.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
        const after = afterQuery?.state;
        const afterSession = after?.data as ListReaderSession | undefined;
        if (
          !retryController.isCurrent(attempt) ||
          !after ||
          afterQuery !== beforeQuery ||
          after.status !== 'success' ||
          after.fetchStatus !== 'idle' ||
          after.dataUpdateCount !== before.dataUpdateCount + 1 ||
          after.errorUpdateCount !== before.errorUpdateCount ||
          !afterSession ||
          !healthySession(refreshed) ||
          !sameSession(refreshed, beforeSession) ||
          !sameSession(afterSession, beforeSession)
        )
          return;

        const currentOwner = await retryController.waitForCurrentOwner(attempt);
        if (!currentOwner || !retryController.markRead(attempt, currentOwner) || !currentOwner.isCurrent()) return;
        await currentOwner.read();
      } else await query.refetch();
    } catch {
      // The unavailable state stays available for another deliberate retry.
    } finally {
      if (attempt) retryController.finish(attempt);
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  const result = queryResult;
  const isCurrentResult =
    result?.kind === 'ready' &&
    isCurrentRequest(result.admission.request) &&
    (!selectedRealm || state !== 'unavailable') &&
    result.node === list &&
    JSON.stringify(result.target) === JSON.stringify(target) &&
    result.admission.context === (result.page.context?.id ?? null) &&
    (selectedRealm
      ? state === 'unknown'
        ? mode === 'initial-hydration' && !query.isFetchedAfterMount
        : result.admission.reader === expectedReader
      : result.admission.reader === null);
  const focusOutcome =
    selectedRealm && state === 'unavailable'
      ? 'unavailable'
      : selectedRealm && (state === 'unknown' || !reader.current(incarnation))
        ? 'pending'
        : query.isError
          ? 'unavailable'
          : !result
            ? 'pending'
            : isCurrentResult
              ? 'ready'
              : 'unavailable';
  const focus = useConfiguredListRetryFocus(
    {
      route: routeIdentity,
      reader: selectedRealm ? (focusReader.current ?? 'unknown') : 'public',
      queryClient,
      incarnation,
      isCurrent: () => !selectedRealm || reader.current(incarnation),
    },
    focusOutcome,
    retrying,
  );

  const messages = listMessageOptions(locale);
  const recovery = (unavailable: boolean) => (
    <div className="mx-auto max-w-5xl space-y-3" aria-busy={!unavailable}>
      <p ref={focus.statusRef} role="status" tabIndex={-1}>
        {unavailable
          ? m.configured_list_recovery_unavailable({}, messages)
          : m.configured_list_recovery_pending({}, messages)}
      </p>
      {unavailable ? (
        <Button
          ref={focus.retryRef}
          variant="outline"
          disabled={retrying || retryWaiting}
          onClick={(event) => {
            focus.noteActivation(event.currentTarget);
            void retry();
          }}
        >
          {m.configured_list_recovery_retry({}, messages)}
        </Button>
      ) : null}
    </div>
  );

  if (selectedRealm && state === 'unavailable') return recovery(true);
  if (selectedRealm && (state === 'unknown' || !reader.current(incarnation))) return recovery(false);
  if (query.isError) return recovery(true);
  if (!result) return recovery(false);
  if (result.kind !== 'ready' || !isCurrentResult) return recovery(true);
  return (
    <TypeListPage
      page={result.page}
      target={result.target}
      node={result.node}
      {...(cursor !== undefined ? { cursor } : {})}
      locale={locale}
      focusRef={focus.resultRef}
    />
  );
}

export function TypeListPage({
  page,
  target,
  node,
  cursor,
  locale,
  focusRef,
}: {
  page: SubjectPageData;
  target: TypeListTarget;
  node: string;
  cursor?: string;
  locale: string;
  focusRef: Ref<HTMLElement>;
}) {
  const list = findTypeList(page.document, node);
  if (!list) return null;
  return (
    <div
      ref={focusRef}
      role="region"
      aria-label={
        pageText(list.props.title, locale).text || m.configured_list_recovery_pending({}, listMessageOptions(locale))
      }
      tabIndex={-1}
      className="mx-auto max-w-5xl space-y-6"
    >
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
        {...(cursor !== undefined ? { listCursor: cursor } : {})}
        messages={subjectPageMessages(listMessageOptions(locale).locale)}
      >
        <TypeList {...list.props} />
      </PageData>
    </div>
  );
}
