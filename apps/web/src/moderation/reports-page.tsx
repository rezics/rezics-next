import { documentText } from '@rezics/document';
import { Tombstone } from '@rezics/ui/tombstone';
import { Withheld } from '@rezics/ui/withheld';
import { useState, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { actionOnReport } from './actions';
import type { Report, ResolvedReportTarget } from './reports-read';
import { PageHeading } from '../shell/page-heading';

export type ModerationTarget = ResolvedReportTarget;
export function moderationTargetContent(target: ModerationTarget | undefined): ReactNode {
  if (!target?.value || typeof target.value !== 'object') return m.moderation_target_unavailable();
  const data = target.value as Record<string, any>;
  const resource = data.post ?? data.thread ?? data.board ?? data;
  if (!resource || typeof resource !== 'object') return m.moderation_target_unavailable();
  if (resource.availability === 'withheld')
    return <Withheld shape="passage" labels={{ withheld: m.moderation_target_withheld() }} />;
  if (resource.availability === 'erased' || resource.availability === 'deleted' || resource.removed)
    return (
      <Tombstone
        shape={target.kind === 'post' ? 'post' : 'row'}
        reason="deleted"
        labels={{ deleted: m.moderation_target_deleted() }}
      />
    );
  if (resource.availability === 'unavailable') return m.moderation_target_unavailable();
  const revision = resource.revision && typeof resource.revision === 'object' ? resource.revision : resource;
  if (target.kind === 'post') {
    const body = revision.body ?? resource.body;
    try {
      return typeof body === 'string'
        ? body
        : body && typeof body === 'object'
          ? documentText(body as never)
          : m.moderation_target_unavailable();
    } catch {
      return m.moderation_target_unavailable();
    }
  }
  return typeof resource.title === 'string' && resource.title ? resource.title : m.threads_untitled();
}

export function ModerationReportsView({
  reports,
  targets,
  next,
  tab = 'reports',
  threadId,
  onNext,
}: {
  reports: Report[];
  targets: ModerationTarget[];
  next: string | null;
  tab?: 'reports' | 'appeals';
  threadId?: string;
  onNext?: (cursor: string) => void;
}) {
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_reports_tab()}</p>
        <PageHeading>{m.moderation_reports_heading()}</PageHeading>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        {tab === 'reports' ? (
          <span aria-current="page" className="font-semibold">
            {m.moderation_reports_tab()}
          </span>
        ) : (
          <a href={threadId ? `?thread=${encodeURIComponent(threadId)}` : '?'}>{m.moderation_reports_tab()}</a>
        )}
        {tab === 'appeals' ? (
          <span aria-current="page" className="font-semibold">
            {m.moderation_appeals_tab()}
          </span>
        ) : (
          <a href={`?tab=appeals${threadId ? `&thread=${encodeURIComponent(threadId)}` : ''}`}>
            {m.moderation_appeals_tab()}
          </a>
        )}
      </nav>
      {threadId ? <p className="text-sm text-muted-foreground">{m.moderation_thread_filter()}</p> : null}
      {reports.length ? (
        <ol className="space-y-4">
          {reports.map((report) => {
            const target = targets.find((item) => item.key === `${report.target.kind}:${report.target.id}`);
            return (
              <li key={report.id} className="space-y-3 rounded-lg border p-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{report.target.kind}</p>
                  <blockquote className="border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
                </div>
                <p>
                  <span className="font-medium">{m.moderation_reason_label()}:</span> {report.reason}
                </p>
                <time className="block text-sm text-muted-foreground" dateTime={report.createdAt}>
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(report.createdAt),
                  )}
                </time>
                {report.outcome ? (
                  <p role="status" className="font-medium">
                    {report.outcome === 'actioned' ? m.moderation_actioned() : m.moderation_dismissed()}
                  </p>
                ) : (
                  <ReportActions reportId={report.id} target={report.target} />
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground">{m.moderation_reports_empty()}</p>
      )}
      {next ? (
        <button type="button" className="rounded-md border px-4 py-2" onClick={() => onNext?.(next)}>
          {m.threads_next_page()}
        </button>
      ) : null}
    </article>
  );
}

function ReportActions({ reportId, target }: { reportId: string; target: Report['target'] }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function dismiss() {
    setPending(true);
    try {
      await actionOnReport({ data: { action: 'dismiss', reportId } });
      location.reload();
    } catch {
      setMessage(m.moderation_action_failed());
    } finally {
      setPending(false);
    }
  }
  async function takeDown(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      await actionOnReport({
        data: {
          action: 'take-down',
          reportId,
          targetKind: target.kind,
          targetId: target.id,
          reason: String(data.get('reason') ?? ''),
          statement: String(data.get('statement') ?? ''),
        },
      });
      location.reload();
    } catch {
      setMessage(m.moderation_action_failed());
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-3">
      <form className="space-y-3" onSubmit={takeDown}>
        <label className="block space-y-1">
          <span>{m.moderation_reason_label()}</span>
          <textarea
            name="reason"
            required
            maxLength={2048}
            className="min-h-20 w-full rounded-md border bg-background p-2"
          />
        </label>
        <label className="block space-y-1">
          <span>{m.moderation_statement_label()}</span>
          <textarea
            name="statement"
            required
            maxLength={2048}
            className="min-h-20 w-full rounded-md border bg-background p-2"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button disabled={pending} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
            {m.moderation_take_down()}
          </button>
          <button type="button" disabled={pending} className="rounded-md border px-4 py-2" onClick={dismiss}>
            {m.moderation_dismiss()}
          </button>
        </div>
      </form>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
