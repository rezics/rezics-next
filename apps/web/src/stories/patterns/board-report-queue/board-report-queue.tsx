import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import { reportDecisionReason, type ReportActionInput } from '../../../moderation/actions';
import { createModerationIntent } from '../../../moderation/command-intent';
import type { Report, ReportedRevision, ResolvedReportTarget } from '../../../moderation/reports-read';
import { moderationTargetContent } from './target-content';

export type ReportQueueAction = (input: ReportActionInput) => Promise<void>;
export function BoardReportQueue({
  reports,
  targets,
  revisions = [],
  onAction,
}: {
  reports: Report[];
  targets: ResolvedReportTarget[];
  revisions?: ReportedRevision[];
  onAction: ReportQueueAction;
}) {
  return (
    <>
      {' '}
      {reports.length ? (
        <ol className="space-y-4">
          {reports.map((report) => {
            const target = targets.find((item) => item.key === `${report.target.kind}:${report.target.id}`);
            return (
              <ListRow key={report.id} className="space-y-3 py-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{m.moderation_current_target_label()}</p>
                  <blockquote className="border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{m.moderation_reported_revision_label()}</p>
                  <blockquote className="border-l-2 pl-3">
                    {moderationTargetContent({
                      key: report.id,
                      kind: 'post',
                      value: revisions.find((item) => item.reportId === report.id)?.value ?? null,
                    })}
                  </blockquote>
                </div>
                <p>
                  <span className="font-medium">{m.moderation_reason_label()}:</span> {report.reason}
                </p>
                {report.evidence ? (
                  <p className="whitespace-pre-wrap">
                    <span className="font-medium">{m.moderation_submitted_evidence_label()}:</span> {report.evidence}
                  </p>
                ) : null}
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
                  <ListRowControl>
                    <ReportActions reportId={report.id} target={report.target} onAction={onAction} />
                  </ListRowControl>
                )}
              </ListRow>
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground">{m.moderation_reports_empty()}</p>
      )}
    </>
  );
}

function ReportActions({
  reportId,
  target,
  onAction,
}: {
  reportId: string;
  target: Report['target'];
  onAction: ReportQueueAction;
}) {
  const [reason, setReason] = useState('');
  const [commandIntent] = useState(createModerationIntent);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function dismiss() {
    if (pending) return;
    setPending(true);
    try {
      const intent = { action: 'dismiss' as const, reportId };
      await onAction({ ...intent, idempotencyKey: commandIntent.keyFor(intent) });
    } catch {
      setMessage(m.moderation_action_failed());
    } finally {
      setPending(false);
    }
  }
  async function takeDown(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const validReason = reportDecisionReason(reason);
      const intent = {
        action: 'take-down' as const,
        reportId,
        targetKind: target.kind,
        targetId: target.id,
        reason: validReason,
      };
      await onAction({ ...intent, idempotencyKey: commandIntent.keyFor(intent) });
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
            maxLength={1024}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              commandIntent.changed();
            }}
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
