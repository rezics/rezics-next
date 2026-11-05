import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { sessionQuery } from '../session/query';

export type ReviewReaderExpectation = { subject: string; csrfFingerprint: string };
export type ReviewReaderProvenance = ReviewReaderExpectation;

type SessionRecord = { state?: unknown; subject?: unknown; csrfToken?: unknown };
type SessionSnapshot = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
  queryStatus: string;
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

type SessionSource = {
  client: QueryClient;
  read(): SessionSnapshot;
  revision(): number;
  subscribe(listener: () => void): () => void;
  visits: Set<ReviewEntryVisit>;
};

export type ReviewEntryTarget = {
  subjectId: string;
  subjectTitle: string;
  locale: string;
  returnTo?: string;
  session: string;
};
export type ReviewEntryVisit = {
  readonly id: number;
  readonly client: QueryClient;
  readonly source: SessionSource;
  readonly sourceRevision: number;
  readonly snapshot: SessionSnapshot;
  readonly target: ReviewEntryTarget;
  readonly ready: boolean;
  readonly connection: { owner: object | null; connected: boolean; sequence: number };
  readonly pending: { realms: ReviewEntryReadTicket | null; boards: ReviewEntryReadTicket | null };
  retired: boolean;
  readGeneration: number;
  navigationClaimed: boolean;
};

export type ReviewEntryReadTicket = {
  readonly visit: ReviewEntryVisit;
  readonly generation: number;
  readonly kind: 'realms' | 'boards';
  readonly controller: AbortController;
};

const sources = new WeakMap<QueryClient, SessionSource>();
const expectedReaders = new WeakMap<ReviewEntryVisit, Promise<ReviewReaderExpectation>>();
let nextVisitId = 0;

function sessionSnapshot(client: QueryClient): SessionSnapshot {
  const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const value = query?.state.data as SessionRecord | undefined;
  return {
    state: typeof value?.state === 'string' ? value.state : 'unknown',
    subject: typeof value?.subject === 'string' && value.subject.length ? value.subject : null,
    csrfToken: typeof value?.csrfToken === 'string' ? value.csrfToken : null,
    queryStatus: query?.state.status ?? 'pending',
    dataUpdateCount: query?.state.dataUpdateCount ?? 0,
    dataUpdatedAt: query?.state.dataUpdatedAt ?? 0,
  };
}

function sameSnapshot(left: SessionSnapshot, right: SessionSnapshot) {
  return (
    left.state === right.state &&
    left.subject === right.subject &&
    left.csrfToken === right.csrfToken &&
    left.queryStatus === right.queryStatus &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.dataUpdatedAt === right.dataUpdatedAt
  );
}

function observeSession(client: QueryClient): SessionSource {
  let revision = 0;
  let previous = sessionSnapshot(client);
  const listeners = new Set<() => void>();
  const visits = new Set<ReviewEntryVisit>();

  client.getQueryCache().subscribe((event) => {
    const queryKey = event.query.queryKey;
    if (
      queryKey.length !== sessionQuery.queryKey.length ||
      queryKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
    )
      return;

    const successfulReplacement = event.type === 'updated' && event.action.type === 'success';
    const failedRead = event.type === 'updated' && event.action.type === 'error';
    const removed = event.type === 'removed';
    const next = sessionSnapshot(client);
    if (!successfulReplacement && !failedRead && !removed && sameSnapshot(previous, next)) return;

    revision++;
    previous = next;
    for (const visit of visits) retireReviewEntryVisit(visit);
    for (const listener of listeners) listener();
  });

  return {
    client,
    read: () => sessionSnapshot(client),
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visits,
  };
}

function sessionSource(client: QueryClient): SessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

function sameTarget(left: ReviewEntryTarget, right: ReviewEntryTarget) {
  return (
    left.subjectId === right.subjectId &&
    left.subjectTitle === right.subjectTitle &&
    left.locale === right.locale &&
    left.returnTo === right.returnTo &&
    left.session === right.session
  );
}

function readySession(session: string, snapshot: SessionSnapshot) {
  return (
    session === 'signed-in' &&
    snapshot.state === 'signed-in' &&
    snapshot.queryStatus === 'success' &&
    !!snapshot.subject
  );
}

function bindingIsCurrent(visit: ReviewEntryVisit) {
  return (
    !visit.retired &&
    visit.source.client === visit.client &&
    visit.source.revision() === visit.sourceRevision &&
    sameSnapshot(visit.snapshot, visit.source.read())
  );
}

export function reviewEntryVisitIsCurrent(visit: ReviewEntryVisit) {
  return bindingIsCurrent(visit) && visit.connection.connected;
}

export function retireReviewEntryVisit(visit: ReviewEntryVisit) {
  if (visit.retired) return;
  visit.retired = true;
  visit.connection.connected = false;
  if (visit.pending.realms) cancelReviewEntryRead(visit.pending.realms);
  if (visit.pending.boards) cancelReviewEntryRead(visit.pending.boards);
  visit.source.visits.delete(visit);
}

