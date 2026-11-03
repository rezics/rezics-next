import type { MouseEvent } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { AppealResolution } from '../appeal-resolution';
import { appealTarget, type Appeal, type AppealAppellantIdentity, type AppealTargetContext } from '../appeals-read';
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
  onUnresolvedChange,
}: {
  appealId: string;
  page: Parameters<typeof workbenchAppealFromPage>[0];
  queueHref: string;
  isCurrent?: () => boolean;
  onRetry?: (event?: MouseEvent<HTMLButtonElement>) => void;
  onRestart?: () => void;
  onUnresolvedChange?: (unresolved: boolean) => void;
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
      queueHref={queueHref}
      {...(isCurrent ? { isCurrent } : {})}
      {...(onUnresolvedChange ? { onUnresolvedChange } : {})}
    />
  );
}

export function WorkbenchAppealDetail({
  appeal,
  queueHref,
  isCurrent,
  onUnresolvedChange,
}: {
  appeal: Appeal;
  queueHref: string;
  isCurrent?: () => boolean;
  onUnresolvedChange?: (unresolved: boolean) => void;
}) {
  const originalTarget = appealTarget(appeal);
  const resolution = appeal.resolution !== undefined ? appeal.resolution : (appeal.decision.appeal ?? null);
  return (
    <article className="space-y-5">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={queueHref}>
        {m.moderation_workbench_history_return()}
      </a>
      <h2 className="text-xl font-semibold">{m.moderation_appeals_tab()}</h2>
      <ContentItemFrame as="article" className="space-y-5 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          {m.moderation_queue_submitted()} <time dateTime={appeal.createdAt}>{date(appeal.createdAt)}</time>
        </p>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_appeal_appellant_label()}
          </ContentItemHeading>
          <AppellantIdentity identity={appeal.appellantIdentity} />
        </section>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_appeal_decision_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.decision.statement}</p>
          <div className="space-y-1 text-sm">
            <p>{m.moderation_appeal_original_target_label()}</p>
            {originalTarget ? (
              <p className="wrap-anywhere">
                {targetKindLabel(originalTarget.kind)} <code className="break-all">{originalTarget.id}</code>
              </p>
            ) : (
              <p>{m.moderation_target_unavailable()}</p>
            )}
          </div>
        </section>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_current_target_label()}
          </ContentItemHeading>
          <CurrentDestination context={appeal.targetContext} />
        </section>
        <section className="space-y-2">
          <ContentItemHeading level={3} className="text-sm font-semibold">
            {m.moderation_appeal_reason_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.statement}</p>
        </section>
        <div className="space-y-3 border-t pt-4">
          {resolution ? (
            <p className="text-sm text-muted-foreground">
              {m.moderation_queue_resolved_at()}{' '}
              <time dateTime={resolution.resolvedAt}>{date(resolution.resolvedAt)}</time>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{m.moderation_appeal_resolution_pending()}</p>
          )}
          <AppealResolution
            appealId={appeal.id}
            mayResolve={appeal.canResolve === true}
            resolution={resolution}
            {...(isCurrent ? { isCurrent } : {})}
            {...(onUnresolvedChange ? { onUnresolvedChange } : {})}
          />
        </div>
      </ContentItemFrame>
    </article>
  );
}

function AppellantIdentity({ identity }: { identity: AppealAppellantIdentity | undefined }) {
  if (!identity || identity.state === 'unavailable') return <p>{m.moderation_appeal_appellant_unavailable()}</p>;
  if (identity.state === 'deleted') return <p>{m.moderation_appeal_appellant_deleted()}</p>;
  if (identity.state === 'concealed') return <p>{m.moderation_appeal_appellant_concealed()}</p>;
  const name = identity.displayName?.trim();
  const handle = identity.handle?.trim();
  return (
    <div className="space-y-1">
      <p className="wrap-anywhere">
        {name || handle ? (
          <>
            {name}
            {name && handle ? ' · ' : null}
            {handle ? `@${handle}` : null}
          </>
        ) : (
          m.moderation_appeal_appellant_unavailable()
        )}
      </p>
      {identity.automated ? <Badge variant="outline">{m.moderation_appeal_automated()}</Badge> : null}
    </div>
  );
}

function CurrentDestination({ context }: { context: AppealTargetContext | undefined }) {
  if (!context || context.state === 'unavailable') return <p>{m.moderation_target_unavailable()}</p>;
  if (context.state === 'concealed') return <p>{m.moderation_appeal_context_concealed()}</p>;
  const destination = context.destination;
  return (
    <div className="space-y-1 text-sm">
      <p className="wrap-anywhere">
        <Badge variant="outline">{targetKindLabel(destination.kind)}</Badge>{' '}
        <code className="break-all">{destination.id}</code>
      </p>
      {destination.kind === 'thread' ? (
        <p className="wrap-anywhere">
          {m.reporter_status_board()} <code className="break-all">{destination.boardId}</code>
        </p>
      ) : null}
    </div>
  );
}

function targetKindLabel(kind: 'board' | 'thread' | 'post') {
  return kind === 'board'
    ? m.reporter_status_board()
    : kind === 'thread'
      ? m.reporter_status_thread()
      : m.reporter_status_post();
}

export function WorkbenchAppealStatus({
  state,
  queueHref,
  onRetry,
  onRestart,
}: {
  state: 'denied' | 'unavailable' | 'stale' | 'empty';
  queueHref: string;
  onRetry?: (event?: MouseEvent<HTMLButtonElement>) => void;
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
          <Button
            className="h-auto min-h-11 max-w-full whitespace-normal break-words"
            variant="outline"
            onClick={onRestart}
          >
            {m.moderation_queue_restart()}
          </Button>
        ) : state === 'unavailable' && onRetry ? (
          <Button
            data-workbench-retry
            className="h-auto min-h-11 max-w-full whitespace-normal break-words"
            variant="outline"
            onClick={onRetry}
          >
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </ContentItemFrame>
    </article>
  );
}

export { workbenchAppealFromPage } from './read-model';
