import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader } from '@rezics/ui/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { reportDecisionReason } from './actions';
import { createReportReviewAction, type ReportReviewResult } from './reports-view-action';
import type { Report, ReportTargetValue, ResolvedReportTarget } from './reports-read';
import type { ReportQueueAction } from '../stories/patterns/board-report-queue/board-report-queue';
import { moderationTargetContent } from './target-content';

type Confirmation = { action: 'dismiss' } | { action: 'take-down'; reason: string };
const date = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
function submittedReason(reason: string) {
  switch (reason) {
    case 'spam':
      return m.report_spam();
    case 'illegal':
      return m.report_illegal();
    case 'inappropriate':
      return m.report_inappropriate();
    case 'off_topic':
      return m.report_off_topic();
    case 'other':
      return m.report_other();
    default:
      return reason;
  }
}

/** The report, ordinary revision read and current target remain separate disclosure surfaces. */
export function ReportReviewCard({
  report,
  target,
  revision,
  takenDown,
  onAction,
  onTakenDown,
  onRefresh,
}: {
  report: Report;
  target: ResolvedReportTarget | undefined;
  revision: ReportTargetValue | null;
  takenDown: boolean;
  onAction: ReportQueueAction;
  onTakenDown: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [reviewAction] = useState(createReportReviewAction);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<Extract<ReportReviewResult, { ok: false }>['state'] | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmed) confirmationRef.current?.focus();
  }, [confirmed]);
  const status =
    report.outcome === 'actioned'
      ? m.moderation_actioned()
      : report.outcome === 'dismissed' || confirmed?.action === 'dismiss'
        ? m.moderation_dismissed()
        : confirmed
          ? m.moderation_queue_takedown_confirmed()
          : m.moderation_queue_open();

  async function act(action: 'dismiss' | 'take-down') {
    if (pending || confirmed || report.outcome || failure || (takenDown && action === 'take-down')) return;
    setMessage('');
    let confirmation: Confirmation;
    try {
      confirmation = action === 'dismiss' ? { action } : { action, reason: reportDecisionReason(reason) };
    } catch {
      setMessage(m.moderation_queue_reason_invalid());
      return;
    }
    const intent =
      confirmation.action === 'dismiss'
        ? { action: confirmation.action, reportId: report.id }
        : {
            action: confirmation.action,
            reportId: report.id,
            targetKind: report.target.kind,
            targetId: report.target.id,
            reason: confirmation.reason,
          };
    setPending(true);
    try {
      finish(await reviewAction.submit(intent, onAction), confirmation);
    } finally {
      setPending(false);
    }
  }

  function finish(result: ReportReviewResult | undefined, confirmation: Confirmation) {
    if (!result) return;
    if (!result.ok) {
      setFailure(result.state);
      return;
    }
    setFailure(null);
    setConfirmed(confirmation);
    if (confirmation.action === 'take-down') onTakenDown();
  }

  async function retry() {
    const input = reviewAction.input;
    if (pending || !input) return;
    setPending(true);
    setMessage('');
    try {
      finish(
        await reviewAction.retry(onAction),
        input.action === 'dismiss' ? { action: 'dismiss' } : { action: 'take-down', reason: input.reason },
      );
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    if (pending || !onRefresh) return;
    setPending(true);
    setMessage('');
    try {
      await reviewAction.refresh(onRefresh);
      setFailure(null);
      setMessage(m.moderation_queue_refreshed());
    } catch {
      setMessage(m.moderation_queue_error());
    } finally {
      setPending(false);
    }
  }

  const blocked = pending || !!failure;
  const failureMessage =
    failure === 'conflict'
      ? m.moderation_queue_conflict()
      : failure === 'forbidden'
        ? m.moderation_queue_denied()
        : failure === 'sign-in'
          ? m.moderation_queue_sign_in_required()
          : failure === 'unavailable'
            ? m.moderation_target_unavailable()
            : failure === 'uncertain'
              ? m.moderation_queue_uncertain()
              : m.moderation_action_failed();

  return (
    <Card className="min-w-0" role="article" aria-labelledby={`${id}-title`}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            {report.target.kind === 'post'
              ? m.moderation_queue_post()
              : report.target.kind === 'thread'
                ? m.moderation_queue_thread()
                : m.moderation_queue_board()}
          </h2>
          <Badge variant="secondary">{status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {m.moderation_queue_submitted()} <time dateTime={report.createdAt}>{date(report.createdAt)}</time>
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <section aria-labelledby={`${id}-submission`} className="space-y-3 rounded-xl bg-muted/50 p-4">
          <h3 id={`${id}-submission`} className="text-sm font-semibold">
            {m.moderation_queue_submission()}
          </h3>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">{m.moderation_reason_label()}</dt>
              <dd className="mt-1 font-medium">{submittedReason(report.reason)}</dd>
            </div>
            {report.evidence ? (
              <div>
                <dt className="text-muted-foreground">{m.moderation_submitted_evidence_label()}</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words">{report.evidence}</dd>
              </div>
            ) : null}
          </dl>
        </section>
        <div className="grid min-w-0 gap-6">
          <section aria-labelledby={`${id}-revision`} className="min-w-0 space-y-2">
            <h3 id={`${id}-revision`} className="text-sm font-semibold">
              {m.moderation_reported_revision_label()}
            </h3>
            <div className="min-w-0 border-l-2 pl-3 text-sm leading-relaxed">
              {moderationTargetContent({ key: `post:${report.target.id}`, kind: 'post', value: revision })}
            </div>
          </section>
          <section aria-labelledby={`${id}-current`} className="min-w-0 space-y-2">
            <h3 id={`${id}-current`} className="text-sm font-semibold">
              {m.moderation_current_target_label()}
            </h3>
            <div className="min-w-0 border-l-2 pl-3 text-sm leading-relaxed">
              {moderationTargetContent(target)}
            </div>
          </section>
        </div>
        <div className="border-t pt-4">
          {report.outcome || confirmed ? (
            <div
              ref={confirmationRef}
              role="status"
              tabIndex={-1}
              className="space-y-2 text-sm focus-visible:rounded-lg focus-visible:outline focus-visible:outline-ring"
            >
              {confirmed && !report.outcome ? <p className="font-medium">{status}</p> : null}
              {report.resolvedAt ? (
                <p className="text-muted-foreground">
                  {m.moderation_queue_resolved_at()} <time dateTime={report.resolvedAt}>{date(report.resolvedAt)}</time>
                </p>
              ) : null}
              {confirmed?.action === 'take-down' ? (
                <>
                  <p className="whitespace-pre-wrap break-words">{confirmed.reason}</p>
                  <p className="text-muted-foreground">{m.moderation_queue_projection_pending()}</p>
                </>
              ) : null}
            </div>
          ) : (
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="outline" className="min-h-11" />} disabled={pending}>
                {m.moderation_queue_review()}
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
                <form
                  className="space-y-4 pt-4"
                  aria-busy={pending}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act('take-down');
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor={`${id}-reason`}>{m.moderation_reason_label()}</FieldLabel>
                    <Textarea
                      id={`${id}-reason`}
                      name="reason"
                      required
                      maxLength={1024}
                      rows={3}
                      value={reason}
                      disabled={pending || failure === 'uncertain'}
                      aria-describedby={`${id}-hint`}
                      onChange={(event) => {
                        setReason(event.target.value);
                        reviewAction.changed();
                      }}
                    />
                    <FieldDescription id={`${id}-hint`}>{m.moderation_queue_reason_hint()}</FieldDescription>
                  </Field>
                  {takenDown ? (
                    <p className="text-sm text-muted-foreground">{m.moderation_queue_takedown_confirmed()}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="destructive" className="min-h-11" disabled={blocked || takenDown}>
                      {m.moderation_take_down()}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={blocked}
                      onClick={() => void act('dismiss')}
                    >
                      {m.moderation_dismiss()}
                    </Button>
                  </div>
                  {pending ? (
                    <p role="status" className="text-sm">
                      {m.moderation_queue_pending()}
                    </p>
                  ) : null}
                  {failure ? (
                    <div role="alert" className="space-y-1 text-sm">
                      <p>{failureMessage}</p>
                      <p className="text-muted-foreground">
                        {failure === 'uncertain' ? m.moderation_queue_retry_hint() : m.moderation_queue_refresh_hint()}
                      </p>
                      {failure === 'uncertain' ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending}
                          onClick={() => void retry()}
                        >
                          {m.moderation_queue_retry_action()}
                        </Button>
                      ) : onRefresh ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending}
                          onClick={() => void refresh()}
                        >
                          {m.moderation_queue_refresh()}
                        </Button>
                      ) : null}
                      {failure === 'sign-in' ? (
                        <a
                          className="inline-flex min-h-11 items-center underline"
                          href={`/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`}
                        >
                          {m.moderation_queue_sign_in()}
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  {message ? (
                    <p role={message === m.moderation_queue_refreshed() ? 'status' : 'alert'} className="text-sm">
                      {message}
                    </p>
                  ) : null}
                </form>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
