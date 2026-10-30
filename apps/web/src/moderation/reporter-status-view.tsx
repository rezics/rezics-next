import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { ReporterStatus } from './reporter-status-model';

/** Own-submission presentation has no shadcn equivalent; it composes existing controls.
 * Available is an annotation, never permission or a link to the target. */
export function ReporterStatusView({ report }: { report: ReporterStatus }) {
  const reason = {
    off_topic: m.report_off_topic,
    inappropriate: m.report_inappropriate,
    spam: m.report_spam,
    illegal: m.report_illegal,
    other: m.report_other,
  }[report.reason]();
  return (
    <article className="space-y-7 break-words" aria-labelledby="reporter-status-heading">
      <header className="space-y-3">
        <h1 id="reporter-status-heading" className="font-display text-3xl font-semibold tracking-tight">
          {m.reporter_status_heading()}
        </h1>
        <Badge variant="secondary">
          {report.outcome === 'actioned'
            ? m.moderation_actioned()
            : report.outcome === 'dismissed'
              ? m.moderation_dismissed()
              : m.reporter_status_pending()}
        </Badge>
      </header>
      <dl className="space-y-3 text-sm text-muted-foreground">
        <div>
          <dt>{m.reporter_status_submitted()}</dt>
          <dd>
            <ReportTime instant={report.createdAt} />
          </dd>
        </div>
        {report.resolvedAt ? (
          <div>
            <dt>{m.reporter_status_resolved()}</dt>
            <dd>
              <ReportTime instant={report.resolvedAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      <section className="space-y-2" aria-labelledby="reporter-status-reason">
        <h2 id="reporter-status-reason" className="text-lg font-semibold">
          {m.moderation_reason_label()}
        </h2>
        <p>{reason}</p>
        {report.evidence ? <p className="whitespace-pre-wrap leading-7">{report.evidence}</p> : null}
      </section>
      <section className="space-y-2 border-t border-border pt-6" aria-labelledby="reporter-status-target">
        <h2 id="reporter-status-target" className="text-lg font-semibold">
          {m.reporter_status_target()}
        </h2>
        <p>
          {report.targetAvailability === 'unavailable'
            ? m.moderation_target_unavailable()
            : m.reporter_status_available()}
        </p>
        <p className="break-all font-mono text-sm text-muted-foreground">
          {report.target.kind} {report.target.id}
        </p>
        {report.revisionId ? (
          <p className="text-sm text-muted-foreground">
            {m.reporter_status_revision()} <span className="break-all font-mono">{report.revisionId}</span>
          </p>
        ) : null}
      </section>
    </article>
  );
}

function ReportTime({ instant }: { instant: string }) {
  return (
    <time dateTime={instant}>
      {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
        new Date(instant),
      )}{' '}
      UTC
    </time>
  );
}

export function ReporterStatusFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-4" role="alert">
      <p>{m.reporter_status_unavailable()}</p>
      <Button onClick={onRetry}>{m.sources_retry()}</Button>
    </div>
  );
}
