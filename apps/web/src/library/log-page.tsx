import { Exposure } from '../kernel/exposure';
import { RelativeTime } from './logs-progress';
import { useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { removePublishedLog, restorePublishedLog } from './logs-server';
import { UndoNotice } from './copies-undo';
import type { DeletionEvidence } from './copies-receipt';
import type { PublishedLog } from './logs-read';
import { AccountRef } from './account-ref';
import { rowRatio, SubjectIdentity } from './subject-row';

const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

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
};

function publicationPage(id: string, isOwner: boolean, loadedRevision: number | undefined): PublicationPage {
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
  };
}

export function PublishedLogPageView({
  log,
  isOwner,
  revision: loadedRevision,
}: {
  log: PublishedLog;
  isOwner: boolean;
  revision?: number;
}) {
  const [page, setPage] = useState(() => publicationPage(log.id, isOwner, loadedRevision));
  const committed = useRef<{
    lifetime: symbol;
    revision: number | undefined;
    deleted: boolean;
    deletionId: string | undefined;
    deletionRevision: number | undefined;
  } | null>(null);
  const busy = useRef<symbol | null>(null);
  const { lifetime, revision, undo, deleteStarted, confirming, deleted, pending, error, idempotencyKey } = page;
  const deletionId = undo?.deletionId;
  const deletionRevision = undo?.revision;

  useLayoutEffect(() => {
    committed.current = { lifetime, revision, deleted, deletionId, deletionRevision };
    return () => {
      committed.current = null;
    };
  }, [lifetime, revision, deleted, deletionId, deletionRevision]);

  // Compare loader primitives, not object identity or the locally restored revision.
  // Reset before committing children so an old UndoNotice cannot survive a new page.
  if (page.id !== log.id || page.isOwner !== isOwner || page.loadedRevision !== loadedRevision) {
    setPage(publicationPage(log.id, isOwner, loadedRevision));
  }

  const isCurrent = () => committed.current?.lifetime === lifetime && page.isOwner;
  function update(change: Partial<PublicationPage>) {
    setPage((current) => (current.lifetime === lifetime ? { ...current, ...change } : current));
  }

  async function remove() {
    if (
      !isCurrent() ||
      busy.current === lifetime ||
      committed.current?.deleted ||
      committed.current?.revision !== revision ||
      revision === undefined
    )
      return;
    busy.current = lifetime;
    update({ deleteStarted: deleteStarted ?? Date.now(), pending: true, error: null });
    try {
      const result = await removePublishedLog({
        data: { id: page.id, revision, idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!isCurrent()) return;
      if (!result.ok) {
        update({ error: result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed() });
        return;
      }
      update({ idempotencyKey: crypto.randomUUID(), confirming: false, undo: result.undo, deleted: true });
    } catch {
      if (isCurrent()) update({ error: m.library_logs_write_failed() });
    } finally {
      if (isCurrent()) {
        busy.current = null;
        update({ pending: false });
      }
    }
  }

  async function restore(idempotencyKey: string) {
    if (
      !isCurrent() ||
      busy.current === lifetime ||
      !committed.current?.deleted ||
      !undo ||
      committed.current.deletionId !== undo.deletionId ||
      committed.current.deletionRevision !== undo.revision ||
      Date.now() >= (deleteStarted ?? 0) + 30_000
    )
      return false;
    busy.current = lifetime;
    try {
      const result = await restorePublishedLog({
        data: { id: page.id, ...undo, idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!isCurrent() || !result.ok) return false;
      update({ revision: result.revision, deleted: false, undo: undefined, deleteStarted: null });
      return true;
    } finally {
      if (isCurrent()) busy.current = null;
    }
  }

  if (deleted) {
    return (
      <article className="max-w-4xl space-y-4 text-foreground">
        <UndoNotice
          message={m.library_logs_deleted()}
          deadline={(deleteStarted ?? 0) + 30_000}
          available={Boolean(undo)}
          operation="published_log.create"
          failure={m.library_logs_write_failed()}
          restore={restore}
        />
      </article>
    );
  }

  return (
    <article className="max-w-4xl space-y-6 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_logs_page_heading()}</PageHeading>
        <p>{m.library_logs_description()}</p>
      </header>
      <dl className="space-y-3">
        <div>
          <dt className="font-medium">{m.library_logs_account()}</dt>
          <dd>
            <AccountRef account={log.account} />
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
      {isOwner && revision !== undefined ? (
        <Exposure operation="published_log.delete">
          <div className="flex flex-wrap gap-3">
            {!confirming ? (
              <button type="button" className={buttonClass} onClick={() => update({ confirming: true })}>
                {m.library_logs_delete()}
              </button>
            ) : (
              <>
                <button type="button" className={buttonClass} disabled={pending} onClick={() => void remove()}>
                  {m.library_logs_confirm_delete()}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={pending}
                  onClick={() => update({ confirming: false })}
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
