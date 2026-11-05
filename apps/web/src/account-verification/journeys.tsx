import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { browserObservation } from '../session/observation';
import { csrfHeaders } from '../threads/composer';
import { readReviewPage, readAccountVerificationPage, readAccountManagement, decideVerification } from './actions';
import { AccountManagementPageView, AccountVerificationPageView, ReviewPageView } from './pages';
import type { SubmitOperation } from './operation';
import type { ReadState, ReviewPage } from './transport';
import { verificationPageTimeout, withVerificationDeadline } from './deadline';
import { getLocale } from '../paraglide/runtime.js';

const submit: SubmitOperation = (data, signal) =>
  decideVerification({ data, ...(signal ? { signal } : {}), headers: csrfHeaders() });

export function ReviewJourney() {
  const { state, csrfToken, subject } = useSession();
  const viewerId = state === 'signed-in' ? (subject ?? null) : null;
  const client = useQueryClient();
  const observation = useMemo(() => browserObservation(client), [client]);
  const browser = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  const locale = getLocale();
  const readerId =
    browser.state === 'signed-in' && browser.observation.subject === viewerId ? browser.observation.id : null;
  const loading = state === 'unknown' || (!!viewerId && readerId === null);
  const ownerKey = JSON.stringify([state, viewerId, readerId, locale]);
  return (
    <ReviewerJourney
      key={ownerKey}
      viewerId={viewerId}
      readerId={readerId}
      locale={locale}
      loading={loading}
      canWrite={!!csrfToken && readerId !== null}
    />
  );
}

type ReviewCoordinate = string | undefined;
type ReviewDirection = 'next' | 'previous' | 'first';
type ReviewMovement = { direction: ReviewDirection; source: ReviewCoordinate };
type FocusHandoff = { id: number; origin: HTMLElement; canceled: boolean; onFocus: (event: FocusEvent) => void };

