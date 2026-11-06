import { Exposure } from '../kernel/exposure';
import { RelativeTime } from './logs-relative-time';
import { useLayoutEffect, useRef, useState } from 'react';
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
  const { lifetime, revision, undo, deleteStarted, confirming, deleted, pending, error, idempotencyKey } = page;
  const deletionId = undo?.deletionId;
  const deletionRevision = undo?.revision;

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
    busy.current = { lifetime, operation: 'remove' };
    update({ deleteStarted: deleteStarted ?? Date.now(), pending: true, error: null });
    try {
      const result = await removePublishedLog({
        data: { id: page.id, revision, idempotencyKey },
        headers,
      });
      if (!isCurrent('remove')) return;
      if (!result.ok) {
        update({ error: result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed() });
        return;
      }
      if (result.id !== page.id) return;
      update({
        idempotencyKey: crypto.randomUUID(),
        confirming: false,
        undo: result.undo,
        deleted: true,
        undoKey: crypto.randomUUID(),
      });
    } catch {
      if (isCurrent('remove')) update({ error: m.library_logs_write_failed() });
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
    busy.current = { lifetime, operation: 'restore' };
    try {
      const result = await restorePublishedLog({
        data: { id: page.id, ...undo, idempotencyKey: page.undoKey ?? idempotencyKey },
        headers,
      });
      if (!isCurrent('restore') || !result.ok || result.id !== page.id) return false;
      update({ revision: result.revision, deleted: false, undo: undefined, deleteStarted: null });
      return true;
    } finally {
      if (isCurrent('restore')) busy.current = null;
    }
  }

  if (deleted) {
    return (
      <article className="max-w-4xl space-y-4 text-foreground">
        <UndoNotice
          key={page.restoreGeneration}
          message={m.library_logs_deleted()}
          deadline={(deleteStarted ?? 0) + 30_000}
          available={Boolean(undo) && (!originating || originating.restore.isCurrent())}
          operation="published_log.create"
          failure={m.library_logs_write_failed()}
          restore={restore}
        />
        <PublishedLogBack logId={log.id} locale={locale} sessionSubject={sessionSubject} />
      </article>
    );
  }

  return (
    <article className="max-w-4xl space-y-6 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_logs_page_heading()}</PageHeading>
        <p>{m.library_logs_description()}</p>
        <PublishedLogBack logId={log.id} locale={locale} sessionSubject={sessionSubject} />
      </header>
      <dl className="space-y-3">
        <div>
          <dt className="font-medium">{m.library_logs_account()}</dt>
          <dd>
            <LogContributor attribution={log.attribution} account={log.account} locale={getLocale()} />
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.library_logs_subject()}</dt>
          <dd className="flex items-center gap-3">
            <SubjectIdentity subject={log.subject} ratio={rowRatio([log.subject])} />
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.library_logs_session_state()}</dt>
          <dd>{stateLabel(log.sessionState)}</dd>
        </div>
      </dl>
      <section aria-label={m.library_logs_dates()} className="space-y-2">
        <SnapshotTime label={m.library_logs_started()} value={log.startedAt} />
        {log.completedAt ? <SnapshotTime label={m.library_logs_completed()} value={log.completedAt} /> : null}
        <SnapshotTime label={m.library_logs_published()} value={log.publishedAt} />
      </section>
      {log.note ? (
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{m.library_logs_note()}</h2>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{log.note}</p>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg border border-border bg-card p-3">
          {error}
        </p>
      ) : null}
      {isOwner && revision !== undefined && (!originating || originating.remove.isCurrent()) ? (
        <Exposure operation="published_log.delete">
          <div className="flex flex-wrap gap-3">
            {!confirming ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  if (isCurrent('remove')) update({ confirming: true });
                }}
              >
                {m.library_logs_delete()}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={pending}
                  autoFocus
                  onClick={() => void remove()}
                >
                  {m.library_logs_confirm_delete()}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={pending}
                  onClick={() => {
                    if (isCurrent('remove')) update({ confirming: false });
                  }}
                >
                  {m.library_logs_cancel()}
                </button>
              </>
            )}
          </div>
        </Exposure>
      ) : null}
    </article>
  );
}
