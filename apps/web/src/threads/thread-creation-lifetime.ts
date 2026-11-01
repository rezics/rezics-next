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

const sources = new WeakMap<QueryClient, ThreadCreationSessionSource>();
const emptySource: ThreadCreationSessionSource = {
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};

/** Observe only the route's existing session cache; successful replacements advance its visit revision. */
export function threadCreationSessionSource(client: QueryClient | undefined): ThreadCreationSessionSource {
  if (!client) return emptySource;
  const known = sources.get(client);
  if (known) return known;

  const read = () => client.getQueryData<ThreadCreationSession>(sessionQuery.queryKey);
  const identity = () => {
    const session = read();
    return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query, type, action }) => {
    if (
      query.queryKey.length !== sessionQuery.queryKey.length ||
      query.queryKey.some((key, index) => key !== sessionQuery.queryKey[index])
    )
      return;
    const next = identity();
    const replaced = type === 'added' || type === 'removed' || (type === 'updated' && action.type === 'success');
    if (next === previous && !replaced) return;
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

function ready(session: ThreadCreationSession | undefined): session is ThreadCreationSession & {
  state: 'signed-in';
  subject: string;
  csrfToken: string;
} {
  return (
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0
  );
}

function sessionIdentity(session: ThreadCreationSession | undefined) {
  return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null, ready(session)]);
}

type Binding = { client: QueryClient | undefined; source: ThreadCreationSessionSource; scope: string };

/** One mounted new-thread visit. Cache, scope and connection changes retire it permanently. */
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
  ) {
    this.sourceRevision = source.snapshot();
    const session = source.read();
    this.ownerSession = sessionIdentity(session);
    this.ownerLocale = getLocale();
    this.ownerScope = initialScope;
    this.csrfToken = ready(session) ? session.csrfToken : '';
    this.accountId = ready(session) ? session.subject : '';
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
      !ready(session) ||
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
    return !this.retired && this.connected && ticket === this.connection;
  }

  isBound(ticket = this.connection, notify = false) {
    this.check(notify);
    return !this.retired && ticket === this.connection;
  }

  isEditable(ticket = this.connection) {
    return this.isCurrent(ticket) && !this.intentLocked;
  }

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
  initialSubjectTitle?: string;
};

export function useThreadCreationLifetime(scope: ThreadCreationScope) {
  const client = useContext(QueryClientContext);
  const source = useMemo(() => threadCreationSessionSource(client), [client]);
  const locale = getLocale();
  const scopeKey = JSON.stringify([
    scope.boardId,
    scope.purpose,
    scope.initialKey,
    scope.initialSubject ?? null,
    scope.initialSubjectTitle ?? null,
    locale,
  ]);
  const bindingRef = useRef<Binding>({ client, source, scope: scopeKey });
  bindingRef.current = { client, source, scope: scopeKey };
  const [lifetime] = useState(
    () => new ThreadCreationLifetime(client, source, () => bindingRef.current, scopeKey),
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
