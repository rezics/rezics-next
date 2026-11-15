import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { readerSessionSource } from '../reader/lifetime';
import { useSession } from '../session/query';
import { knowledgeDiscoveryExactHref, type KnowledgeDiscoveryDocument } from './discovery';
import { readKnowledgeDiscoveryPage } from './discovery-read';
import {
  KnowledgeDiscoveryReading,
  parseKnowledgeDiscoveryReturn,
  type KnowledgeDiscoveryBinding,
  type KnowledgeDiscoverySnapshot,
} from './discovery-visit';

const ignoreSubscribe = () => () => {};
const idleSnapshot: KnowledgeDiscoverySnapshot = { state: 'preparing', cursor: null, busy: true };
const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-snug [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function localeOptions(locale: string) {
  return { locale: locale as never };
}

function publicationTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

export function KnowledgeDiscoveryReturnLink({ href, locale }: { href: string; locale: string }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pt-4 sm:px-6">
      <a href={href} className={linkClass}>
        {m.knowledge_discovery_return({}, localeOptions(locale))}
      </a>
    </div>
  );
}

function DiscoveryNotice({
  message,
  descriptionId,
  alert,
  action,
}: {
  message: string;
  descriptionId: string;
  alert?: boolean | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div role={alert ? 'alert' : 'status'} className="min-w-0 space-y-3 text-sm text-muted-foreground">
      <p id={descriptionId} className="min-w-0 break-words [overflow-wrap:anywhere]">
        {message}
      </p>
      {action}
    </div>
  );
}

function DiscoveryRow({
  locale,
  document,
  returnTo,
}: {
  locale: string;
  document: KnowledgeDiscoveryDocument;
  returnTo: string;
}) {
  const options = localeOptions(locale);
  return (
    <li className="min-w-0 space-y-2 border-t border-border pt-4">
      <a
        href={knowledgeDiscoveryExactHref(locale, document, returnTo)}
        className={`${linkClass} font-medium text-foreground`}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{document.title}</span>
      </a>
      <dl className="grid min-w-0 gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-medium text-foreground">{m.knowledge_published({}, options)}</dt>
          <dd>
            <time dateTime={document.publishedAt}>{publicationTime(document.publishedAt, locale)}</time>
          </dd>
        </div>
        {document.language ? (
          <div className="min-w-0">
            <dt className="font-medium text-foreground">{m.knowledge_language({}, options)}</dt>
            <dd>
              <bdi dir="ltr">{document.language}</bdi>
            </dd>
          </div>
        ) : null}
        <div className={`min-w-0 ${document.language ? 'sm:col-span-2' : ''}`}>
          <dt className="font-medium text-foreground">{m.knowledge_licence({}, options)}</dt>
          <dd className="[overflow-wrap:anywhere]">{document.licence}</dd>
        </div>
      </dl>
    </li>
  );
}

export type KnowledgeDiscoveryPanelProps = {
  locale: string;
  returnTo: string;
  snapshot: KnowledgeDiscoverySnapshot;
  onMore?: (() => void) | undefined;
  onContinue?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onRestart?: (() => void) | undefined;
};

