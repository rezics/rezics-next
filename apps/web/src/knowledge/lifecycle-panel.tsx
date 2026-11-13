import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { knowledgeRestoreExpired } from './lifecycle';
import type { KnowledgeLifecycleController } from './lifecycle-controller';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug';

export function KnowledgeLifecyclePanel({
  controller,
  blocked,
  locale,
}: {
  controller: KnowledgeLifecycleController;
  blocked: boolean;
  locale: string;
}) {
  const titleId = useId();
  const options = { locale: locale as never };
  if (!controller.enabled) return null;
  const { lifecycle, readState, commandState, intent } = controller;
  const trashed = lifecycle?.state === 'trashed';
  const progress = lifecycle?.restoreProgress;
  const expired = !!lifecycle && knowledgeRestoreExpired(lifecycle);
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
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-lg font-semibold">
        {progress
          ? m.knowledge_lifecycle_restoring({}, options)
          : trashed
            ? m.knowledge_lifecycle_trashed({}, options)
            : m.knowledge_lifecycle_heading({}, options)}
      </h2>
      {readState === 'preparing' ? <p role="status">{m.knowledge_lifecycle_loading({}, options)}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {readState === 'ready' && lifecycle ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {trashed ? m.knowledge_lifecycle_hidden({}, options) : m.knowledge_lifecycle_subtree_scope({}, options)}
          </p>
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
          {trashed && lifecycle.restoreUntil ? (
            <p>
              {m.knowledge_lifecycle_window({}, options)}{' '}
              <time dateTime={lifecycle.restoreUntil}>
                {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(
                  new Date(lifecycle.restoreUntil),
                )}
              </time>
            </p>
          ) : null}
          {expired || commandState === 'expired' ? (
            <p role="status">{m.knowledge_lifecycle_expired({}, options)}</p>
          ) : null}
          {blocked ? <p role="status">{m.knowledge_lifecycle_save_first({}, options)}</p> : null}
          {!progress && controller.actionAdmission !== 'available' ? (
            <p role="status">{m.knowledge_lifecycle_action_unavailable({}, options)}</p>
          ) : null}
          {intent && commandState === 'confirm' ? (
            <div className="space-y-3 border-t border-border pt-4">
              <p role="status">
                {intent.action === 'trash'
                  ? m.knowledge_lifecycle_confirm_trash({}, options)
                  : m.knowledge_lifecycle_confirm_restore({}, options)}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant={intent.action === 'trash' ? 'destructive' : 'default'}
                  className={control}
                  disabled={!canAct}
                  onClick={() => void controller.submit(blocked)}
                >
                  {intent.action === 'trash'
                    ? m.knowledge_lifecycle_trash_confirm({}, options)
                    : m.knowledge_lifecycle_restore_confirm({}, options)}
                </Button>
                <Button type="button" variant="outline" className={control} onClick={controller.cancel}>
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
              onClick={() => controller.review(blocked)}
            >
              {trashed ? m.knowledge_lifecycle_restore({}, options) : m.knowledge_lifecycle_trash({}, options)}
            </Button>
          ) : null}
        </>
      ) : null}
      {commandState === 'pending' ? <p role="status">{m.knowledge_lifecycle_pending({}, options)}</p> : null}
      {commandState === 'conflict' ? <p role="alert">{m.knowledge_lifecycle_conflict({}, options)}</p> : null}
      {commandState === 'not-found' ? <p role="alert">{m.knowledge_lifecycle_missing({}, options)}</p> : null}
      {controller.unresolved && !controller.pending ? (
        <div className="space-y-3">
          <p role="alert">{m.knowledge_lifecycle_uncertain({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={blocked || controller.actionAdmission !== 'available'}
            onClick={() => void controller.submit(blocked)}
          >
            {m.knowledge_private_retry_exact({}, options)}
          </Button>
        </div>
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
