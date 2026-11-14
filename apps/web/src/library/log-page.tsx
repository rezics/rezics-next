import { Exposure } from '../kernel/exposure';
import { RelativeTime } from './logs-relative-time';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { removePublishedLog, restorePublishedLog } from './logs-server';
import { bindLogsReturnVisit, logsReturnBackClick, logsReturnBackHref } from './logs-return';
import { UndoNotice } from './copies-undo';
import type { DeletionEvidence } from './copies-receipt';
import type { PublishedLog } from './logs-read';
import { LogContributor } from './log-contributor';
import { rowRatio, SubjectIdentity } from './subject-row';

const buttonClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal rounded-lg border border-border px-4 py-2 text-start text-primary underline-offset-4 [overflow-wrap:anywhere] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function stateLabel(state: PublishedLog['sessionState']): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

function SnapshotTime({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-medium">{label}: </span>
      <RelativeTime value={value} />
    </p>
  );
}

function PublishedLogBack({
  logId,
  locale,
  sessionSubject,
}: {
  logId: string;
  locale: string;
  sessionSubject?: string | null;
}) {
  const href = logsReturnBackHref(locale);
  if (!href) return null;
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center rounded text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={(event) => logsReturnBackClick(event, logId, locale, sessionSubject ?? null)}
    >
      {m.library_logs_back()}
    </a>
  );
}

/** Additive operands keep standalone presentation compatible; the route supplies actual authority. */
export type PublishedLogOrigin = {
  lifetime: object;
  remove: {
    lifetime: object;
    observation?: object | undefined;
    isCurrent: () => boolean;
    headers: () => HeadersInit | null;
  };
  restore: {
    lifetime: object;
    observation?: object | undefined;
    isCurrent: () => boolean;
    headers: () => HeadersInit | null;
  };
};

type PublicationPage = {
  id: string;
  isOwner: boolean;
  loadedRevision: number | undefined;
  lifetime: symbol;
  revision: number | undefined;
  undo: DeletionEvidence | undefined;
  deleteStarted: number | null;
  confirming: boolean;
  deleted: boolean;
  pending: boolean;
  error: string | null;
  idempotencyKey: string;
  origin: PublishedLogOrigin | undefined;
  restoreGeneration: number;
  undoKey: string | undefined;
};

type OriginPresentation = {
  removeLifetime: object | undefined;
  removeObservation: object | undefined;
  restoreLifetime: object | undefined;
  restoreObservation: object | undefined;
};

type ReturnIntent = {
  lifetime: symbol;
  opener: HTMLButtonElement;
  origin: OriginPresentation;
};

type FocusIntent = {
  lifetime: symbol;
  destination: 'confirmation' | 'cancel' | 'retry' | 'deleted' | 'reading';
  focusVersion: number;
  origin: OriginPresentation;
};

type PresentationTargets = {
  lifetime: symbol;
  readingContext: HTMLElement | null;
  removeContext: HTMLElement | null;
  deleteButton: HTMLButtonElement | null;
  confirmButton: HTMLButtonElement | null;
  deletedContext: HTMLElement | null;
  returnIntent: ReturnIntent | null;
  focusIntent: FocusIntent | null;
};

function originPresentation(origin?: PublishedLogOrigin): OriginPresentation {
  return {
    removeLifetime: origin?.remove.lifetime,
    removeObservation: origin?.remove.observation,
    restoreLifetime: origin?.restore.lifetime,
    restoreObservation: origin?.restore.observation,
  };
}

function sameOriginPresentation(left: OriginPresentation, right: OriginPresentation): boolean {
  return (
    left.removeLifetime === right.removeLifetime &&
    left.removeObservation === right.removeObservation &&
    left.restoreLifetime === right.restoreLifetime &&
    left.restoreObservation === right.restoreObservation
  );
}

function publicationPage(
  id: string,
  isOwner: boolean,
  loadedRevision: number | undefined,
  origin?: PublishedLogOrigin,
): PublicationPage {
  return {
    id,
    isOwner,
    loadedRevision,
    lifetime: Symbol(),
    revision: loadedRevision,
    undo: undefined,
    deleteStarted: null,
    confirming: false,
    deleted: false,
    pending: false,
    error: null,
    idempotencyKey: crypto.randomUUID(),
    origin,
    restoreGeneration: 0,
    undoKey: undefined,
  };
}

