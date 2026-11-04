import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { personalRead } from '../../kernel/query';
import { useLibraryWorkspaceAdmission } from '../../library/library-workspace-admission';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  useHistoryReadOrigin,
} from '../../library/history-current-origin';
import { OWN_MEDIA_ADMISSION_OPERATION, OWN_MEDIA_OPERATION, OWN_MEDIA_SOURCE } from './inventory';
import { readOwnMediaInventoryForViewer, type OwnMediaRead } from './actions';
import type { OwnMediaInventoryPage } from './wire';

const operations = [OWN_MEDIA_ADMISSION_OPERATION] as const;

export function ownMediaQuery(
  subject: string,
  cursor: string | null,
  locale: string,
  originKey: string,
  current: () => boolean,
) {
  return queryOptions({
    ...personalRead,
    queryKey: [
      'own-media-inventory',
      subject,
      OWN_MEDIA_OPERATION,
      'personal_library',
      cursor,
      locale,
      OWN_MEDIA_SOURCE,
      originKey,
    ],
    queryFn: async ({ signal }) => {
      assertHistoryCurrent(current, signal);
      try {
        const result = await readOwnMediaInventoryForViewer({ data: { cursor } });
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

function matches(read: OwnMediaRead, subject: string | null, cursor: string | null, locale: string): boolean {
  return (
    read.subject === subject &&
    read.cursor === cursor &&
    read.locale === locale &&
    (read.state === 'ready' ? read.source === OWN_MEDIA_SOURCE : read.source === null)
  );
}

function isOwnMediaRead(value: unknown): value is OwnMediaRead {
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

export function useOwnMediaCurrentOrigin(
  initial: OwnMediaRead,
  requestedCursor: string | null,
  invalidAddress = false,
) {
  const client = useQueryClient();
  const locale = getLocale();
  const cursor = requestedCursor;
  const address = useHistoryAddress('/library/media', cursor ?? undefined, locale);
  const originAddress = invalidAddress ? `${address.key}:invalid` : address.key;
  const origin = useHistoryCurrentOrigin(originAddress, operations, initial.subject);
  const admission = useLibraryWorkspaceAdmission(operations).value;
  const current = () => address.isCurrent() && origin.current(0);
  const options = ownMediaQuery(origin.subject ?? '', cursor, locale, origin.lifetime(0), current);
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
    return isOwnMediaRead(value) && matches(value, origin.subject, cursor, locale);
  });
  const isCurrent = () => current() && readIsCurrent();
  const data = query.data;
  const state = useMemo(() => {
    if (invalidAddress) return 'invalid-cursor' as const;
    if (query.isError) return 'unavailable' as const;
    if (!isCurrent()) {
      if (isOwnMediaRead(data) && data.cursor === cursor && data.locale === locale && data.state === 'signed-out')
        return 'signed-out' as const;
      if (
        isOwnMediaRead(data) &&
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
  const viewKey = JSON.stringify([
    origin.boundary.lifetime,
    origin.lifetime(0),
    cursor,
    locale,
    OWN_MEDIA_SOURCE,
    address.key,
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
    refresh: () => (current() && !invalidAddress ? query.refetch() : Promise.resolve(undefined)),
    updatePage: (update: (page: OwnMediaInventoryPage) => OwnMediaInventoryPage) => {
      if (!isCurrent() || !page) return;
      const updatedAt = client.getQueryState(options.queryKey)?.dataUpdatedAt;
      client.setQueryData<OwnMediaRead>(
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
