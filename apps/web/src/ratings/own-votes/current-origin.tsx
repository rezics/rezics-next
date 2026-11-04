import { useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { useWorkspaceAdmission } from '../../reader/workspace-admission';
import {
  assertReaderCurrent,
  useReaderAddress,
  useReaderCurrentOrigin,
  useReaderResponseOrigin,
} from '../../reader/current-origin';
import { personalRead } from '../../kernel/query';
import { readOwnVotesForViewer, type OwnVotesRead } from './actions';
import type { OwnVotesPage } from './types';
import { OWN_VOTES_OPERATION, OWN_VOTES_SOURCE, OWN_VOTES_CONTEXT } from './inventory';
import type { OwnVotesReturnOwner } from './return';

const operations = [OWN_VOTES_OPERATION] as const;

export function ownVotesQuery(
  subject: string,
  cursor: string | null,
  locale: string,
  originKey: string,
  current: () => boolean,
  tracker?: { start: () => number; complete: (id: number, value: OwnVotesRead) => void },
) {
  return queryOptions({
    ...personalRead,
    queryKey: [
      'own-votes',
      subject,
      OWN_VOTES_OPERATION,
      OWN_VOTES_CONTEXT,
      cursor,
      locale,
      OWN_VOTES_SOURCE,
      originKey,
    ],
    queryFn: async ({ signal }) => {
      const requestId = tracker?.start();
      assertReaderCurrent(current, signal);
      try {
        const result = await readOwnVotesForViewer({ data: cursor === null ? {} : { cursor } });
        assertReaderCurrent(current, signal);
        if (requestId !== undefined) tracker?.complete(requestId, result);
        return result;
      } catch (error) {
        assertReaderCurrent(current, signal);
        throw error;
      }
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    // Equal native responses still start a new private reading visit.
    structuralSharing: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function matches(read: OwnVotesRead, subject: string | null, cursor: string | null, locale: string): boolean {
  return (
    read.subject === subject &&
    read.cursor === cursor &&
    read.locale === locale &&
    (read.state === 'ready' ? read.source === OWN_VOTES_SOURCE : read.source === null)
  );
}

/** The loader result is a candidate. Session, exposure, locale, address and native source admit it again. */
function isOwnVotesRead(value: unknown): value is OwnVotesRead {
  if (!value || typeof value !== 'object' || !('state' in value)) return false;
  const state = value.state;
  return (
    state === 'ready' ||
    state === 'signed-out' ||
    state === 'denied' ||
    state === 'preparing' ||
    state === 'unavailable' ||
    state === 'invalid-cursor'
  );
}

export function useOwnVotesCurrentOrigin(
  initial: OwnVotesRead,
  requestedCursor: string | null,
  invalidAddress = false,
  suspendInitial = false,
  responseVersion = 0,
) {
  const client = useQueryClient();
  const locale = getLocale();
  const cursor = requestedCursor;
  const address = useReaderAddress('/library/ratings', cursor ?? undefined, locale);
  const originAddress = invalidAddress ? `${address.key}:invalid` : address.key;
  const origin = useReaderCurrentOrigin(originAddress, operations, initial.subject);
  const { store, value: admission } = useWorkspaceAdmission(operations);
  const reading = origin.readLease(0);
  const current = () => address.isCurrent() && reading.current();
  const responseReads = useRef<{ started: number; completed: number; data: OwnVotesRead | undefined }>({
    started: 0,
    completed: 0,
    data: undefined,
  });
  const tracker = useMemo(
    () => ({
      start: () => ++responseReads.current.started,
      complete: (id: number, value: OwnVotesRead) => {
        responseReads.current.completed = id;
        responseReads.current.data = value;
      },
    }),
    [],
  );
  const options = ownVotesQuery(origin.subject ?? '', cursor, locale, origin.readKey(0), current, tracker);
  const query = useQuery(
    {
      ...options,
      enabled:
        personalRead.enabled &&
        !invalidAddress &&
        !suspendInitial &&
        origin.hydrated &&
        !!origin.subject &&
        origin.allowed[0] === true &&
        address.isCurrent(),
      ...(origin.seed && !invalidAddress && !suspendInitial && origin.subject && matches(initial, origin.subject, cursor, locale)
        ? { initialData: initial, initialDataUpdatedAt: Date.now() }
        : {}),
    },
    client,
  );
  const readIsCurrent = useReaderResponseOrigin(client, options.queryKey, (value) => {
    return isOwnVotesRead(value) && matches(value, origin.subject, cursor, locale);
  });
  const isCurrent = () => current() && readIsCurrent();
  const data = query.data;
  const state = useMemo(() => {
    if (invalidAddress) return 'invalid-cursor' as const;
    if (query.isError) return 'unavailable' as const;
    if (!isCurrent()) {
      if (isOwnVotesRead(data) && data.cursor === cursor && data.locale === locale && data.state === 'signed-out')
        return 'signed-out' as const;
      if (
        isOwnVotesRead(data) &&
        data.cursor === cursor &&
        data.locale === locale &&
        data.subject === origin.subject &&
        (data.state === 'denied' ||
          data.state === 'preparing' ||
          data.state === 'unavailable' ||
          data.state === 'invalid-cursor')
      )
        return data.state;
      if (origin.session.state === 'signed-out') return 'signed-out' as const;
      if (origin.session.state === 'unavailable') return 'unavailable' as const;
      if (admission.rejected || (origin.authoritative && origin.retained[0] && !admission.allowed[0]))
        return 'denied' as const;
      return 'preparing' as const;
    }
    return data?.state ?? 'preparing';
  }, [invalidAddress, query.isError, data, origin, admission, readIsCurrent]);
  const page = state === 'ready' && data?.state === 'ready' ? data.page : null;
  const dataUpdatedAt = client.getQueryState(options.queryKey)?.dataUpdatedAt ?? 0;
  const dataUpdateCount = client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
  const visit = useRef({ data, dataUpdatedAt, dataUpdateCount, generation: 0 });
  const consumedRouteResponse = useRef<number | null>(null);
  if (
    visit.current.data !== data ||
    visit.current.dataUpdatedAt !== dataUpdatedAt ||
    visit.current.dataUpdateCount !== dataUpdateCount
  )
    visit.current = { data, dataUpdatedAt, dataUpdateCount, generation: visit.current.generation + 1 };
  const viewKey = JSON.stringify([
    origin.boundary.lifetime,
    origin.lifetime(0),
    cursor,
    locale,
    OWN_VOTES_SOURCE,
    visit.current.generation,
  ]);
  const responseIdentity = () =>
    JSON.stringify([
      origin.boundary.id,
      origin.lifetime(0),
      cursor,
      locale,
      OWN_VOTES_SOURCE,
      client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0,
    ]);
  const captureReturnOwner = useCallback((previousResponseVersion = -1): OwnVotesReturnOwner => {
    const responseCount = client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
    const requestNumber = responseReads.current.started;
    const responseSubject = origin.subject;
    const departureAdmission = store.read();
    const admissionCurrent = () => {
      const currentAdmission = store.read();
      return !!responseSubject &&
        getLocale() === locale &&
        currentAdmission.subject === responseSubject &&
        currentAdmission.viewer === departureAdmission.viewer &&
        currentAdmission.dispatch[0] === departureAdmission.dispatch[0] &&
        currentAdmission.allowed[0] === true;
    };
    const canRead = () =>
      !invalidAddress && getLocale() === locale && address.isCurrent() && origin.current(0, false);
    return {
      visitKey: viewKey,
      responseVersion,
      subject: responseSubject,
      cursor,
      locale,
      source: OWN_VOTES_SOURCE,
      admissionCurrent,
      eligible: () => {
        if (!admissionCurrent()) return false;
        const state = client.getQueryState(options.queryKey);
        // Keep custody through its own exact refresh response, but retire it for any other replacement.
        if (!state || state.dataUpdateCount === responseCount) return true;
        const exactRefreshResponse =
          responseReads.current.started === requestNumber + 1 &&
          responseReads.current.completed === requestNumber + 1 &&
          responseReads.current.data === state.data &&
          state.dataUpdateCount === responseCount + 1 &&
          isOwnVotesRead(state.data) &&
          matches(state.data, responseSubject, cursor, locale);
        return exactRefreshResponse;
      },
      canRead,
      validateResult: (result) => {
        if (!canRead() || !result || typeof result !== 'object') return null;
        const candidate = result as { data?: unknown; isSuccess?: boolean; responseVersion?: number };
        const state = client.getQueryState(options.queryKey);
        const exactQueryRead =
          responseReads.current.started === requestNumber + 1 &&
          responseReads.current.completed === requestNumber + 1 &&
          responseReads.current.data === candidate.data;
        const exactRouteRead =
          candidate.responseVersion === responseVersion &&
          responseVersion > previousResponseVersion &&
          responseReads.current.started === requestNumber;
        console.log('read custody', {
          count: state?.dataUpdateCount,
          responseCount,
          started: responseReads.current.started,
          completed: responseReads.current.completed,
          requestNumber,
          exactQueryRead,
          exactRouteRead,
          sameData: state?.data === candidate.data,
          success: candidate.isSuccess,
          status: state?.status,
          matches: isOwnVotesRead(candidate.data) && matches(candidate.data, responseSubject, cursor, locale),
        });
        if (
          candidate.isSuccess !== true ||
          state?.status !== 'success' ||
          state.dataUpdateCount !== responseCount + 1 ||
          (!exactQueryRead && !exactRouteRead) ||
          state.data !== candidate.data ||
          !isOwnVotesRead(candidate.data) ||
          !matches(candidate.data, responseSubject, cursor, locale)
        )
          return null;
        return candidate.data;
      },
    };
  }, [client, options.queryKey, origin, invalidAddress, address, locale, cursor, viewKey, store, responseVersion]);

  const admitRouteResponse = useCallback(
    (read: OwnVotesRead, previousResponseVersion: number): Promise<unknown> | null => {
      if (
        responseVersion <= previousResponseVersion ||
        consumedRouteResponse.current === responseVersion
      )
        return null;
      consumedRouteResponse.current = responseVersion;
      if (
        current() &&
        isOwnVotesRead(read) &&
        matches(read, origin.subject, cursor, locale)
      )
        client.setQueryData(options.queryKey, read);
      return Promise.resolve({ isSuccess: true, data: read, responseVersion });
    },
    [responseVersion, current, origin.subject, cursor, locale, client, options.queryKey],
  );

  return {
    state,
    page,
    read: data,
    subject: origin.subject,
    cursor,
    locale,
    viewKey,
    responseIdentity,
    isCurrent,
    captureReturnOwner,
    admitRouteResponse,
    // A failed reader has no admitted data, but its account/address may still explicitly retry the same cursor.
    refresh: () => (current() && !invalidAddress ? query.refetch() : Promise.resolve(undefined)),
    updatePage: (update: (page: OwnVotesPage) => OwnVotesPage) => {
      if (!isCurrent() || !page) return;
      const updatedAt = client.getQueryState(options.queryKey)?.dataUpdatedAt;
      client.setQueryData<OwnVotesRead>(
        options.queryKey,
        (currentRead) =>
          currentRead?.state === 'ready' && currentRead.page === page
            ? { ...currentRead, page: update(currentRead.page) }
            : currentRead,
        updatedAt === undefined ? undefined : { updatedAt },
      );
      // A supported exact readback updates this visit; a replacement inventory starts another visit.
      visit.current.data = client.getQueryData<OwnVotesRead>(options.queryKey);
      visit.current.dataUpdatedAt = client.getQueryState(options.queryKey)?.dataUpdatedAt ?? 0;
      visit.current.dataUpdateCount = client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
    },
  };
}