export function PublishedLogPageView({
  log,
  isOwner,
  revision: loadedRevision,
  originating,
  sessionSubject = null,
}: {
  log: PublishedLog;
  isOwner: boolean;
  revision?: number;
  originating?: PublishedLogOrigin;
  sessionSubject?: string | null;
}) {
  const locale = getLocale();
  const [page, setPage] = useState(() => publicationPage(log.id, isOwner, loadedRevision, originating));
  const committed = useRef<{
    lifetime: symbol;
    revision: number | undefined;
    deleted: boolean;
    deletionId: string | undefined;
    deletionRevision: number | undefined;
  } | null>(null);
  const busy = useRef<{ lifetime: symbol; operation: 'remove' | 'restore' } | null>(null);
  const deleteErrorId = useId();
  const focusVersion = useRef(0);
  const suppressFocusTracking = useRef(false);
  const presentationTargets = useRef<PresentationTargets | null>(null);
  const currentOriginPresentation = originPresentation(originating);
  const currentOriginPresentationRef = useRef(currentOriginPresentation);
  currentOriginPresentationRef.current = currentOriginPresentation;
  if (!presentationTargets.current || presentationTargets.current.lifetime !== page.lifetime) {
    presentationTargets.current = {
      lifetime: page.lifetime,
      readingContext: null,
      removeContext: null,
      deleteButton: null,
      confirmButton: null,
      deletedContext: null,
      returnIntent: null,
      focusIntent: null,
    };
  }
  const targets = presentationTargets.current;
  const { lifetime, revision, undo, deleteStarted, confirming, deleted, pending, error, idempotencyKey } = page;
  const deletionId = undo?.deletionId;
  const deletionRevision = undo?.revision;

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (
        suppressFocusTracking.current ||
        !(event.target instanceof HTMLElement) ||
        event.target === document.body ||
        event.target === document.documentElement
      )
        return;
      focusVersion.current++;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useLayoutEffect(() => {
    bindLogsReturnVisit(locale, sessionSubject ?? null, log.id);
  }, [locale, log.id, sessionSubject]);

  useLayoutEffect(() => {
    committed.current = { lifetime, revision, deleted, deletionId, deletionRevision };
    return () => {
      committed.current = null;
    };
  }, [lifetime, revision, deleted, deletionId, deletionRevision]);

  // Compare loader primitives, not object identity or the locally restored revision.
  // Reset before committing children so an old UndoNotice cannot survive a new page.
  if (
    page.id !== log.id ||
    page.isOwner !== isOwner ||
    (!originating && page.loadedRevision !== loadedRevision) ||
    page.origin?.lifetime !== originating?.lifetime
  ) {
    committed.current = null;
    setPage(publicationPage(log.id, isOwner, loadedRevision, originating));
  } else if (
    page.origin?.remove.lifetime !== originating?.remove.lifetime ||
    page.origin?.restore.lifetime !== originating?.restore.lifetime ||
    page.origin?.remove.observation !== originating?.remove.observation ||
    page.origin?.restore.observation !== originating?.restore.observation ||
    page.loadedRevision !== loadedRevision
  ) {
    const removeChanged = page.origin?.remove.lifetime !== originating?.remove.lifetime;
    const restoreChanged = page.origin?.restore.lifetime !== originating?.restore.lifetime;
    const removeObservationChanged = page.origin?.remove.observation !== originating?.remove.observation;
    const restoreObservationChanged = page.origin?.restore.observation !== originating?.restore.observation;
    const advanceRevision =
      !page.deleteStarted &&
      !page.deleted &&
      loadedRevision !== undefined &&
      (page.revision === undefined || loadedRevision >= page.revision);
    if (
      ((removeChanged || removeObservationChanged) && busy.current?.operation === 'remove') ||
      ((restoreChanged || restoreObservationChanged) && busy.current?.operation === 'restore')
    )
      busy.current = null;
    setPage({
      ...page,
      origin: originating,
      loadedRevision,
      ...(advanceRevision ? { revision: loadedRevision } : {}),
      ...(removeChanged || removeObservationChanged
        ? {
            ...(removeChanged ? { confirming: false } : {}),
            pending: false,
            error: null,
          }
        : {}),
      ...(restoreChanged || restoreObservationChanged ? { restoreGeneration: page.restoreGeneration + 1 } : {}),
    });
  }

  const isCurrent = (operation: 'remove' | 'restore') =>
    committed.current?.lifetime === lifetime && page.isOwner && (!originating || originating[operation].isCurrent());
  function focusLocalTarget(target: HTMLElement | null) {
    if (!target?.isConnected) return false;
    suppressFocusTracking.current = true;
    try {
      target.focus();
    } finally {
      suppressFocusTracking.current = false;
    }
    return true;
  }
  function update(change: Partial<PublicationPage>) {
    setPage((current) => (current.lifetime === lifetime ? { ...current, ...change } : current));
  }

  async function remove() {
    if (
      !isCurrent('remove') ||
      busy.current?.lifetime === lifetime ||
      committed.current?.deleted ||
      committed.current?.revision !== revision ||
      revision === undefined
    )
      return;
    const headers = originating ? originating.remove.headers() : csrfHeaders();
    if (!headers) return;
    const originAtStart = originPresentation(originating);
    const focusVersionAtStart = focusVersion.current;
    focusLocalTarget(targets.removeContext);
    busy.current = { lifetime, operation: 'remove' };
    update({ deleteStarted: deleteStarted ?? Date.now(), pending: true, error: null });
    try {
      const result = await removePublishedLog({
        data: { id: page.id, revision, idempotencyKey },
        headers,
      });
      if (!isCurrent('remove')) return;
      if (!result.ok) {
        targets.focusIntent = {
          lifetime,
          destination: 'retry',
          focusVersion: focusVersionAtStart,
          origin: originAtStart,
        };
        update({ error: result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed() });
        return;
      }
      if (result.id !== page.id) return;
      targets.returnIntent = null;
      targets.focusIntent = {
        lifetime,
        destination: 'deleted',
        focusVersion: focusVersionAtStart,
        origin: originAtStart,
      };
      update({
        idempotencyKey: crypto.randomUUID(),
        confirming: false,
        undo: result.undo,
        deleted: true,
        undoKey: crypto.randomUUID(),
      });
    } catch {
      if (isCurrent('remove')) {
        targets.focusIntent = {
          lifetime,
          destination: 'retry',
          focusVersion: focusVersionAtStart,
          origin: originAtStart,
        };
        update({ error: m.library_logs_write_failed() });
      }
    } finally {
      if (isCurrent('remove')) {
        busy.current = null;
        update({ pending: false });
      }
    }
  }

  async function restore(idempotencyKey: string) {
    if (
      !isCurrent('restore') ||
      busy.current?.lifetime === lifetime ||
      !committed.current?.deleted ||
      !undo ||
      committed.current.deletionId !== undo.deletionId ||
      committed.current.deletionRevision !== undo.revision ||
      Date.now() >= (deleteStarted ?? 0) + 30_000
    )
      return false;
    const headers = originating ? originating.restore.headers() : csrfHeaders();
    if (!headers) return false;
    const originAtStart = originPresentation(originating);
    const focusVersionAtStart = focusVersion.current;
    focusLocalTarget(targets.deletedContext);
    busy.current = { lifetime, operation: 'restore' };
    try {
      const result = await restorePublishedLog({
        data: { id: page.id, ...undo, idempotencyKey: page.undoKey ?? idempotencyKey },
        headers,
      });
      if (!isCurrent('restore') || !result.ok || result.id !== page.id) return false;
      targets.returnIntent = null;
      targets.focusIntent = {
        lifetime,
        destination: 'reading',
        focusVersion: focusVersionAtStart,
        origin: originAtStart,
      };
      update({ revision: result.revision, deleted: false, undo: undefined, deleteStarted: null });
      return true;
    } finally {
      if (isCurrent('restore')) busy.current = null;
    }
  }

  useLayoutEffect(() => {
    const intent = targets.focusIntent;
    if (!intent) return;
    if (presentationTargets.current !== targets || intent.lifetime !== lifetime) {
      targets.focusIntent = null;
      return;
    }
    if (!sameOriginPresentation(currentOriginPresentationRef.current, intent.origin)) {
      targets.focusIntent = null;
      targets.returnIntent = null;
      return;
    }
    if (intent.destination === 'retry' && pending) return;
    const ready =
      (intent.destination === 'confirmation' && confirming && !deleted) ||
      (intent.destination === 'cancel' && !confirming && !deleted) ||
      (intent.destination === 'retry' && confirming && !deleted && !pending && error !== null) ||
      (intent.destination === 'deleted' && deleted) ||
      (intent.destination === 'reading' && !deleted);
    if (!ready) {
      targets.focusIntent = null;
      return;
    }
    targets.focusIntent = null;
    if (focusVersion.current !== intent.focusVersion) {
      if (intent.destination === 'cancel') targets.returnIntent = null;
      return;
    }
    let target: HTMLElement | null = null;
    if (intent.destination === 'confirmation' || intent.destination === 'retry') {
      target = targets.confirmButton;
    } else if (intent.destination === 'cancel') {
      const returnIntent = targets.returnIntent;
      const hasCurrentReturn =
        returnIntent?.lifetime === lifetime &&
        sameOriginPresentation(returnIntent.origin, intent.origin) &&
        returnIntent.opener.ownerDocument === document;
      target = hasCurrentReturn && targets.deleteButton?.isConnected ? targets.deleteButton : targets.readingContext;
      targets.returnIntent = null;
    } else if (intent.destination === 'deleted') {
      target = targets.deletedContext;
    } else {
      target = targets.readingContext;
    }
    focusLocalTarget(target);
  });

  return (
    <article className="max-w-4xl space-y-6 text-foreground">
      <header
        ref={(node) => {
          if (presentationTargets.current === targets) targets.readingContext = node;
        }}
        role="group"
        aria-label={m.library_logs_page_heading()}
        tabIndex={-1}
        className="space-y-3 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <PageHeading>{m.library_logs_page_heading()}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.library_logs_description()}</p>
        <p className="text-sm text-muted-foreground">{m.library_journal_public_boundary()}</p>
        <PublishedLogBack logId={log.id} locale={locale} sessionSubject={sessionSubject} />
      </header>
      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
        <SubjectIdentity subject={log.subject} ratio={rowRatio([log.subject])} size="md" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <LogContributor attribution={log.attribution} account={log.account} locale={getLocale()} />
          <span>{stateLabel(log.sessionState)}</span>
          <RelativeTime value={log.publishedAt} />
        </div>
        {log.note ? (
          <div className="space-y-2 border-t pt-5">
            <h2 className="text-sm font-medium text-muted-foreground">{m.library_logs_note()}</h2>
            <p
              dir="auto"
              className="max-w-prose whitespace-pre-wrap text-base leading-relaxed [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
            >
              {log.note}
            </p>
          </div>
        ) : null}
      </section>
      <details className="rounded-lg border px-4">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_logs_dates()}
        </summary>
        <section aria-label={m.library_logs_dates()} className="space-y-2 border-t py-4 text-sm">
          <SnapshotTime label={m.library_logs_started()} value={log.startedAt} />
          {log.completedAt ? <SnapshotTime label={m.library_logs_completed()} value={log.completedAt} /> : null}
          <SnapshotTime label={m.library_logs_published()} value={log.publishedAt} />
          <p className="text-muted-foreground">{m.library_history_published_snapshot()}</p>
        </section>
      </details>
      {deleted ? (
        <section
          ref={(node) => {
            if (presentationTargets.current === targets) targets.deletedContext = node;
          }}
          role="region"
          aria-label={m.library_logs_deleted()}
          tabIndex={-1}
          className="space-y-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <UndoNotice
            key={page.restoreGeneration}
            message={m.library_logs_deleted()}
            deadline={(deleteStarted ?? 0) + 30_000}
            available={Boolean(undo) && (!originating || originating.restore.isCurrent())}
            operation="published_log.create"
            failure={m.library_logs_write_failed()}
            restore={restore}
          />
        </section>
      ) : isOwner && revision !== undefined && (!originating || originating.remove.isCurrent()) ? (
        <Exposure operation="published_log.delete">
          <section
            ref={(node) => {
              if (presentationTargets.current === targets) targets.removeContext = node;
            }}
            role="region"
            aria-label={m.library_logs_delete()}
            aria-busy={pending || undefined}
            tabIndex={-1}
            className="space-y-3 rounded-xl border bg-card p-4 sm:p-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {error ? (
              <p id={deleteErrorId} role="alert" className="rounded-lg border border-border p-3">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {!confirming ? (
                <button
                  ref={(node) => {
                    if (presentationTargets.current === targets) targets.deleteButton = node;
                  }}
                  type="button"
                  className={buttonClass}
                  onClick={(event) => {
                    if (isCurrent('remove')) {
                      const origin = originPresentation(originating);
                      targets.returnIntent = { lifetime, opener: event.currentTarget, origin };
                      targets.focusIntent = {
                        lifetime,
                        destination: 'confirmation',
                        focusVersion: focusVersion.current,
                        origin,
                      };
                      update({ confirming: true });
                    }
                  }}
                >
                  {m.library_logs_delete()}
                </button>
              ) : (
                <>
                  <button
                    ref={(node) => {
                      if (presentationTargets.current === targets) targets.confirmButton = node;
                    }}
                    type="button"
                    className={buttonClass}
                    disabled={pending}
                    aria-describedby={error ? deleteErrorId : undefined}
                    onClick={() => void remove()}
                  >
                    {m.library_logs_confirm_delete()}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={pending}
                    onClick={() => {
                      if (isCurrent('remove')) {
                        targets.focusIntent = {
                          lifetime,
                          destination: 'cancel',
                          focusVersion: focusVersion.current,
                          origin: originPresentation(originating),
                        };
                        update({ confirming: false });
                      }
                    }}
                  >
                    {m.library_logs_cancel()}
                  </button>
                </>
              )}
            </div>
          </section>
        </Exposure>
      ) : null}
    </article>
  );
}
