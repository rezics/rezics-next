import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ReadCredentialMode } from '../kernel/credential';
import { EditionCreateEntry } from '../content-editions/edition-create-entry';
import { ExactRevisionView } from './exact-revision-view';
import type { ExactRevisionIdentity, ExactRevisionState } from './exact-revision';

type SessionRecord = { state?: unknown; subject?: unknown; csrfToken?: unknown };
type SessionSnapshot = {
  revision: number;
  authorityRevision: number;
  tuple: string;
  state: string;
  subject: string | null;
  csrfReady: boolean;
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

type SessionSource = ReturnType<typeof observeSession>;
type ExactRevisionAdmission = {
  id: string;
  identity: ExactRevisionIdentity;
  locale: string;
  credentialMode: ReadCredentialMode;
  session: Omit<SessionSnapshot, 'tuple'>;
};

/** Loader data is serializable; the exact tuple and source stay attached to its source cache in memory. */
export type ExactRevisionVisit = { admission: ExactRevisionAdmission; page: ExactRevisionState };

function cacheSnapshot(client: QueryClient) {
  const query = client.getQueryCache().find({ queryKey: ['session'], exact: true });
  const record = query?.state.data as SessionRecord | undefined;
  const state = typeof record?.state === 'string' ? record.state : 'unknown';
  const subject = typeof record?.subject === 'string' && record.subject ? record.subject : null;
  const csrfToken = typeof record?.csrfToken === 'string' && record.csrfToken ? record.csrfToken : null;
  const dataUpdateCount = query?.state.dataUpdateCount ?? 0;
  const dataUpdatedAt = query?.state.dataUpdatedAt ?? 0;
  return {
    state,
    subject,
    csrfReady: csrfToken !== null,
    tuple: JSON.stringify([state, subject, csrfToken]),
    dataUpdateCount,
    dataUpdatedAt,
  };
}

let sourceSequence = 0;
function observeSession(client: QueryClient) {
  let revision = 0;
  let authorityRevision = 0;
  let previous = cacheSnapshot(client);
  let visits = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
    const before = previous;
    const after = cacheSnapshot(client);
    const success = event.type === 'updated' && event.action.type === 'success';
    const removed = event.type === 'removed';
    if (!success && !removed) return;
    revision++;
    if (before.state === 'signed-in' || after.state === 'signed-in') authorityRevision++;
    previous = after;
    for (const listener of listeners) listener();
  });
  return {
    id: ++sourceSequence,
    read: () => ({ ...cacheSnapshot(client), revision, authorityRevision }),
    revision: () => revision,
    nextVisit: () => ++visits,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const sources = new WeakMap<QueryClient, SessionSource>();
function sessionSource(client: QueryClient) {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

const visitSources = new WeakMap<ExactRevisionVisit, { source: SessionSource; capturedTuple: string }>();
const hydratedSources = new WeakMap<ExactRevisionVisit, { source: SessionSource; revision: number; tuple: string }>();
const retiredVisits = new WeakSet<ExactRevisionVisit>();

function privateSessionReady(snapshot: ReturnType<SessionSource['read']>) {
  return snapshot.state === 'signed-in' && snapshot.subject !== null && snapshot.csrfReady;
}

function anonymousCache(snapshot: ReturnType<SessionSource['read']>) {
  return snapshot.state !== 'signed-in';
}

function hydrationMatches(admission: ExactRevisionAdmission, snapshot: ReturnType<SessionSource['read']>) {
  const captured = admission.session;
  const exact =
    snapshot.state === captured.state &&
    snapshot.subject === captured.subject &&
    snapshot.csrfReady === captured.csrfReady &&
    snapshot.dataUpdateCount === captured.dataUpdateCount &&
    snapshot.dataUpdatedAt === captured.dataUpdatedAt;
  if (exact) return true;
  // SSR starts public routes before the browser's first signed-out session result exists.
  // That one prepared anonymous result has the same read authority as the original unknown state.
  return (
    admission.credentialMode === 'anonymous' &&
    captured.state === 'unknown' &&
    captured.subject === null &&
    !captured.csrfReady &&
    snapshot.state === 'signed-out' &&
    snapshot.subject === null &&
    !snapshot.csrfReady &&
    snapshot.dataUpdateCount === 1
  );
}

function sessionAdmissionCurrent(
  visit: ExactRevisionVisit,
  source: SessionSource,
  snapshot: ReturnType<SessionSource['read']>,
) {
  if (visit.admission.credentialMode === 'session' && !privateSessionReady(snapshot)) return false;
  if (visit.admission.credentialMode === 'anonymous' && !anonymousCache(snapshot)) return false;

  const local = visitSources.get(visit);
  if (local?.source === source) {
    if (visit.admission.credentialMode === 'session')
      return (
        snapshot.revision === visit.admission.session.revision &&
        snapshot.tuple === local.capturedTuple
      );
    return snapshot.authorityRevision === visit.admission.session.authorityRevision;
  }

  const hydrated = hydratedSources.get(visit);
  if (hydrated?.source === source) {
    if (visit.admission.credentialMode === 'session')
      return snapshot.revision === hydrated.revision && snapshot.tuple === hydrated.tuple;
    return snapshot.authorityRevision === hydrated.revision && anonymousCache(snapshot);
  }

  if (!hydrationMatches(visit.admission, snapshot)) return false;
  hydratedSources.set(visit, {
    source,
    revision: visit.admission.credentialMode === 'session' ? snapshot.revision : snapshot.authorityRevision,
    tuple: snapshot.tuple,
  });
  return true;
}

/** Capture the original route cache admission before beginning its one existing exact read. */
export async function readExactRevisionVisit(
  client: QueryClient,
  identity: ExactRevisionIdentity,
  locale: string,
  credentialMode: ReadCredentialMode,
  read: () => Promise<ExactRevisionState>,
): Promise<ExactRevisionVisit> {
  const source = sessionSource(client);
  const captured = source.read();
  const admission: ExactRevisionAdmission = {
    id: `${source.id}:${source.nextVisit()}`,
    identity: { ...identity },
    locale,
    credentialMode,
    session: {
      revision: captured.revision,
      authorityRevision: captured.authorityRevision,
      state: captured.state,
      subject: captured.subject,
      csrfReady: captured.csrfReady,
      dataUpdateCount: captured.dataUpdateCount,
      dataUpdatedAt: captured.dataUpdatedAt,
    },
  };
  let page = await read();
  const visit: ExactRevisionVisit = { admission, page };
  visitSources.set(visit, { source, capturedTuple: captured.tuple });
  if (!sessionAdmissionCurrent(visit, source, source.read())) {
    page = { state: 'loading' };
    const retired = { ...visit, page };
    visitSources.set(retired, { source, capturedTuple: captured.tuple });
    return retired;
  }
  return visit;
}

type Connection = { generation: number; connected: boolean; retired: boolean; owner: object | null };
const connections = new WeakMap<ExactRevisionVisit, Connection>();
function connectionFor(visit: ExactRevisionVisit) {
  let connection = connections.get(visit);
  if (!connection) {
    connection = { generation: 0, connected: false, retired: false, owner: null };
    connections.set(visit, connection);
  }
  return connection;
}

function connect(visit: ExactRevisionVisit, owner: object) {
  const connection = connectionFor(visit);
  if (connection.owner && connection.owner !== owner) connection.retired = true;
  if (retiredVisits.has(visit)) connection.retired = true;
  if (connection.retired) return 0;
  connection.owner = owner;
  connection.connected = true;
  return ++connection.generation;
}

function disconnect(visit: ExactRevisionVisit, generation: number) {
  const connection = connectionFor(visit);
  if (!generation || connection.generation !== generation) return;
  connection.connected = false;
  const disconnectedAt = ++connection.generation;
  // React StrictMode replays layout effects in the same turn and reconnects this visit.
  queueMicrotask(() => {
    if (connection.connected || connection.generation !== disconnectedAt) return;
    connection.retired = true;
    retiredVisits.add(visit);
  });
}

function ownsConnection(visit: ExactRevisionVisit, generation: number) {
  const connection = connectionFor(visit);
  return (
    generation !== 0 &&
    connection.connected &&
    !connection.retired &&
    !retiredVisits.has(visit) &&
    connection.generation === generation
  );
}

export function ExactRevisionCaller({
  visit,
  identity,
  locale,
  credentialMode,
  loading,
  onRetry,
}: {
  visit: ExactRevisionVisit;
  identity: ExactRevisionIdentity;
  locale: string;
  credentialMode: ReadCredentialMode;
  loading: boolean;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const source = sessionSource(queryClient);
  useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const owner = useRef<object | null>(null);
  owner.current ??= {};
  const active = useRef<{
    visit: ExactRevisionVisit;
    identity: ExactRevisionIdentity;
    locale: string;
    mode: string;
    loading: boolean;
  } | null>(null);
  const previous = active.current;
  if (
    previous &&
    (previous.visit !== visit ||
      previous.identity.postId !== identity.postId ||
      previous.identity.revisionId !== identity.revisionId ||
      previous.locale !== locale ||
      previous.mode !== credentialMode)
  ) {
    retiredVisits.add(previous.visit);
    const old = connectionFor(previous.visit);
    old.retired = true;
    old.connected = false;
    old.generation++;
  }
  active.current = { visit, identity, locale, mode: credentialMode, loading };

  const admissionMatches =
    visit.admission.identity.postId === identity.postId &&
    visit.admission.identity.revisionId === identity.revisionId &&
    visit.admission.locale === locale &&
    visit.admission.credentialMode === credentialMode &&
    sessionAdmissionCurrent(visit, source, source.read());
  const unavailable = { state: 'loading' } as const;
  const page = loading || retiredVisits.has(visit) || !admissionMatches ? unavailable : visit.page;
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    const current = connect(visit, owner.current!);
    setGeneration(current);
    return () => disconnect(visit, current);
  }, [visit]);

  const retry = () => {
    const current = active.current;
    if (
      current?.visit !== visit ||
      current.identity.postId !== identity.postId ||
      current.identity.revisionId !== identity.revisionId ||
      current.locale !== locale ||
      current.mode !== credentialMode ||
      current.loading ||
      !ownsConnection(visit, generation) ||
      !sessionAdmissionCurrent(visit, source, source.read())
    )
      return;
    retiredVisits.add(visit);
    onRetry();
  };
  const ready = page.state === 'ready' && admissionMatches && !retiredVisits.has(visit);
  return (
    <>
      <ExactRevisionView identity={identity} page={page} onRetry={retry} />
      {ready ? <EditionCreateEntry identity={identity} /> : null}
    </>
  );
}
