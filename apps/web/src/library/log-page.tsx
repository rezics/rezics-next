import { Exposure } from '../kernel/exposure';
import { RelativeTime } from './logs-progress';
import { useRef, useState } from 'react';
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

export function PublishedLogPageView({
  log,
  isOwner,
  revision: loadedRevision,
}: {
  log: PublishedLog;
  isOwner: boolean;
  revision?: number;
}) {
  const [revision, setRevision] = useState(loadedRevision);
  const [undo, setUndo] = useState<DeletionEvidence | undefined>();
  const deleteStarted = useRef<number | null>(null);
  const busy = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  async function remove() {
    if (busy.current || revision === undefined) return;
    busy.current = true;
    deleteStarted.current ??= Date.now();
    setPending(true);
    setError(null);
    try {
      const result = await removePublishedLog({
        data: { id: log.id, revision, idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setError(result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed());
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      setConfirming(false);
      setUndo(result.undo);
      setDeleted(true);
    } catch {
      setError(m.library_logs_write_failed());
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (deleted) {
    return (
      <article className="max-w-4xl space-y-4 text-foreground">
        <UndoNotice
          message={m.library_logs_deleted()}
          deadline={(deleteStarted.current ?? 0) + 30_000}
          available={Boolean(undo)}
          operation="published_log.create"
          failure={m.library_logs_write_failed()}
          restore={async (idempotencyKey) => {
            if (!undo) return false;
            const result = await restorePublishedLog({
              data: { id: log.id, ...undo, idempotencyKey },
              headers: csrfHeaders(),
            });
            if (!result.ok) return false;
            setRevision(result.revision);
            setDeleted(false);
            setUndo(undefined);
            deleteStarted.current = null;
            return true;
          }}
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
          <p className="whitespace-pre-wrap">{log.note}</p>
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
              <button type="button" className={buttonClass} onClick={() => setConfirming(true)}>
                {m.library_logs_delete()}
              </button>
            ) : (
              <>
                <button type="button" className={buttonClass} disabled={pending} onClick={() => void remove()}>
                  {m.library_logs_confirm_delete()}
                </button>
                <button type="button" className={buttonClass} disabled={pending} onClick={() => setConfirming(false)}>
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
