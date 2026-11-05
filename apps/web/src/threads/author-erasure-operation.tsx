import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { QueryClientContext } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock3, LoaderCircle, ShieldAlert } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from './thread-href';
import { authorErasureRefreshes, erasureStage, type ErasureOperation, type ErasureRead } from './author-erasure';
import { erasureRefusal } from './author-erasure-entry';
import {
  authorErasureSessionIsAuthenticated,
  useAuthorErasureBrowserVisit,
  type AuthorErasureBrowserVisit,
  authorErasureSessionSource,
  type AuthorErasureSessionSource,
} from './author-erasure-lifetime';

function terminalError(code: number): string {
  if (code === 7 || code === 16) return m.author_erasure_terminal_permission();
  if (code === 9 || code === 10) return m.author_erasure_terminal_changed();
  if (code === 14 || code === 4 || code === 8) return m.author_erasure_terminal_dependency();
  return m.author_erasure_terminal_failed();
}

type RefreshBudget = ReturnType<typeof authorErasureRefreshes>;
type RefreshKind = 'automatic' | 'manual' | 'validation';

type OperationVisit = {
  readonly operationId: string;
  readonly navigationKey: string;
  readonly read: () => Promise<ErasureRead>;
  readonly source: AuthorErasureSessionSource;
  readonly browser: AuthorErasureBrowserVisit;
  readonly revision: number;
  readonly sessionBound: boolean;
  readonly budget: RefreshBudget;
  state: ErasureRead;
  pending: boolean;
  automatic: boolean;
  needsRead: boolean;
  retired: boolean;
  connected: boolean;
  connection: number;
  serial: number;
  version: number;
  listeners: Set<() => void>;
  publish: () => void;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  isCurrent: (serial?: number, connection?: number) => boolean;
  currentState: () => ErasureRead;
  connect: () => void;
  disconnect: () => void;
  retire: (notify?: boolean) => void;
  stopAutomatic: () => void;
  remaining: () => number;
  refresh: (kind: RefreshKind) => Promise<void>;
};

function operationFor(read: ErasureRead): ErasureOperation | null {
  return read.kind === 'available' ? read.operation : null;
}

function operationMatches(read: ErasureRead, operationId: string, subject?: string): boolean {
  const operation = operationFor(read);
  return (
    !operation ||
    (operation.name === `operations/${operationId}` &&
      (subject === undefined || operation.metadata.authorId === subject))
  );
}

function unavailableFor(session: ReturnType<AuthorErasureSessionSource['read']>): ErasureRead {
  return session?.state === 'signed-out' ? { kind: 'signed-out' } : { kind: 'unavailable' };
}