function ReviewerJourney({
  viewerId,
  readerId,
  locale,
  loading,
  canWrite,
}: {
  viewerId: string | null;
  readerId: number | null;
  locale: string;
  loading: boolean;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const observation = useMemo(() => browserObservation(queryClient), [queryClient]);
  const owner = useRef({ viewerId, readerId, locale });
  owner.current = { viewerId, readerId, locale };
  const isCurrentOwner = useCallback(() => {
    const current = observation.getSnapshot();
    return (
      owner.current.viewerId === viewerId &&
      owner.current.readerId === readerId &&
      owner.current.locale === locale &&
      getLocale() === locale &&
      readerId !== null &&
      current.state === 'signed-in' &&
      current.observation.subject === viewerId &&
      current.observation.id === readerId
    );
  }, [locale, observation, readerId, viewerId]);
  const [readId, setReadId] = useState(0);
  const queryKey = useMemo(
    () => ['account-verification', 'review', viewerId, readerId, locale, readId] as const,
    [locale, readId, readerId, viewerId],
  );
  const request = useRef<{ id: number; cursor: ReviewCoordinate } | null>(null);
  const requestId = useRef(0);
  const movementRef = useRef<ReviewMovement | null>(null);
  const [movement, setMovement] = useState<ReviewMovement | null>(null);
  const historyRef = useRef<ReviewCoordinate[]>([]);
  const [history, setHistory] = useState<ReviewCoordinate[]>([]);
  const [movementLoading, setMovementLoading] = useState(false);
  const [focusAfterRead, setFocusAfterRead] = useState<number | null>(null);
  const focusHandoff = useRef<FocusHandoff | null>(null);
  const active = useRef(true);
  const activeQueryKey = useRef(queryKey);
  const queueRegion = useRef<HTMLDivElement>(null);

  const clearFocusHandoff = useCallback((id?: number) => {
    const current = focusHandoff.current;
    if (!current || (id !== undefined && current.id !== id)) return;
    document.removeEventListener('focusin', current.onFocus, true);
    focusHandoff.current = null;
  }, []);
  const beginFocusHandoff = useCallback(
    (id: number, origin: HTMLElement) => {
      clearFocusHandoff();
      const handoff: FocusHandoff = {
        id,
        origin,
        canceled: false,
        onFocus: (event) => {
          if (event.target === origin) return;
          if ((event.target === document.body || event.target === document.documentElement) && !origin.isConnected)
            return;
          handoff.canceled = true;
        },
      };
      focusHandoff.current = handoff;
      document.addEventListener('focusin', handoff.onFocus, true);
    },
    [clearFocusHandoff],
  );
  const query = useQuery({
    ...personalRead,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryKey,
    enabled: personalRead.enabled && !!viewerId && readerId !== null,
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline(
        (signal) => {
          const cursor = request.current?.cursor;
          return readReviewPage({ data: cursor === undefined ? {} : { cursor }, signal });
        },
        caller,
        verificationPageTimeout,
      ),
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearFocusHandoff();
      queryClient.removeQueries({ queryKey: activeQueryKey.current, exact: true });
    };
  }, [clearFocusHandoff, queryClient]);

  useLayoutEffect(() => {
    const previousQueryKey = activeQueryKey.current;
    if (previousQueryKey !== queryKey) queryClient.removeQueries({ queryKey: previousQueryKey, exact: true });
    activeQueryKey.current = queryKey;
  }, [queryClient, queryKey]);

  useEffect(() => {
    const requested = request.current;
    if (
      !requested ||
      requested.id !== readId ||
      query.isPending ||
      query.isFetching ||
      !active.current ||
      !isCurrentOwner()
    )
      return;
    const admitted = query.isSuccess && query.data?.viewerId === viewerId && query.data.page.state === 'ready';
    if (!admitted) {
      setMovementLoading(false);
      clearFocusHandoff(requested.id);
      return;
    }

    const pendingMovement = movementRef.current;
    if (pendingMovement?.direction === 'next') {
      historyRef.current = [...historyRef.current, pendingMovement.source].slice(-8);
      setHistory(historyRef.current);
    } else if (pendingMovement?.direction === 'previous') {
      historyRef.current = historyRef.current.slice(0, -1);
      setHistory(historyRef.current);
    } else if (pendingMovement?.direction === 'first') {
      historyRef.current = [];
      setHistory([]);
    }
    movementRef.current = null;
    setMovement(null);
    setMovementLoading(false);
    if (focusHandoff.current?.id === requested.id && !focusHandoff.current.canceled) setFocusAfterRead(requested.id);
    else clearFocusHandoff(requested.id);
  }, [
    clearFocusHandoff,
    isCurrentOwner,
    query.data,
    query.isFetching,
    query.isPending,
    query.isSuccess,
    readId,
    viewerId,
  ]);

  const scheduleRead = useCallback(
    (cursor: ReviewCoordinate, direction?: ReviewDirection, origin?: HTMLElement | null) => {
      if (!isCurrentOwner()) return;
      const id = ++requestId.current;
      const requested = { id, cursor };
      const nextMovement = direction ? { direction, source: request.current?.cursor } : undefined;
      request.current = requested;
      if (nextMovement) {
        movementRef.current = nextMovement;
        setMovement(nextMovement);
        window.scrollTo(0, 0);
      }
      if (movementRef.current) setMovementLoading(true);
      if (origin) beginFocusHandoff(id, origin);
      else clearFocusHandoff();
      setFocusAfterRead(null);
      setReadId(id);
    },
    [beginFocusHandoff, clearFocusHandoff, isCurrentOwner],
  );
  useEffect(() => {
    if (focusAfterRead === null) return;
    const handoff = focusHandoff.current;
    if (
      !query.isFetching &&
      query.data?.viewerId === viewerId &&
      query.data.page.state === 'ready' &&
      handoff?.id === focusAfterRead
    ) {
      const shouldFocus = !handoff.canceled && isCurrentOwner();
      clearFocusHandoff(focusAfterRead);
      setFocusAfterRead(null);
      if (shouldFocus) queueRegion.current?.focus();
    }
  }, [clearFocusHandoff, focusAfterRead, isCurrentOwner, query.data, query.isFetching, viewerId]);

  const refresh = useCallback(() => scheduleRead(request.current?.cursor), [scheduleRead]);
  const retry = useCallback(
    (origin?: HTMLElement | null) => scheduleRead(request.current?.cursor, undefined, origin),
    [scheduleRead],
  );
  const next = useCallback(
    (cursor: string, origin?: HTMLElement | null) => scheduleRead(cursor, 'next', origin),
    [scheduleRead],
  );
  const previous = useCallback(
    (origin?: HTMLElement | null) => {
      if (!historyRef.current.length) return;
      scheduleRead(historyRef.current[historyRef.current.length - 1], 'previous', origin);
    },
    [scheduleRead],
  );
  const first = useCallback((origin?: HTMLElement | null) => scheduleRead(undefined, 'first', origin), [scheduleRead]);
  let page: ReadState<ReviewPage> | { state: 'loading' };
  if (loading) page = { state: 'loading' };
  else if (!viewerId || (query.data && query.data.viewerId !== viewerId)) page = { state: 'denied' };
  else if (movement && movementLoading) page = { state: 'loading' };
  else if (query.isFetching && query.data?.page.state !== 'ready') page = { state: 'loading' };
  else if (query.isError) page = { state: 'unavailable' };
  else page = query.data?.page ?? { state: 'loading' };

  return (
    <ReviewPageView
      page={page}
      viewerId={viewerId}
      operations={query.data?.viewerId === viewerId && readerId !== null ? (query.data?.operations ?? []) : []}
      submit={submit}
      canWrite={canWrite && !query.isFetching}
      refresh={refresh}
      retry={retry}
      next={next}
      previous={previous}
      canPrevious={history.length > 0}
      first={first}
      queueRegionRef={queueRegion}
    />
  );
}

export function AccountVerificationJourney({ accountId }: { accountId: string }) {
  const { state, csrfToken, subject } = useSession();
  const viewerId = state === 'signed-in' ? (subject ?? null) : null;
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'account', viewerId, accountId],
    enabled: personalRead.enabled && state === 'signed-in',
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline(
        (signal) => readAccountVerificationPage({ data: accountId, signal }),
        caller,
        verificationPageTimeout,
      ),
  });
  return (
    <AccountVerificationPageView
      key={viewerId}
      accountId={accountId}
      page={
        !viewerId || (query.data && query.data.viewerId !== viewerId)
          ? { state: 'denied' }
          : query.isError
            ? { state: 'unavailable' }
            : (query.data?.page ?? { state: 'loading' })
      }
      viewerId={viewerId}
      canWrite={!!csrfToken && !query.isFetching}
      submit={submit}
      refresh={() => {
        void query.refetch();
      }}
    />
  );
}

export function AccountManagementJourney() {
  const { state } = useSession();
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'management'],
    enabled: personalRead.enabled && state === 'signed-in',
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline((signal) => readAccountManagement({ signal }), caller, verificationPageTimeout),
  });
  return (
    <AccountManagementPageView
      page={query.isError ? { state: 'unavailable' } : (query.data ?? { state: 'loading' })}
      refresh={() => {
        void query.refetch();
      }}
    />
  );
}