/** Illustrative and live discovery share this region; native proof stays with Search. */
export function KnowledgeDiscoveryPanel({
  locale,
  returnTo,
  snapshot,
  onMore,
  onContinue,
  onRetry,
  onRestart,
}: KnowledgeDiscoveryPanelProps) {
  const options = localeOptions(locale);
  const headingId = useId();
  const introId = useId();
  const descriptionId = useId();
  const documents = snapshot.state === 'ready' ? (snapshot.page?.documents ?? []) : [];
  const next = snapshot.state === 'ready' ? (snapshot.page?.next ?? null) : null;
  const exhausted = snapshot.state === 'ready' && next === null;
  const sparse = snapshot.state === 'ready' && documents.length === 0 && next !== null;
  const empty = snapshot.state === 'ready' && documents.length === 0 && next === null;
  const preparingContinuation = snapshot.state === 'preparing' && !!snapshot.frontier;
  const initialPreparing = snapshot.state === 'preparing' && !snapshot.frontier;
  const replacing = initialPreparing && snapshot.cursor !== null;
  const boundaryRef = useRef<HTMLElement>(null);
  const keyboardActivation = useRef<{ kind: string; key: string; button: HTMLButtonElement } | null>(null);
  const orientationRequest = useRef<{ source: KnowledgeDiscoverySnapshot; expectedCursor: string | null } | null>(null);
  const removeOrientationListeners = useRef<(() => void) | null>(null);

  const cancelOrientation = useCallback(() => {
    orientationRequest.current = null;
    const remove = removeOrientationListeners.current;
    removeOrientationListeners.current = null;
    remove?.();
  }, []);

  function requestOrientation(expectedCursor: string | null) {
    cancelOrientation();
    orientationRequest.current = { source: snapshot, expectedCursor };

    const onFocusIn = (event: FocusEvent) => {
      if (event.target === document.body || event.target === document.documentElement) return;
      cancelOrientation();
    };
    const onPointerMovement = () => cancelOrientation();
    const onKeyMovement = () => cancelOrientation();
    const onDeparture = () => cancelOrientation();
    const onVisibility = () => {
      if (document.hidden) cancelOrientation();
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerMovement, true);
    document.addEventListener('pointermove', onPointerMovement, true);
    document.addEventListener('keydown', onKeyMovement, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onDeparture);
    window.addEventListener('pagehide', onDeparture);
    removeOrientationListeners.current = () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerMovement, true);
      document.removeEventListener('pointermove', onPointerMovement, true);
      document.removeEventListener('keydown', onKeyMovement, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onDeparture);
      window.removeEventListener('pagehide', onDeparture);
    };
  }

  function actionButton(
    kind: string,
    action: (() => void) | undefined,
    label: string,
    expectedCursor: string | null,
    describedBy?: string,
  ) {
    if (!action) return null;
    return (
      <Button
        type="button"
        variant="outline"
        className={controlClass}
        disabled={snapshot.busy}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
            keyboardActivation.current = { kind, key: event.key, button: event.currentTarget };
          } else {
            keyboardActivation.current = null;
            cancelOrientation();
          }
        }}
        onKeyUp={(event) => {
          const activation = keyboardActivation.current;
          if (activation?.button === event.currentTarget && activation.key === event.key) {
            window.setTimeout(() => {
              if (keyboardActivation.current === activation) keyboardActivation.current = null;
            }, 0);
          }
        }}
        onPointerDown={() => {
          keyboardActivation.current = null;
          cancelOrientation();
        }}
        onClick={(event) => {
          const activation = keyboardActivation.current;
          const keyboard =
            event.detail === 0 &&
            activation !== null &&
            activation.kind === kind &&
            activation.button === event.currentTarget;
          keyboardActivation.current = null;
          if (keyboard) requestOrientation(expectedCursor);
          else cancelOrientation();
          try {
            action();
          } catch (error) {
            cancelOrientation();
            throw error;
          }
        }}
      >
        {snapshot.busy ? m.knowledge_discovery_preparing({}, options) : label}
      </Button>
    );
  }

  useLayoutEffect(() => {
    return () => {
      keyboardActivation.current = null;
      cancelOrientation();
    };
  }, [cancelOrientation, locale, returnTo]);

  useLayoutEffect(() => {
    const request = orientationRequest.current;
    if (!request || snapshot === request.source) return;
    if (snapshot.state === 'retired' || snapshot.cursor !== request.expectedCursor) {
      cancelOrientation();
      return;
    }
    if (snapshot.busy) {
      if (snapshot.state !== 'preparing') cancelOrientation();
      return;
    }

    const currentBoundary =
      snapshot.state === 'ready' ||
      (snapshot.state === 'preparing' && !!snapshot.frontier) ||
      snapshot.state === 'denied' ||
      snapshot.state === 'unavailable' ||
      snapshot.state === 'restart';
    if (!currentBoundary) {
      cancelOrientation();
      return;
    }

    cancelOrientation();
    const boundary = boundaryRef.current;
    if (
      boundary?.isConnected &&
      boundary.getClientRects().length > 0 &&
      !boundary.closest('[hidden], [inert], [aria-hidden="true"]') &&
      window.getComputedStyle(boundary).visibility === 'visible'
    )
      boundary.focus();
  }, [cancelOrientation, snapshot]);

  const hasStateDescription =
    initialPreparing ||
    snapshot.state === 'denied' ||
    snapshot.state === 'unavailable' ||
    snapshot.state === 'restart' ||
    preparingContinuation ||
    empty ||
    sparse ||
    (exhausted && documents.length > 0);
  let presentationState: string;
  if (snapshot.state === 'preparing') {
    presentationState = snapshot.frontier
      ? 'preparing-frontier'
      : replacing
        ? 'replacing-results'
        : 'initial-preparation';
  } else if (snapshot.state === 'ready') {
    presentationState = sparse
      ? 'sparse-continuation'
      : empty
        ? 'empty-terminal'
        : exhausted
          ? 'nonempty-exhaustion'
          : 'results';
  } else {
    presentationState = snapshot.state;
  }

  return (
    <section
      ref={boundaryRef}
      data-slot="subject-knowledge"
      data-discovery-state={presentationState}
      tabIndex={-1}
      className="min-w-0 space-y-4 text-foreground selection:bg-primary/20 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      aria-labelledby={headingId}
      aria-describedby={hasStateDescription ? `${introId} ${descriptionId}` : introId}
      aria-busy={snapshot.busy || initialPreparing}
    >
      <header className="min-w-0 space-y-2">
        <h2 id={headingId} className="text-base font-semibold">
          {m.knowledge_discovery_heading({}, options)}
        </h2>
        <p id={introId} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.knowledge_discovery_intro({}, options)}
        </p>
      </header>
      {initialPreparing ? (
        <p id={descriptionId} role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_preparing({}, options)}
        </p>
      ) : null}
      {snapshot.state === 'denied' ? (
        <DiscoveryNotice
          message={m.knowledge_discovery_denied({}, options)}
          descriptionId={descriptionId}
          action={actionButton(
            'retry',
            onRetry,
            m.knowledge_discovery_retry({}, options),
            snapshot.cursor,
            descriptionId,
          )}
        />
      ) : null}
      {snapshot.state === 'unavailable' ? (
        <DiscoveryNotice
          message={m.knowledge_discovery_unavailable({}, options)}
          descriptionId={descriptionId}
          alert
          action={actionButton(
            'retry',
            onRetry,
            m.knowledge_discovery_retry({}, options),
            snapshot.cursor,
            descriptionId,
          )}
        />
      ) : null}
      {snapshot.state === 'restart' ? (
        <DiscoveryNotice
          message={m.knowledge_discovery_restart_needed({}, options)}
          descriptionId={descriptionId}
          alert
          action={actionButton(
            'restart',
            onRestart,
            m.knowledge_discovery_restart({}, options),
            null,
            descriptionId,
          )}
        />
      ) : null}
      {preparingContinuation ? (
        <DiscoveryNotice
          message={m.knowledge_discovery_preparing({}, options)}
          descriptionId={descriptionId}
          action={actionButton(
            'continue',
            onContinue,
            m.knowledge_discovery_continue({}, options),
            snapshot.frontier ?? null,
            descriptionId,
          )}
        />
      ) : null}
      {empty ? (
        <p id={descriptionId} role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_empty({}, options)}
        </p>
      ) : null}
      {sparse ? (
        <p id={descriptionId} role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_sparse({}, options)}
        </p>
      ) : null}
      {exhausted && documents.length > 0 ? (
        <p id={descriptionId} role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_end({}, options)}
        </p>
      ) : null}
      {next
        ? actionButton(
            'more',
            onMore,
            m.knowledge_discovery_more({}, options),
            next,
            sparse ? descriptionId : undefined,
          )
        : null}
      {documents.length > 0 ? (
        <ul className="min-w-0 space-y-1">
          {documents.map((document) => (
            <DiscoveryRow
              key={`${document.documentId}:${document.revisionId}:${document.publicationId}`}
              locale={locale}
              document={document}
              returnTo={returnTo}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export type KnowledgeDiscoverySlotProps = {
  subjectId: string;
  locale: string;
  visitHref: string;
};

type KnowledgeDiscoveryReader = ConstructorParameters<typeof KnowledgeDiscoveryReading>[0];

export function KnowledgeDiscoveryCaller({
  binding,
  returnTo,
  read,
  current,
}: {
  binding: KnowledgeDiscoveryBinding;
  returnTo: string;
  read: KnowledgeDiscoveryReader;
  current: () => boolean;
}) {
  const live = useRef(current);
  live.current = current;
  const readRef = useRef(read);
  readRef.current = read;
  const [reading, setReading] = useState<KnowledgeDiscoveryReading | null>(null);
  const subscribe = reading?.subscribe ?? ignoreSubscribe;
  const snapshot = useSyncExternalStore(
    subscribe,
    () => reading?.getSnapshot() ?? idleSnapshot,
    () => reading?.getSnapshot() ?? idleSnapshot,
  );
  useLayoutEffect(() => {
    const instance = new KnowledgeDiscoveryReading(
      async (request) => {
        if (!live.current()) return { state: 'unavailable', status: 503 };
        const result = await readRef.current(request);
        if (!live.current()) return { state: 'unavailable', status: 503 };
        return result;
      },
      binding,
      () => live.current(),
    );
    setReading(instance);
    void instance.open(null);
    return () => {
      instance.retire();
      setReading((currentReading) => (currentReading === instance ? null : currentReading));
    };
  }, [binding.subjectId, binding.locale, binding.visitHref, binding.sessionRevision]);
  const actions = reading?.actions(snapshot);
  return (
    <KnowledgeDiscoveryPanel
      locale={binding.locale}
      returnTo={returnTo}
      snapshot={snapshot}
      onMore={actions?.more}
      onContinue={actions?.continuePreparation}
      onRetry={actions?.retry}
      onRestart={actions?.restart}
    />
  );
}

/** Default mount for a readable Subject. Missing discovery stays in this region. */
export function KnowledgeDiscoverySlot({ subjectId, locale, visitHref }: KnowledgeDiscoverySlotProps) {
  const queryClient = useQueryClient();
  const session = useSession();
  const source = readerSessionSource(queryClient);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  const returnTo = parseKnowledgeDiscoveryReturn(visitHref, locale, subjectId) ?? '';
  const binding: KnowledgeDiscoveryBinding = {
    subjectId,
    locale,
    visitHref: returnTo,
    sessionRevision,
  };
  const current = () => source.snapshot() === sessionRevision && getLocale() === locale && !retiredVisit.current;
  const retiredVisit = useRef(false);
  useLayoutEffect(() => {
    retiredVisit.current = false;
    const stop = source.subscribe(() => {
      if (source.snapshot() !== sessionRevision) retiredVisit.current = true;
    });
    return () => {
      retiredVisit.current = true;
      stop();
    };
  }, [source, sessionRevision, subjectId, locale, returnTo]);
  return (
    <KnowledgeDiscoveryCaller
      key={`${subjectId}:${locale}:${returnTo}:${sessionRevision}`}
      binding={binding}
      returnTo={returnTo}
      current={current}
      read={(request) =>
        readKnowledgeDiscoveryPage({
          data: request,
          ...(csrfToken ? { headers: { 'X-CSRF-Token': csrfToken } } : {}),
        })
      }
    />
  );
}
