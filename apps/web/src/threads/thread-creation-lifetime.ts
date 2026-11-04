import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  createElement,
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import { subjectCommunityVisitReturn } from '../features/pages/subject-visit-navigation';
import type { AuthoringLocation } from './authoring-departure';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The route and its departure guard admit exactly the same preset. Titles are display hints. */
export function threadCreationPreset(
  search: Record<string, unknown>,
  locale: string = getLocale(),
): { subject?: string; subjectTitle?: string; returnTo?: string } {
  const subject = typeof search.subject === 'string' && uuid.test(search.subject) ? search.subject : undefined;
  const subjectTitle =
    subject && typeof search.subjectTitle === 'string' && search.subjectTitle.length <= 512
      ? search.subjectTitle
      : undefined;
  const returnTo = subjectCommunityVisitReturn(search.returnTo, locale);
  return {
    ...(subject ? { subject } : {}),
    ...(subjectTitle ? { subjectTitle } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

/** Include the preset intent while leaving unrelated queries and anchors alone. */
export function threadCreationNavigationContext({ pathname, search }: AuthoringLocation): string {
  return JSON.stringify([pathname, threadCreationPreset(search).subject ?? null]);
}

/** Only a committed board/preset transition starts a replacement editor. */
export function threadCreationEditorKey(boardId: string, presetSubject: string | undefined): string {
  return JSON.stringify([boardId, presetSubject ?? null]);
}

export type ThreadCreationSession = {
  state?: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type ThreadCreationSessionSource = {
  read: () => ThreadCreationSession | undefined;
  snapshot: () => number;
  serverSnapshot: () => 0;
  subscribe: (notify: () => void) => () => void;
};

export type ThreadCreationReaderObservation = {
  subject: string;
  dataUpdateCount: number;
  errorUpdateCount: number;
  dataUpdatedAt: number;
};

export type ThreadCreationReaderAdmission = {
  observation: ThreadCreationReaderObservation;
  actualSubject: string;
};

const sources = new WeakMap<QueryClient, ThreadCreationSessionSource>();
const emptySource: ThreadCreationSessionSource = {
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};

function sessionIdentity(session: ThreadCreationSession | undefined) {
  return JSON.stringify([
    session?.state ?? 'unknown',
    session?.subject ?? null,
    session?.csrfToken ?? null,
    readerReady(session),
    writerReady(session),
  ]);
}

/** Track real session observations while ignoring fetch and observer bookkeeping. */
export function threadCreationSessionSource(client: QueryClient | undefined): ThreadCreationSessionSource {
  if (!client) return emptySource;
  const known = sources.get(client);
  if (known) return known;

  const read = () => client.getQueryData<ThreadCreationSession>(sessionQuery.queryKey);
  const identity = () => sessionIdentity(read());
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (JSON.stringify(event.query.queryKey) !== JSON.stringify(sessionQuery.queryKey)) return;

    const next = identity();
    const removed = event.type === 'removed';
    const successfulReplacement = event.type === 'updated' && event.action.type === 'success';
    const failedObservation = event.type === 'updated' && event.action.type === 'error';
    if (!removed && !successfulReplacement && !failedObservation && next === previous) return;

    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  const source: ThreadCreationSessionSource = {
    read,
    snapshot: () => revision,
    serverSnapshot: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  sources.set(client, source);
  return source;
}

function readerReady(session: ThreadCreationSession | undefined): session is ThreadCreationSession & {
  state: 'signed-in';
  subject: string;
} {
  return session?.state === 'signed-in' && typeof session.subject === 'string' && session.subject.length > 0;
}

function writerReady(session: ThreadCreationSession | undefined): session is ThreadCreationSession & {
  state: 'signed-in';
  subject: string;
  csrfToken: string;
} {
  return readerReady(session) && typeof session.csrfToken === 'string' && session.csrfToken.length > 0;
}

/** Capture the exact successful session-query result that precedes the private board read. */
export function observeThreadCreationReader(client: QueryClient | undefined): ThreadCreationReaderObservation | null {
  if (!client) return null;
  threadCreationSessionSource(client);
  const query = client.getQueryState<ThreadCreationSession>(sessionQuery.queryKey);
  const session = query?.data;
  if (!query || query.status !== 'success' || !readerReady(session)) return null;
  return {
    subject: session.subject,
    dataUpdateCount: query.dataUpdateCount,
    errorUpdateCount: query.errorUpdateCount,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

export function threadCreationReaderObservationMatches(
  client: QueryClient | undefined,
  observation: ThreadCreationReaderObservation,
  actualSubject: string,
): boolean {
  if (!client || actualSubject !== observation.subject) return false;
  const query = client.getQueryState<ThreadCreationSession>(sessionQuery.queryKey);
  const session = query?.data;
  return Boolean(
    query &&
    query.status === 'success' &&
    query.dataUpdateCount === observation.dataUpdateCount &&
    query.errorUpdateCount === observation.errorUpdateCount &&
    query.dataUpdatedAt === observation.dataUpdatedAt &&
    readerReady(session) &&
    session.subject === observation.subject,
  );
}

type Binding = { client: QueryClient | undefined; source: ThreadCreationSessionSource; scope: string };

/** One mounted new-thread visit. A reader may be admitted without a current write token. */
export class ThreadCreationLifetime {
  private readonly sourceRevision: number;
  private readonly ownerSession: string;
  private readonly ownerLocale: string;
  private readonly ownerScope: string;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private connection = 0;
  private connected = false;
  private retired = false;
  private intentLocked = false;
  readonly csrfToken: string;
  readonly accountId: string;

  constructor(
    private readonly client: QueryClient | undefined,
    private readonly source: ThreadCreationSessionSource,
    private readonly binding: () => Binding,
    initialScope: string,
    private readonly admission: ThreadCreationReaderAdmission,
  ) {
    this.sourceRevision = source.snapshot();
    const session = source.read();
    this.ownerSession = sessionIdentity(session);
    this.ownerLocale = getLocale();
    this.ownerScope = initialScope;
    const admitted = threadCreationReaderObservationMatches(client, admission.observation, admission.actualSubject);
    this.csrfToken = admitted && writerReady(session) ? session.csrfToken : '';
    this.accountId = admitted && readerReady(session) ? session.subject : '';
    this.retired = !admitted;
  }

  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private retire(notify: boolean) {
    if (this.retired) return;
    this.retired = true;
    this.connected = false;
    this.connection++;
    this.intentLocked = true;
    if (notify) this.notify();
    else this.revision++;
  }

  private check(notify: boolean) {
    if (this.retired) return;
    const current = this.binding();
    const session = this.source.read();
    if (
      current.client !== this.client ||
      current.source !== this.source ||
      current.scope !== this.ownerScope ||
      this.source.snapshot() !== this.sourceRevision ||
      sessionIdentity(session) !== this.ownerSession ||
      !readerReady(session) ||
      !threadCreationReaderObservationMatches(this.client, this.admission.observation, this.admission.actualSubject) ||
      getLocale() !== this.ownerLocale
    )
      this.retire(notify);
  }

  /** Snapshot checks retire silently so React can observe the new snapshot during render. */
  snapshot = () => {
    this.check(false);
    return this.revision;
  };
  serverSnapshot = () => 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get connectionTicket() {
    return this.connection;
  }

  isCurrent(ticket = this.connection, notify = true) {
    this.check(notify);
    return !this.retired && this.connected && ticket === this.connection && writerReady(this.source.read());
  }

  isBound(ticket = this.connection, notify = false) {
    this.check(notify);
    return !this.retired && ticket === this.connection;
  }

  isEditable(ticket = this.connection) {
    return this.isCurrent(ticket) && !this.intentLocked;
  }

  /** A deliberate departure retires callbacks before the replacement route's reads can finish. */
  depart = () => this.retire(true);

  setIntentLocked(ticket: number, locked: boolean) {
    if (!this.isCurrent(ticket)) return false;
    if (this.intentLocked !== locked) {
      this.intentLocked = locked;
      this.notify();
    }
    return true;
  }

  connect() {
    if (this.retired) return () => {};
    this.connected = true;
    const ticket = ++this.connection;
    this.notify();
    return () => {
      if (!this.connected || ticket !== this.connection) return;
      this.connected = false;
      const disconnected = ++this.connection;
      this.notify();
      queueMicrotask(() => {
        if (!this.connected && this.connection === disconnected) this.retire(true);
      });
    };
  }
}

export type ThreadCreationScope = {
  boardId: string;
  purpose: string;
  initialKey: string;
  initialSubject?: string;
};

export function useThreadCreationLifetime(scope: ThreadCreationScope, admission: ThreadCreationReaderAdmission) {
  const client = useContext(QueryClientContext);
  const source = useMemo(() => threadCreationSessionSource(client), [client]);
  const locale = getLocale();
  const observation = admission.observation;
  const scopeKey = JSON.stringify([
    scope.boardId,
    scope.purpose,
    scope.initialKey,
    scope.initialSubject ?? null,
    observation.subject,
    observation.dataUpdateCount,
    observation.errorUpdateCount,
    observation.dataUpdatedAt,
    admission.actualSubject,
    locale,
  ]);
  const bindingRef = useRef<Binding>({ client, source, scope: scopeKey });
  bindingRef.current = { client, source, scope: scopeKey };
  const [lifetime] = useState(
    () => new ThreadCreationLifetime(client, source, () => bindingRef.current, scopeKey, admission),
  );

  const sessionRevision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.serverSnapshot);
  const ticket = lifetime.connectionTicket;
  const current = lifetime.isCurrent(ticket, false);
  const bound = lifetime.isBound(ticket, false);
  useLayoutEffect(() => lifetime.connect(), [lifetime]);

  return { lifetime, ticket, current, bound, scopeKey, sessionRevision };
}

const ThreadCreationContext = createContext<ThreadCreationLifetime | null>(null);

export function ThreadCreationLifetimeProvider({
  lifetime,
  children,
}: {
  lifetime: ThreadCreationLifetime;
  children: ReactNode;
}) {
  return createElement(ThreadCreationContext.Provider, { value: lifetime }, children);
}

export function useThreadCreationVisit() {
  const lifetime = useContext(ThreadCreationContext);
  useSyncExternalStore(
    lifetime?.subscribe ?? emptySource.subscribe,
    lifetime?.snapshot ?? emptySource.snapshot,
    lifetime?.serverSnapshot ?? emptySource.serverSnapshot,
  );
  const ticket = lifetime?.connectionTicket;
  return {
    isCurrent: () => (lifetime ? lifetime.isCurrent(ticket!) : true),
    isEditable: () => (lifetime ? lifetime.isEditable(ticket!) : true),
    ...(lifetime ? { lifetime, ticket: ticket! } : {}),
  };
}
