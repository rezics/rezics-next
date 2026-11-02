import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { reportDecisionReason } from './actions';
import { createReportReviewAction, type ReportReviewResult } from './reports-view-action';
import type { Report, ReportTargetValue, ResolvedReportTarget } from './reports-read';
import type { ReportQueueAction } from '../stories/patterns/board-report-queue/board-report-queue';
import type { ReportsBulkAction } from './reports-bulk-action';
import { moderationTargetContent } from './target-content';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import { reportReviewDepartureMessages, reportReviewNavigationContext } from './reports-bulk-controls';

type Confirmation = { action: 'dismiss' } | { action: 'take-down'; reason: string };
type SettlementFocus = { generation: unknown; confirmation?: Confirmation; cancel: () => void };
function keyboardSource(event: { detail: number; currentTarget: HTMLButtonElement }) {
  return event.detail === 0 ? event.currentTarget : null;
}
const utcSuffix = /Z$/;
// Keep the supplied UTC precision, including fractions finer than JavaScript Date's milliseconds.
const date = (value: string) => value.replace('T', ' ').replace(utcSuffix, ' UTC');
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
  intentOwner,
  bulkBlocked = false,
}: {
  intentOwner?: ReportsBulkAction;
  bulkBlocked?: boolean;
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
  const currentOwner = useRef(intentOwner);
  currentOwner.current = intentOwner;
  const [reviewAction] = useState(() =>
    createReportReviewAction(
      () => currentOwner.current?.isCurrent() ?? true,
      () => currentOwner.current?.generation(),
    ),
  );
  useLayoutEffect(() => {
    // A page-data refresh retires bulk state without discarding an individual draft or uncertain intent.
    if (reviewAction.input) intentOwner?.claimIndividual(report.id);
  }, [intentOwner, report.id, reviewAction]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<Extract<ReportReviewResult, { ok: false }>['state'] | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmation | null>(null);
  useAuthoringDeparture(
    () => reviewAction.unresolved || (!reviewAction.receipt && reason !== ''),
    () => reviewAction.unresolved,
    JSON.stringify([report.id, reason, pending, failure, confirmed]),
    undefined,
    reviewAction.retire,
    undefined,
    reportReviewDepartureMessages(),
    reportReviewNavigationContext,
  );
  const confirmationRef = useRef<HTMLDivElement>(null);
  const settlementFocus = useRef<SettlementFocus | null>(null);
  const submitSource = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => () => settlementFocus.current?.cancel(), [report, intentOwner]);
  useEffect(() => {
    const focus = settlementFocus.current;
    if (!confirmed || focus?.confirmation !== confirmed) return;
    focus.cancel();
    if (intentOwner && (!intentOwner.isCurrent() || intentOwner.generation() !== focus.generation)) return;
    confirmationRef.current?.focus();
  }, [confirmed, intentOwner]);

  function beginSettlement(source: HTMLButtonElement | null): SettlementFocus | null {
    settlementFocus.current?.cancel();
    if (!source || source.ownerDocument.activeElement !== source) return null;
    const document = source.ownerDocument;
    const view = document.defaultView;
    const events = ['focusin', 'pointerdown', 'click', 'keydown'] as const;
    let unsubscribe: (() => void) | undefined;
    const focus: SettlementFocus = {
      generation: intentOwner?.generation(),
      cancel() {
        if (settlementFocus.current === focus) settlementFocus.current = null;
        for (const event of events) document.removeEventListener(event, focus.cancel, true);
        view?.removeEventListener('blur', focus.cancel);
        unsubscribe?.();
      },
    };
    settlementFocus.current = focus;
    // Listen only for this handoff; moving away and back cannot restore it.
    for (const event of events) document.addEventListener(event, focus.cancel, true);
    view?.addEventListener('blur', focus.cancel);
    unsubscribe = intentOwner?.subscribe(() => {
      if (!intentOwner.isCurrent() || intentOwner.generation() !== focus.generation) focus.cancel();
    });
    return focus;
  }
  const status =
    report.outcome === 'actioned'
      ? m.moderation_actioned()
      : report.outcome === 'dismissed' || confirmed?.action === 'dismiss'
        ? m.moderation_dismissed()
        : confirmed
          ? m.moderation_queue_takedown_confirmed()
          : m.moderation_queue_open();

  async function act(action: 'dismiss' | 'take-down', source: HTMLButtonElement | null) {
    if (bulkBlocked || pending || confirmed || report.outcome || failure || (takenDown && action === 'take-down'))
      return;
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
    if (intentOwner && !intentOwner.claimIndividual(report.id)) return;
    const focus = beginSettlement(source);
    setPending(true);
    try {
      finish(await reviewAction.submit(intent, onAction), confirmation, focus);
    } finally {
      setPending(false);
    }
  }

  function finish(result: ReportReviewResult | undefined, confirmation: Confirmation, focus: SettlementFocus | null) {
    if (!result) {
      focus?.cancel();
      return;
    }
    if (!result.ok) {
      focus?.cancel();
      setFailure(result.state);
      return;
    }
    setFailure(null);
    if (focus && settlementFocus.current === focus) focus.confirmation = confirmation;
    setConfirmed(confirmation);
    if (confirmation.action === 'take-down') onTakenDown();
    if (onRefresh) void onRefresh().catch(() => setMessage(m.moderation_queue_error()));
  }

  async function retry(source: HTMLButtonElement | null) {
    const input = reviewAction.input;
    if (bulkBlocked || pending || !input) return;
    const focus = beginSettlement(source);
    setPending(true);
    setMessage('');
    try {
      finish(
        await reviewAction.retry(onAction),
        input.action === 'dismiss' ? { action: 'dismiss' } : { action: 'take-down', reason: input.reason },
        focus,
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
      currentOwner.current?.releaseIndividual(report.id);
      setMessage(m.moderation_queue_refreshed());
    } catch {
      setMessage(m.moderation_queue_error());
    } finally {
      setPending(false);
    }
  }

  const blocked = bulkBlocked || pending || !!failure;
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
    <ContentItemFrame as="article" className="min-w-0 space-y-5 p-4 sm:p-6" aria-labelledby={`${id}-title`}>
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <ContentItemHeading id={`${id}-title`} level={2} className="text-lg font-semibold">
            {m.moderation_reports_tab()} ·{' '}
            {report.target.kind === 'post'
              ? m.moderation_queue_post()
              : report.target.kind === 'thread'
                ? m.moderation_queue_thread()
                : m.moderation_queue_board()}
          </ContentItemHeading>
          <Badge variant="secondary">{status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {m.moderation_queue_submitted()}{' '}
          <time
            dateTime={report.createdAt}
            dir="ltr"
            className="inline-block max-w-full select-text tabular-nums [overflow-wrap:anywhere]"
          >
            {date(report.createdAt)}
          </time>
        </p>
      </header>
      <section aria-labelledby={`${id}-submission`} className="space-y-3 rounded-xl bg-muted/50 p-4">
        <ContentItemHeading id={`${id}-submission`} level={3} className="text-sm font-semibold">
          {m.moderation_queue_submission()}
        </ContentItemHeading>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">{m.moderation_reason_label()}</dt>
            <dd className="mt-1 whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">
              {submittedReason(report.reason)}
            </dd>
          </div>
          {report.evidence ? (
            <div>
              <dt className="text-muted-foreground">{m.moderation_submitted_evidence_label()}</dt>
              <dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{report.evidence}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <div className="grid min-w-0 gap-6">
        <section aria-labelledby={`${id}-revision`} className="min-w-0 space-y-2">
          <ContentItemHeading id={`${id}-revision`} level={3} className="text-sm font-semibold">
            {m.moderation_reported_revision_label()}
          </ContentItemHeading>
          <div className="min-w-0 border-l-2 pl-3 text-sm leading-relaxed">
            {moderationTargetContent({ key: `post:${report.target.id}`, kind: 'post', value: revision })}
          </div>
        </section>
        <section aria-labelledby={`${id}-current`} className="min-w-0 space-y-2">
          <ContentItemHeading id={`${id}-current`} level={3} className="text-sm font-semibold">
            {m.moderation_current_target_label()}
          </ContentItemHeading>
          <p className="text-xs text-muted-foreground">
            <span>{m.moderation_appeal_target_label()}:</span>{' '}
            {report.target.kind === 'post'
              ? m.moderation_queue_post()
              : report.target.kind === 'thread'
                ? m.moderation_queue_thread()
                : m.moderation_queue_board()}{' '}
            <code className="break-all">{report.target.id}</code>
          </p>
          <div className="min-w-0 border-l-2 pl-3 text-sm leading-relaxed">{moderationTargetContent(target)}</div>
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
                {m.moderation_queue_resolved_at()}{' '}
                <time
                  dateTime={report.resolvedAt}
                  dir="ltr"
                  className="inline-block max-w-full select-text tabular-nums [overflow-wrap:anywhere]"
                >
                  {date(report.resolvedAt)}
                </time>
              </p>
            ) : null}
            {confirmed?.action === 'take-down' ? (
              <>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{confirmed.reason}</p>
                <p className="text-muted-foreground">{m.moderation_queue_projection_pending()}</p>
              </>
            ) : null}
          </div>
        ) : (
          <Collapsible>
            <CollapsibleTrigger
              render={<Button variant="outline" className="min-h-11" />}
              disabled={bulkBlocked || pending}
            >
              {m.moderation_queue_review()}
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <form
                className="space-y-4 pt-4"
                aria-busy={pending}
                onSubmit={(event) => {
                  event.preventDefault();
                  const source = submitSource.current;
                  submitSource.current = null;
                  void act('take-down', (event.nativeEvent as SubmitEvent).submitter === source ? source : null);
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
                    disabled={bulkBlocked || pending || failure === 'uncertain'}
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
                  <Button
                    type="submit"
                    variant="destructive"
                    className="min-h-11"
                    disabled={blocked || takenDown}
                    onClick={(event) => {
                      submitSource.current = keyboardSource(event);
                    }}
                  >
                    {m.moderation_take_down()}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={blocked}
                    onClick={(event) => void act('dismiss', keyboardSource(event))}
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
                        disabled={bulkBlocked || pending}
                        onClick={(event) => void retry(keyboardSource(event))}
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
      <details className="min-w-0 border-t pt-3" aria-labelledby={`${id}-reference`}>
        <summary
          id={`${id}-reference`}
          className="min-h-11 cursor-pointer rounded-md py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.moderation_queue_details_reference()}
        </summary>
        <dl className="min-w-0 py-2 text-sm">
          <div className="min-w-0">
            <dt className="text-muted-foreground">{m.moderation_queue_details_report_id()}</dt>
            <dd dir="ltr" className="mt-1 select-text break-all font-mono [overflow-wrap:anywhere]">
              {report.id}
            </dd>
          </div>
        </dl>
      </details>
    </ContentItemFrame>
  );
}
