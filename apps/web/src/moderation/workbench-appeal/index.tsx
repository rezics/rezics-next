import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { AppealResolution } from '../appeal-resolution';
import { appealTarget, type Appeal } from '../appeals-read';
import { moderationTargetContent } from '../target-content';
import type { ResolvedReportTarget } from '../reports-read';
import { workbenchAppealFromPage } from './read-model';

const date = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function WorkbenchAppeal({
  appealId,
  page,
  queueHref,
  isCurrent,
  onRetry,
  onRestart,
}: {
  appealId: string;
  page: Parameters<typeof workbenchAppealFromPage>[0];
  queueHref: string;
  isCurrent?: () => boolean;
  onRetry?: () => void;
  onRestart?: () => void;
}) {
  const result = workbenchAppealFromPage(page, appealId);
  if (result.state !== 'ready') {
    return (
      <WorkbenchAppealStatus
        state={result.state}
        queueHref={queueHref}
        {...(onRetry ? { onRetry } : {})}
        {...(onRestart ? { onRestart } : {})}
      />
    );
  }
  return (
    <WorkbenchAppealDetail
      appeal={result.appeal}
      target={result.target}
      queueHref={queueHref}
      {...(isCurrent ? { isCurrent } : {})}
    />
  );
}

export function WorkbenchAppealDetail({
  appeal,
  target,
  queueHref,
  isCurrent,
}: {
  appeal: Appeal;
  target: ResolvedReportTarget | undefined;
  queueHref: string;
  isCurrent?: () => boolean;
}) {
  const identity = appealTarget(appeal);
  const appealKind =
    identity?.kind === 'post'
      ? m.moderation_queue_post()
      : identity?.kind === 'thread'
        ? m.moderation_queue_thread()
        : m.moderation_target_unavailable();
  const targetKind =
    identity?.kind === 'post'
      ? m.reporter_status_post()
      : identity?.kind === 'thread'
        ? m.reporter_status_thread()
        : m.moderation_target_unavailable();
  return (
    <article className="space-y-5">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={queueHref}>
        {m.moderation_workbench_history_return()}
      </a>
      <h2 className="text-xl font-semibold">
        {m.moderation_appeals_tab()} · {appealKind}
      </h2>
      <ContentItemFrame as="article" className="space-y-5 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          {m.moderation_queue_submitted()} <time dateTime={appeal.createdAt}>{date(appeal.createdAt)}</time>
        </p>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_appeal_decision_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.decision.statement}</p>
        </section>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_current_target_label()}
          </ContentItemHeading>
          <Badge variant="outline">{targetKind}</Badge>
          <blockquote className="min-w-0 border-l-2 pl-3 wrap-anywhere">{moderationTargetContent(target)}</blockquote>
        </section>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_appeal_reason_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.statement}</p>
        </section>
        <div className="space-y-3 border-t pt-4">
          {appeal.decision.appeal ? (
            <p className="text-sm text-muted-foreground">
              {m.moderation_queue_resolved_at()}{' '}
              <time dateTime={appeal.decision.appeal.resolvedAt}>{date(appeal.decision.appeal.resolvedAt)}</time>
            </p>
          ) : null}
          <AppealResolution
            appealId={appeal.id}
            mayResolve={appeal.canResolve === true}
            resolution={appeal.decision.appeal ?? null}
            {...(isCurrent ? { isCurrent } : {})}
          />
        </div>
      </ContentItemFrame>
    </article>
  );
}

export function WorkbenchAppealStatus({
  state,
  queueHref,
  onRetry,
  onRestart,
}: {
  state: 'denied' | 'unavailable' | 'stale' | 'empty';
  queueHref: string;
  onRetry?: () => void;
  onRestart?: () => void;
}) {
  const message =
    state === 'denied'
      ? m.moderation_workbench_denied()
      : state === 'stale'
        ? m.moderation_workbench_stale()
        : state === 'empty'
          ? m.moderation_appeals_empty()
          : m.moderation_workbench_appeal_unavailable();
  return (
    <article className="space-y-5">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={queueHref}>
        {m.moderation_workbench_history_return()}
      </a>
      <ContentItemFrame as="div" role={state === 'empty' ? 'status' : 'alert'} className="space-y-3 p-4 sm:p-6">
        <ContentItemHeading level={2} className="text-base font-semibold">
          {message}
        </ContentItemHeading>
        {state === 'stale' && onRestart ? (
          <Button className="min-h-11" variant="outline" onClick={onRestart}>
            {m.moderation_queue_restart()}
          </Button>
        ) : state === 'unavailable' && onRetry ? (
          <Button className="min-h-11" variant="outline" onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </ContentItemFrame>
    </article>
  );
}

export { workbenchAppealFromPage } from './read-model';