function createOperationVisit(input: {
  operationId: string;
  navigationKey: string;
  read: () => Promise<ErasureRead>;
  source: AuthorErasureSessionSource;
  browser: AuthorErasureBrowserVisit;
  revision: number;
  sessionBound: boolean;
  budget: RefreshBudget;
  state: ErasureRead;
  needsRead: boolean;
  automatic?: boolean;
}): OperationVisit {
  const visit: OperationVisit = {
    ...input,
    pending: false,
    automatic: input.automatic ?? true,
    retired: false,
    connected: false,
    connection: 0,
    serial: 0,
    version: 0,
    listeners: new Set(),
    publish() {
      visit.version += 1;
      for (const listener of visit.listeners) listener();
    },
    snapshot: () => visit.version,
    subscribe(listener) {
      visit.listeners.add(listener);
      return () => visit.listeners.delete(listener);
    },
    isCurrent(serial = visit.serial, connection = visit.connection) {
      if (
        visit.retired ||
        !visit.browser.current() ||
        !visit.connected ||
        serial !== visit.serial ||
        connection !== visit.connection ||
        (visit.sessionBound && visit.source.snapshot() !== visit.revision)
      )
        return false;
      if (!visit.sessionBound) return true;
      const session = visit.source.read();
      if (!authorErasureSessionIsAuthenticated(session)) return false;
      const operation = operationFor(visit.state);
      return !operation || operation.metadata.authorId === session.subject;
    },
    currentState() {
      if (visit.retired || !visit.browser.current()) return { kind: 'unavailable' };
      if (visit.sessionBound && visit.source.snapshot() !== visit.revision) return { kind: 'unavailable' };
      if (!visit.sessionBound) return visit.state;
      const session = visit.source.read();
      if (!authorErasureSessionIsAuthenticated(session)) return unavailableFor(session);
      return operationMatches(visit.state, visit.operationId, session.subject) ? visit.state : { kind: 'unavailable' };
    },
    connect() {
      if (visit.retired) return;
      visit.connected = true;
      visit.connection += 1;
    },
    disconnect() {
      visit.connected = false;
      visit.connection += 1;
      visit.serial += 1;
      const disconnectedAt = visit.connection;
      queueMicrotask(() => {
        if (!visit.connected && visit.connection === disconnectedAt) visit.retire();
      });
    },
    retire(notify = true) {
      if (visit.retired) return;
      visit.retired = true;
      visit.connected = false;
      visit.connection += 1;
      visit.serial += 1;
      visit.pending = false;
      visit.needsRead = false;
      if (notify) visit.publish();
    },
    stopAutomatic() {
      if (!visit.automatic) return;
      visit.automatic = false;
      visit.publish();
    },
    remaining: () => visit.budget.remaining(),
    async refresh(kind) {
      if (!visit.isCurrent() || visit.pending) return;
      const currentOperation = operationFor(visit.state);
      if (kind === 'automatic') {
        if (
          !visit.automatic ||
          visit.remaining() === 0 ||
          !currentOperation ||
          currentOperation.done ||
          typeof document === 'undefined' ||
          document.visibilityState !== 'visible'
        )
          return;
      }
      if (kind === 'validation') visit.needsRead = false;
      const serial = ++visit.serial;
      const connection = visit.connection;
      visit.pending = true;
      visit.publish();
      let next: ErasureRead | null;
      try {
        if (kind === 'automatic') next = await visit.budget.foreground(document.visibilityState === 'visible');
        else next = await visit.read();
      } catch {
        next = { kind: 'unavailable' };
      }
      if (!visit.isCurrent(serial, connection)) return;
      visit.pending = false;
      if (next) {
        const session = visit.sessionBound ? visit.source.read() : undefined;
        visit.state = operationMatches(next, visit.operationId, session?.subject ?? undefined)
          ? next
          : { kind: 'unavailable' };
        if (visit.state.kind !== 'available' || visit.state.operation.done) visit.automatic = false;
      }
      visit.publish();
    },
  };
  return visit;
}

function initialState(
  initial: ErasureRead,
  operationId: string,
  source: AuthorErasureSessionSource,
  sessionBound: boolean,
): { state: ErasureRead; needsRead: boolean } {
  if (!sessionBound) {
    return operationMatches(initial, operationId)
      ? { state: initial, needsRead: false }
      : { state: { kind: 'unavailable' }, needsRead: false };
  }
  const session = source.read();
  if (!authorErasureSessionIsAuthenticated(session)) return { state: unavailableFor(session), needsRead: true };
  if (!operationMatches(initial, operationId, session.subject))
    return { state: { kind: 'unavailable' }, needsRead: true };
  return { state: initial, needsRead: false };
}

