import { useId, type MouseEvent, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { knowledgeRestoreExpired } from './lifecycle';
import type { KnowledgeLifecycleController } from './lifecycle-controller';

const control = 'h-auto min-h-7 max-w-full whitespace-normal break-words leading-snug';

export function KnowledgeLifecyclePanel({
  controller,
  blocked,
  showBlockedMessage = true,
  locale,
  operationAction = null,
  reviewTargetRef,
  reviewOpenerRef,
  onReview,
  onSubmit,
  onCancel,
}: {
  controller: KnowledgeLifecycleController;
  blocked: boolean;
  showBlockedMessage?: boolean;
  locale: string;
  operationAction?: 'trash' | 'restore' | null;
  reviewTargetRef?: RefObject<HTMLDivElement | null>;
  reviewOpenerRef?: RefObject<HTMLButtonElement | null>;
  onReview?: (event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore', blocked: boolean) => void;
  onSubmit?: (event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore', blocked: boolean) => void;
  onCancel?: (event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore') => void;
}) {
  const titleId = useId();
  const options = { locale: locale as never };
  if (!controller.enabled) return null;
  const { lifecycle, readState, commandState, intent } = controller;
  const observed = readState === 'ready' ? lifecycle : null;
  const trashed = observed?.state === 'trashed';
  const progress = observed?.restoreProgress;
  const expired = !!observed && knowledgeRestoreExpired(observed);
  const resultAction = intent?.action ?? operationAction ?? (trashed ? 'restore' : 'trash');
  const resultLabel =
    resultAction === 'trash' ? m.knowledge_lifecycle_trash({}, options) : m.knowledge_lifecycle_restore({}, options);
  const canAct =
    controller.actionAdmission === 'available' && !blocked && !expired && !progress && readState === 'ready';
  const failure =
    readState === 'not-found'
      ? m.knowledge_lifecycle_missing({}, options)
      : readState === 'denied'
        ? m.knowledge_private_denied({}, options)
        : readState !== 'ready' && readState !== 'preparing'
          ? m.knowledge_lifecycle_unavailable({}, options)
          : null;
  const heading = observed
    ? progress
      ? m.knowledge_lifecycle_restoring({}, options)
      : trashed
        ? m.knowledge_lifecycle_trashed({}, options)
        : m.knowledge_lifecycle_heading({}, options)
    : readState === 'preparing'
      ? m.knowledge_lifecycle_loading({}, options)
      : (failure ?? m.knowledge_lifecycle_unavailable({}, options));
  const resultState = ['pending', 'acknowledged', 'conflict', 'not-found'].includes(commandState)
    ? commandState
    : controller.unresolved
      ? commandState
      : null;
  const acknowledgedMessage =
    resultAction === 'trash' && readState !== 'ready'
      ? m.knowledge_lifecycle_trashed({}, options)
      : readState === 'ready' && observed
        ? progress
          ? m.knowledge_lifecycle_restore_running({}, options)
          : trashed
            ? m.knowledge_lifecycle_trashed({}, options)
            : m.knowledge_lifecycle_heading({}, options)
        : readState === 'preparing'
          ? m.knowledge_lifecycle_loading({}, options)
          : m.knowledge_lifecycle_unavailable({}, options);
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-lg font-semibold">
        {heading}
      </h2>
      {readState === 'preparing' ? <p role="status">{m.knowledge_lifecycle_loading({}, options)}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {readState === 'ready' && lifecycle ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_lifecycle_subtree_scope({}, options)}
          </p>
          {trashed ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{m.knowledge_lifecycle_hidden({}, options)}</p>
          ) : null}
          {progress ? (
            <div role="status" className="space-y-2">
              <p>{m.knowledge_lifecycle_restore_running({}, options)}</p>
              <p>
                {m.knowledge_lifecycle_restore_counts(
                  { processed: progress.processedDocuments, pending: progress.pendingPlacements },
                  options,
                )}
              </p>
            </div>
          ) : null}
          {trashed && observed?.restoreUntil ? (
            <p>
              {m.knowledge_lifecycle_window({}, options)}{' '}
              <time dateTime={observed.restoreUntil}>
                {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(
                  new Date(observed.restoreUntil),
                )}
              </time>
            </p>
          ) : null}
          {expired || commandState === 'expired' ? (
            <p role="status">{m.knowledge_lifecycle_expired({}, options)}</p>
          ) : null}
          {blocked && showBlockedMessage ? <p role="status">{m.knowledge_lifecycle_save_first({}, options)}</p> : null}
          {!progress && controller.actionAdmission !== 'available' ? (
            <p role="status">{m.knowledge_lifecycle_action_unavailable({}, options)}</p>
          ) : null}
          {intent && commandState === 'confirm' ? (
            <div
              ref={reviewTargetRef}
              tabIndex={-1}
              role="group"
              aria-label={
                intent.action === 'trash'
                  ? m.knowledge_lifecycle_confirm_trash({}, options)
                  : m.knowledge_lifecycle_confirm_restore({}, options)
              }
              className="space-y-3 border-t border-border pt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <p role="status">
                {intent.action === 'trash'
                  ? m.knowledge_lifecycle_confirm_trash({}, options)
                  : m.knowledge_lifecycle_confirm_restore({}, options)}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {m.knowledge_lifecycle_subtree_scope({}, options)}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant={intent.action === 'trash' ? 'destructive' : 'default'}
                  className={control}
                  disabled={!canAct}
                  onClick={(event) =>
                    onSubmit ? onSubmit(event, intent.action, blocked) : void controller.submit(blocked)
                  }
                >
                  {intent.action === 'trash'
                    ? m.knowledge_lifecycle_trash_confirm({}, options)
                    : m.knowledge_lifecycle_restore_confirm({}, options)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  onClick={(event) => (onCancel ? onCancel(event, intent.action) : controller.cancel())}
                >
                  {m.knowledge_lifecycle_cancel({}, options)}
                </Button>
              </div>
            </div>
          ) : !intent && !progress ? (
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={!canAct}
              ref={reviewOpenerRef}
              onClick={(event) =>
                onReview ? onReview(event, trashed ? 'restore' : 'trash', blocked) : controller.review(blocked)
              }
            >
              {trashed ? m.knowledge_lifecycle_restore({}, options) : m.knowledge_lifecycle_trash({}, options)}
            </Button>
          ) : null}
        </>
      ) : null}
      {resultState ? (
        <section className="space-y-3 border-t border-border pt-4" aria-labelledby={titleId + '-operation'}>
          <h3 id={titleId + '-operation'} className="font-medium">
            {resultLabel}
          </h3>
          {resultState === 'pending' ? (
            <p role="status" aria-label={`${resultLabel}: ${m.knowledge_lifecycle_pending({}, options)}`}>
              {m.knowledge_lifecycle_pending({}, options)}
            </p>
          ) : null}
          {resultState === 'acknowledged' ? (
            <p
              role="status"
              data-lifecycle-result="acknowledged"
              aria-label={`${resultLabel}: ${acknowledgedMessage} ✓`}
            >
              <span aria-hidden="true" className="mr-2">
                ✓
              </span>
              {acknowledgedMessage}
            </p>
          ) : null}
          {resultState === 'conflict' ? (
            <p role="alert" aria-label={`${resultLabel}: ${m.knowledge_lifecycle_conflict({}, options)}`}>
              {m.knowledge_lifecycle_conflict({}, options)}
            </p>
          ) : null}
          {resultState === 'not-found' ? (
            <p role="alert" aria-label={`${resultLabel}: ${m.knowledge_lifecycle_missing({}, options)}`}>
              {m.knowledge_lifecycle_missing({}, options)}
            </p>
          ) : null}
          {controller.unresolved && !controller.pending ? (
            <p role="alert" aria-label={`${resultLabel}: ${m.knowledge_lifecycle_uncertain({}, options)}`}>
              {m.knowledge_lifecycle_uncertain({}, options)}
            </p>
          ) : null}
          {controller.unresolved && !controller.pending ? (
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={blocked || controller.actionAdmission !== 'available'}
              onClick={(event) =>
                onSubmit ? onSubmit(event, intent!.action, blocked) : void controller.submit(blocked)
              }
            >
              {m.knowledge_private_retry_exact({}, options)}
            </Button>
          ) : null}
        </section>
      ) : null}
      {readState !== 'preparing' && (readState !== 'ready' || trashed) && !intent ? (
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={controller.pending}
          onClick={() => void controller.reread()}
        >
          {progress ? m.knowledge_lifecycle_refresh({}, options) : m.knowledge_lifecycle_reread({}, options)}
        </Button>
      ) : null}
    </section>
  );
}