function createVisit(client: QueryClient, source: SessionSource, target: ReviewEntryTarget): ReviewEntryVisit {
  const snapshot = source.read();
  return {
    id: ++nextVisitId,
    client,
    source,
    sourceRevision: source.revision(),
    snapshot,
    target,
    ready: readySession(target.session, snapshot),
    connection: { owner: null, connected: false, sequence: 0 },
    pending: { realms: null, boards: null },
    retired: false,
    readGeneration: 0,
    navigationClaimed: false,
  };
}

function connectVisit(visit: ReviewEntryVisit, owner: object): () => void {
  if (visit.retired || !bindingIsCurrent(visit)) return () => {};
  if (visit.connection.owner && visit.connection.owner !== owner) retireReviewEntryVisit(visit);
  if (visit.retired) return () => {};

  visit.connection.owner = owner;
  visit.connection.connected = true;
  const connectionSequence = ++visit.connection.sequence;
  visit.source.visits.add(visit);
  return () => {
    if (visit.connection.owner !== owner || visit.connection.sequence !== connectionSequence) return;
    visit.connection.connected = false;
    const disconnectedSequence = ++visit.connection.sequence;
    // StrictMode reconnects synchronously; a true unmount stays disconnected through this microtask.
    queueMicrotask(() => {
      if (!visit.connection.connected && visit.connection.sequence === disconnectedSequence)
        retireReviewEntryVisit(visit);
    });
  };
}

/** Capture one browser QueryClient session observation and one subject-review destination. */
export function useWriteReviewVisit(target: ReviewEntryTarget): ReviewEntryVisit {
  const client = useQueryClient();
  const source = sessionSource(client);
  useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const owner = useRef<object | null>(null);
  owner.current ??= {};
  const last = useRef<ReviewEntryVisit | null>(null);
  const snapshot = source.read();
  let visit = last.current;
  if (
    !visit ||
    visit.retired ||
    visit.client !== client ||
    visit.source !== source ||
    visit.sourceRevision !== source.revision() ||
    !sameSnapshot(visit.snapshot, snapshot) ||
    !sameTarget(visit.target, target)
  ) {
    if (visit) retireReviewEntryVisit(visit);
    visit = createVisit(client, source, target);
    last.current = visit;
  }
  useLayoutEffect(() => connectVisit(visit!, owner.current!), [visit]);
  return visit;
}

export function beginReviewEntryRead(
  visit: ReviewEntryVisit,
  kind: ReviewEntryReadTicket['kind'],
): ReviewEntryReadTicket | null {
  if (!visit.ready || !reviewEntryVisitIsCurrent(visit) || visit.pending[kind]) return null;
  const ticket: ReviewEntryReadTicket = {
    visit,
    generation: ++visit.readGeneration,
    kind,
    controller: new AbortController(),
  };
  visit.pending[kind] = ticket;
  return ticket;
}

export function reviewEntryReadIsCurrent(ticket: ReviewEntryReadTicket) {
  return reviewEntryVisitIsCurrent(ticket.visit) && ticket.visit.pending[ticket.kind] === ticket;
}

export function finishReviewEntryRead(ticket: ReviewEntryReadTicket) {
  if (ticket.visit.pending[ticket.kind] === ticket) ticket.visit.pending[ticket.kind] = null;
}

export function cancelReviewEntryRead(ticket: ReviewEntryReadTicket) {
  ticket.controller.abort();
  finishReviewEntryRead(ticket);
}

export function claimReviewEntryNavigation(ticket: ReviewEntryReadTicket) {
  if (ticket.kind !== 'boards' || !reviewEntryReadIsCurrent(ticket) || ticket.visit.navigationClaimed) return false;
  ticket.visit.navigationClaimed = true;
  return true;
}

export async function fingerprintReviewCsrf(token: string | null): Promise<string> {
  const input = new TextEncoder().encode(token === null ? 'null\u0000' : `token\u0000${token}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function expectedReviewReader(visit: ReviewEntryVisit): Promise<ReviewReaderExpectation> {
  let pending = expectedReaders.get(visit);
  if (!pending) {
    const subject = visit.snapshot.subject;
    if (!subject) throw new Error('Review reader is unavailable');
    pending = fingerprintReviewCsrf(visit.snapshot.csrfToken).then((csrfFingerprint) => ({ subject, csrfFingerprint }));
    expectedReaders.set(visit, pending);
  }
  return pending;
}

export function isReviewReaderExpectation(value: unknown): value is ReviewReaderExpectation {
  return (
    !!value &&
    typeof value === 'object' &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0 &&
    value.subject.length <= 256 &&
    'csrfFingerprint' in value &&
    typeof value.csrfFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(value.csrfFingerprint)
  );
}

export function validateReviewReaderExpectation(value: unknown): ReviewReaderExpectation {
  if (!isReviewReaderExpectation(value)) throw new Error('Invalid review reader');
  return { subject: value.subject, csrfFingerprint: value.csrfFingerprint };
}

export function sameReviewReader(expected: ReviewReaderExpectation, actual: ReviewReaderProvenance | null) {
  return !!actual && expected.subject === actual.subject && expected.csrfFingerprint === actual.csrfFingerprint;
}

export async function preparedReviewReader(subject: string | undefined, csrfToken: string | null) {
  if (!subject) return null;
  return { subject, csrfFingerprint: await fingerprintReviewCsrf(csrfToken) };
}
