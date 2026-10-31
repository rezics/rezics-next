import { queryOptions, useQuery } from '@tanstack/react-query';
import type { SubjectLibrarySlotData } from '../../library/subject-slot';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import type { useSession } from '../../session/query';
import type { SubjectFrameData } from './subject-frame';
import { subjectLibraryQuery } from './subject-queries';

type ReaderSession = ReturnType<typeof useSession>;

const unavailable: SubjectLibrarySlotData = {
  session: 'unavailable',
  csrfToken: null,
  entryAvailable: false,
  entry: null,
  publicCollections: null,
  publicCollectionsNext: null,
  collectionsLoaded: false,
  collections: null,
  labels: null,
};
const signedOut: SubjectLibrarySlotData = { ...unavailable, session: 'signed-out' };

/** Reuse the bounded BFF query and its invalidation prefix, partitioning personal results by viewer and session. */
export function subjectLibraryLeafQuery(frame: SubjectFrameData, locale: string, session: ReaderSession) {
  const query = subjectLibraryQuery(frame.id, locale, false, undefined, undefined, frame.type);
  const ready = session.state === 'signed-in' && !!session.subject && !!session.csrfToken;
  return queryOptions({
    queryKey: [...query.queryKey, ready ? { viewer: session.subject, credential: session.csrfToken } : null] as const,
    queryFn: async (context) => {
      if (typeof query.queryFn !== 'function') return unavailable;
      const data = await query.queryFn({ ...context, queryKey: query.queryKey });
      context.signal.throwIfAborted();
      return data;
    },
    enabled: query.enabled && ready,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: (data: SubjectLibrarySlotData): SubjectLibrarySlotData =>
      ready &&
      data.session === 'signed-in' &&
      data.csrfToken === session.csrfToken &&
      (!data.entry || data.entry.subjectId === frame.id)
        ? data
        : unavailable,
  });
}

/** The host has already resolved and guarded this exact current reader frame, including any selected Realm. */
export function SubjectLibraryLeaf({
  frame,
  locale,
  session,
}: {
  frame: SubjectFrameData;
  locale: string;
  session: ReaderSession;
}) {
  const query = subjectLibraryLeafQuery(frame, locale, session);
  const { data, isError } = useQuery(query);
  // SSR and unprepared viewers reserve the control space without exposing cached personal values or a sign-in flash.
  const current =
    session.state === 'signed-out' ? signedOut : query.enabled && !isError ? (data ?? unavailable) : unavailable;
  return (
    <div className="min-h-9">
      <SubjectLibrarySlot
        key={JSON.stringify([frame.id, locale, query.queryKey])}
        subject={{ id: frame.id, type: frame.type, label: frame.title.text }}
        locale={locale}
        data={current}
      />
    </div>
  );
}
