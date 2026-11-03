import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import { subjectSlotReturnTo } from '../../library/subject-slot-return-context';
import type { SubjectLibrarySlotData } from '../../library/subject-slot';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import { RichPrivateEntry } from '../../library/rich-private-entry/view';
import { useSubjectLibraryObservation } from '../../library/subject-library-current-origin';
import { ConfiguredProfileControls, isMangaLibrarySubject } from '../../library/configured-profile-controls';
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
export function subjectLibraryLeafQuery(
  frame: SubjectFrameData,
  locale: string,
  session: ReaderSession,
  mounted?: {
    lifetime: string;
    admitted: boolean;
    isCurrent: () => boolean;
  },
) {
  const query = subjectLibraryQuery(frame.id, locale, false, undefined, undefined, frame.type);
  const ready = session.state === 'signed-in' && !!session.subject && (!mounted || mounted.admitted);
  const currentData = (data: SubjectLibrarySlotData): SubjectLibrarySlotData =>
    ready &&
    data.session === 'signed-in' &&
    (!mounted || mounted.isCurrent()) &&
    ((!mounted && !data.provenance) ||
      (data.provenance?.viewer === session.subject &&
        data.provenance?.subjectId === frame.id &&
        !!data.provenance?.readId)) &&
    (!data.entry || data.entry.subjectId === frame.id) &&
    (!data.undo || data.undo.subjectId === frame.id) &&
    (!data.restore || !('entry' in data.restore) || !data.restore.entry || data.restore.entry.subjectId === frame.id)
      ? data
      : {
          ...unavailable,
          publicCollections: data.publicCollections,
          publicCollectionsNext: data.publicCollectionsNext,
        };
  return queryOptions({
    queryKey: [
      ...query.queryKey,
      ready
        ? {
            viewer: session.subject,
            credential: session.csrfToken,
            ...(mounted ? { lifetime: mounted.lifetime } : {}),
          }
        : null,
    ] as const,
    queryFn: async (context) => {
      if (!ready || (mounted && !mounted.isCurrent()) || typeof query.queryFn !== 'function') return unavailable;
      const data = await query.queryFn({ ...context, queryKey: query.queryKey });
      context.signal.throwIfAborted();
      return currentData(data);
    },
    enabled: query.enabled === true && ready,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: currentData,
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
  const entryAdmitted = useOperation('library_entry.get');
  const observation = useSubjectLibraryObservation({ id: frame.id, type: frame.type, label: frame.title.text }, locale);
  const admitted = entryAdmitted && observation.value.entryAdmitted;
  const currentHref = useLocation({ select: (location) => location.publicHref });
  const returnTo = subjectSlotReturnTo(currentHref, { id: frame.id, label: frame.title.text }, locale);
  const addressScope = JSON.stringify([
    frame.id,
    frame.type,
    locale,
    returnTo,
    session.state,
    session.subject,
    observation.owner,
    observation.value.scope,
  ]);
  const signature = JSON.stringify([
    addressScope,
    admitted,
    session.csrfToken,
    observation.value.entry,
    observation.value.labels,
    observation.value.collections,
  ]);
  const readScope = useRef({ signature, id: crypto.randomUUID(), active: true });
  if (readScope.current.signature !== signature) {
    readScope.current.active = false;
    readScope.current = { signature, id: crypto.randomUUID(), active: true };
  }
  const lifetime = readScope.current;
  const credential = useRef(session.csrfToken);
  credential.current = session.csrfToken;
  useEffect(() => {
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  const isCurrent = () => {
    const current = observation.read();
    return (
      lifetime.active &&
      observation.isMounted() &&
      current.sessionReady &&
      current.viewer === session.subject &&
      current.credential === session.csrfToken &&
      current.entryAdmitted &&
      credential.current === session.csrfToken &&
      current.scope === observation.value.scope &&
      current.entry === observation.value.entry &&
      current.labels === observation.value.labels &&
      current.collections === observation.value.collections
    );
  };
  const query = subjectLibraryLeafQuery(frame, locale, session, {
    lifetime: lifetime.id,
    admitted,
    isCurrent,
  });
  const { data, isError, isFetching, refetch } = useQuery(query);
  const accepted = useRef<{ lifetime: string; data: SubjectLibrarySlotData } | null>(null);
  if (data?.session === 'signed-in' && query.enabled && !isError) accepted.current = { lifetime: addressScope, data };
  const publicAddress = JSON.stringify([frame.id, locale]);
  const publicPage = useRef({
    address: publicAddress,
    collections: unavailable.publicCollections,
    next: unavailable.publicCollectionsNext,
  });
  if (publicPage.current.address !== publicAddress)
    publicPage.current = { address: publicAddress, collections: null, next: null };
  if (data?.publicCollections)
    publicPage.current = {
      address: publicAddress,
      collections: data.publicCollections,
      next: data.publicCollectionsNext,
    };
  // SSR and unprepared viewers reserve the control space without exposing cached personal values or a sign-in flash.
  const retained = accepted.current?.lifetime === addressScope ? accepted.current.data : unavailable;
  const privateData =
    session.state === 'signed-out'
      ? signedOut
      : !isError && observation.value.sessionReady
        ? query.enabled
          ? (data ?? retained)
          : retained
        : unavailable;
  const current = {
    ...privateData,
    publicCollections: publicPage.current.collections,
    publicCollectionsNext: publicPage.current.next,
  };
  return (
    <div className="min-h-9">
      <SubjectLibrarySlot
        subject={{ id: frame.id, type: frame.type, label: frame.title.text }}
        locale={locale}
        data={current}
      />
      <RichPrivateEntry
        key={frame.id + ':' + (session.state === 'signed-in' ? session.subject + ':' + (session.csrfToken ?? '') : session.state)}
        subject={{ id: frame.id, label: frame.title.text }}
        session={session}
        admitted={admitted && query.enabled === true}
        returnTo={returnTo}
      />
      {isMangaLibrarySubject(frame.type) ? (
        <ConfiguredProfileControls
          subject={{ id: frame.id, type: frame.type, label: frame.title.text }}
          locale={locale}
          session={session}
          returnTo={returnTo}
        />
      ) : null}
      {query.enabled &&
      (isError ||
        (data &&
          (data.session !== 'signed-in' ||
            !data.entryAvailable ||
            (data.labels === null && observation.value.labelsAdmitted)))) ? (
        <button
          type="button"
          className="text-sm text-primary underline-offset-4 hover:underline disabled:opacity-50"
          disabled={isFetching}
          onClick={() => {
            if (isCurrent()) void refetch();
          }}
        >
          {m.library_selection_retry()}
        </button>
      ) : null}
    </div>
  );
}