/** The authenticated route supplies a loader read; the mounted caller owns later progress reads. */
export function AuthorErasureOperationPage({
  initial,
  read,
  operationId: suppliedOperationId,
  navigationKey = '',
}: {
  initial: ErasureRead;
  read: () => Promise<ErasureRead>;
  operationId?: string;
  navigationKey?: string;
}) {
  const client = useContext(QueryClientContext);
  const source = authorErasureSessionSource(client);
  const revision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const derivedOperationId =
    suppliedOperationId ?? (initial.kind === 'available' ? initial.operation.name.slice('operations/'.length) : '');
  const routeScope = JSON.stringify([derivedOperationId, navigationKey]);
  const browser = useAuthorErasureBrowserVisit(routeScope);
  const budget = useRef<{ scope: string; value: RefreshBudget } | null>(null);
  const reader = useRef(read);
  reader.current = read;
  if (!budget.current || budget.current.scope !== routeScope) {
    budget.current = {
      scope: routeScope,
      value: authorErasureRefreshes(() => reader.current()),
    };
  }
  const sessionBound = client !== undefined;
  const visitRef = useRef<OperationVisit | null>(null);
  const previousProps = useRef<{
    operationId: string;
    navigationKey: string;
    initial: ErasureRead;
    read: () => Promise<ErasureRead>;
    source: AuthorErasureSessionSource;
    revision: number;
  } | null>(null);
  const prior = visitRef.current;
  const previous = previousProps.current;
  if (!prior) {
    const prepared = initialState(initial, derivedOperationId, source, sessionBound);
    visitRef.current = createOperationVisit({
      operationId: derivedOperationId,
      navigationKey,
      read,
      source,
      browser,
      revision,
      sessionBound,
      budget: budget.current.value,
      ...prepared,
    });
  } else if (previous) {
    const routeChanged = previous.operationId !== derivedOperationId || previous.navigationKey !== navigationKey;
    const sourceChanged = previous.source !== source;
    const sessionChanged = previous.revision !== revision;
    const callerChanged = previous.initial !== initial || previous.read !== read || sourceChanged;
    if (routeChanged || callerChanged || sessionChanged) {
      const oldState = prior.state;
      const oldOperation = operationFor(oldState);
      const needsCurrentRead = !!derivedOperationId && (routeChanged || callerChanged || sessionChanged);
      const currentSession = source.read();
      const ready = !sessionBound || authorErasureSessionIsAuthenticated(currentSession);
      prior.retire(false);
      const state = ready ? { kind: 'unavailable' as const } : unavailableFor(currentSession);
      visitRef.current = createOperationVisit({
        operationId: derivedOperationId,
        navigationKey,
        read,
        source,
        browser,
        revision,
        sessionBound,
        budget: budget.current.value,
        state,
        needsRead: needsCurrentRead && ready,
        automatic: prior.automatic && (!oldOperation || !oldOperation.done),
      });
    }
  }
  previousProps.current = { operationId: derivedOperationId, navigationKey, initial, read, source, revision };
  const visit = visitRef.current!;
  const subscribe = useCallback(
    (notify: () => void) => {
      const offVisit = visit.subscribe(notify);
      const offSession = source.subscribe(notify);
      return () => {
        offVisit();
        offSession();
      };
    },
    [source, visit],
  );
  const snapshot = useCallback(() => JSON.stringify([source.snapshot(), visit.snapshot()]), [source, visit]);
  useSyncExternalStore(subscribe, snapshot, () => '[0,0]');

  useLayoutEffect(() => {
    visit.connect();
    return () => visit.disconnect();
  }, [visit]);
  useEffect(() => {
    if (visit.needsRead) void visit.refresh('validation');
  }, [visit]);

  const state = visit.currentState();
  const available = state.kind === 'available';
  const operation = available ? state.operation : null;
  const stage = operation ? erasureStage(operation) : null;
  const remaining = visit.remaining();
  const automatic = visit.automatic;
  const pending = visit.pending;

  useEffect(() => {
    if (!operation || operation.done || !automatic || remaining === 0 || pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = setTimeout(() => void visit.refresh('automatic'), 2000);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [visit, operation, automatic, remaining, pending]);

  const title =
    stage === 'completed'
      ? m.author_erasure_completed()
      : stage === 'failed'
        ? m.author_erasure_failed()
        : stage === 'running'
          ? m.author_erasure_running()
          : stage === 'queued'
            ? m.author_erasure_queued()
            : m.author_erasure_status_unavailable();
  const Icon =
    stage === 'completed'
      ? CheckCircle2
      : stage === 'failed' || !operation
        ? ShieldAlert
        : stage === 'running'
          ? LoaderCircle
          : Clock3;
  const counters = operation?.done && operation.response ? operation.response : operation?.metadata;
  const manual = !automatic || remaining === 0 || !operation;
  const canManuallyRead = browser.current() && (!sessionBound || authorErasureSessionIsAuthenticated(source.read()));
  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6" data-slot="author-erasure-operation">
      <header className="space-y-2">
        <p className="break-words text-sm font-medium text-muted-foreground">{m.author_erasure_operation_label()}</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{m.author_erasure_operation_title()}</h1>
        <p className="max-w-prose break-words text-muted-foreground">{m.author_erasure_scope()}</p>
      </header>
      <section className="min-w-0" aria-labelledby="erasure-status">
        <ContentItemFrame as="div" data-slot="content-item-frame" className="min-w-0 space-y-5 p-5 sm:p-7">
          <div className="flex min-w-0 items-center gap-3" role="status" aria-live="polite">
            <Icon aria-hidden="true" className="size-6 shrink-0 text-muted-foreground" />
            <ContentItemHeading id="erasure-status" level={2} className="min-w-0 break-words text-xl font-semibold">
              {title}
            </ContentItemHeading>
          </div>
          {!available ? (
            <p role="alert" className="max-w-prose break-words leading-relaxed">
              {erasureRefusal(state.kind)}
            </p>
          ) : null}
          {operation ? (
            <p className="max-w-prose break-words leading-relaxed text-muted-foreground">
              {operation.done
                ? operation.error
                  ? terminalError(operation.error.code)
                  : m.author_erasure_success()
                : stage === 'running'
                  ? m.author_erasure_running_copy()
                  : m.author_erasure_queued_copy()}
            </p>
          ) : null}
          {counters && operation ? (
            <dl className="grid min-w-0 grid-cols-1 gap-5 border-y border-border py-5 sm:grid-cols-3">
              {[
                [m.author_erasure_processed(), counters.processedPosts],
                [m.author_erasure_revisions(), counters.erasedRevisions],
                [m.author_erasure_steps(), operation.metadata.steps],
              ].map(([label, value]) => (
                <div key={label} className="space-y-1">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {counters && operation ? (
            <details className="min-w-0 text-sm leading-relaxed">
              <summary className="relative z-10 w-fit max-w-full cursor-pointer break-words rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.author_erasure_interface_count_details()}
              </summary>
              <p className="mt-2 max-w-prose break-words text-muted-foreground">
                {m.author_erasure_interface_count_details_copy()}
              </p>
            </details>
          ) : null}
          {operation && !operation.done ? (
            <p className="max-w-prose break-words text-sm leading-relaxed text-muted-foreground">
              {manual ? m.author_erasure_manual() : m.author_erasure_bounded_refresh()}
            </p>
          ) : null}
          {manual && !operation?.done ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal text-left"
              disabled={pending || !canManuallyRead}
              onClick={() => {
                visit.stopAutomatic();
                void visit.refresh('manual');
              }}
            >
              {pending ? m.author_erasure_checking() : m.author_erasure_check_again()}
            </Button>
          ) : null}
          {operation ? (
            <a
              className={buttonVariants({
                variant: 'ghost',
                className: 'h-auto min-h-11 max-w-full whitespace-normal text-left',
              })}
              href={threadLocation(getLocale(), { id: operation.metadata.threadId, title: null })}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              {m.author_erasure_back_thread()}
            </a>
          ) : null}
        </ContentItemFrame>
      </section>
      <p className="max-w-prose break-words text-sm leading-relaxed text-muted-foreground">
        {m.author_erasure_irreversible()}
      </p>
    </article>
  );
}
