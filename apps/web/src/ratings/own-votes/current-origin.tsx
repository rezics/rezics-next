import { useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { useLibraryWorkspaceAdmission } from '../../library/library-workspace-admission';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  useHistoryReadOrigin,
} from '../../library/history-current-origin';
import { personalRead } from '../../kernel/query';
import { readOwnVotesForViewer, type OwnVotesRead } from './actions';
import type { OwnVotesPage } from './types';
import { OWN_VOTES_OPERATION, OWN_VOTES_SOURCE } from './inventory';

const operations = [OWN_VOTES_OPERATION] as const;

export function ownVotesQuery(
  subject: string,
  cursor: string | null,
  locale: string,
  originKey: string,
  current: () => boolean,
) {
  return queryOptions({
    ...personalRead,
    queryKey: [
      'own-votes',
      subject,
      OWN_VOTES_OPERATION,
      'personal_library',
      cursor,
      locale,
      OWN_VOTES_SOURCE,
      originKey,
    ],
    queryFn: async ({ signal }) => {
      assertHistoryCurrent(current, signal);
      try {
        const result = await readOwnVotesForViewer({ data: cursor === null ? {} : { cursor } });
        assertHistoryCurrent(current, signal);
        return result;
      } catch (error) {
        assertHistoryCurrent(current, signal);
        throw error;
      }
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
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
) {
  const client = useQueryClient();
  const locale = getLocale();
  const cursor = requestedCursor;
  const address = useHistoryAddress('/library/ratings', cursor ?? undefined, locale);
  const originAddress = invalidAddress ? `${address.key}:invalid` : address.key;
  const origin = useHistoryCurrentOrigin(originAddress, operations, initial.subject);
  const admission = useLibraryWorkspaceAdmission(operations).value;
  const current = () => address.isCurrent() && origin.current(0);
  const options = ownVotesQuery(origin.subject ?? '', cursor, locale, origin.lifetime(0), current);
  const query = useQuery(
    {
      ...options,
      enabled:
        personalRead.enabled &&
        !invalidAddress &&
        origin.hydrated &&
        !!origin.subject &&
        origin.allowed[0] === true &&
        address.isCurrent(),
      ...(origin.seed && !invalidAddress && origin.subject && matches(initial, origin.subject, cursor, locale)
        ? { initialData: initial, initialDataUpdatedAt: Date.now() }
        : {}),
    },
    client,
  );
  const readIsCurrent = useHistoryReadOrigin(client, options.queryKey, (value) => {
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
  const viewKey = JSON.stringify([
    origin.boundary.lifetime,
    origin.lifetime(0),
    cursor,
    locale,
    OWN_VOTES_SOURCE,
    dataUpdatedAt,
  ]);

  return {
    state,
    page,
    read: data,
    subject: origin.subject,
    cursor,
    locale,
    viewKey,
    isCurrent,
    refresh: () => (isCurrent() ? query.refetch() : Promise.resolve(undefined)),
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
    },
  };
}
