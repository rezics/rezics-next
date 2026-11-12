import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { knowledgeRestoreExpired } from './lifecycle';
import type { KnowledgeLifecycleController } from './lifecycle-controller';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug';

export function KnowledgeLifecyclePanel({ controller, blocked, locale }: {
  controller: KnowledgeLifecycleController;
  blocked: boolean;
  locale: string;
}) {
  const titleId = useId();
  const options = { locale: locale as never };
  if (!controller.enabled) return null;
  const { lifecycle, readState, commandState, intent } = controller;
  const trashed = lifecycle?.state === 'trashed';
  const expired = !!lifecycle && knowledgeRestoreExpired(lifecycle);
  const canAct = controller.actionAdmission === 'available' && !blocked && !expired && readState === 'ready';
  const failure = readState === 'not-found' ? m.knowledge_lifecycle_missing({}, options)
    : readState === 'denied' ? m.knowledge_private_denied({}, options)
    : readState !== 'ready' && readState !== 'preparing' ? m.knowledge_lifecycle_unavailable({}, options)
    : null;
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-lg font-semibold">
        {trashed ? m.knowledge_lifecycle_trashed({}, options) : m.knowledge_lifecycle_heading({}, options)}
      </h2>
      {readState === 'preparing' ? <p role="status">{m.knowledge_lifecycle_loading({}, options)}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {readState === 'ready' && lifecycle ? <>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {trashed ? m.knowledge_lifecycle_hidden({}, options) : m.knowledge_lifecycle_leaf({}, options)}
        </p>
        {trashed && lifecycle.restoreUntil ? <p>
          {m.knowledge_lifecycle_window({}, options)}{' '}
          <time dateTime={lifecycle.restoreUntil}>
            {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(lifecycle.restoreUntil))}
          </time>
        </p> : null}
        {expired || commandState === 'expired' ? <p role="status">{m.knowledge_lifecycle_expired({}, options)}</p> : null}
        {blocked ? <p role="status">{m.knowledge_lifecycle_save_first({}, options)}</p> : null}
        {controller.actionAdmission !== 'available' ? <p role="status">{m.knowledge_lifecycle_action_unavailable({}, options)}</p> : null}
        {intent && commandState === 'confirm' ? <div className="space-y-3 border-t border-border pt-4">
          <p role="status">{intent.action === 'trash' ? m.knowledge_lifecycle_confirm_trash({}, options) : m.knowledge_lifecycle_confirm_restore({}, options)}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant={intent.action === 'trash' ? 'destructive' : 'default'} className={control} disabled={!canAct} onClick={() => void controller.submit(blocked)}>
              {intent.action === 'trash' ? m.knowledge_lifecycle_trash_confirm({}, options) : m.knowledge_lifecycle_restore_confirm({}, options)}
            </Button>
            <Button type="button" variant="outline" className={control} onClick={controller.cancel}>{m.knowledge_lifecycle_cancel({}, options)}</Button>
          </div>
        </div> : !intent ? <Button type="button" variant="outline" className={control} disabled={!canAct} onClick={() => controller.review(blocked)}>
          {trashed ? m.knowledge_lifecycle_restore({}, options) : m.knowledge_lifecycle_trash({}, options)}
        </Button> : null}
      </> : null}
      {commandState === 'pending' ? <p role="status">{m.knowledge_lifecycle_pending({}, options)}</p> : null}
      {commandState === 'subtree' ? <p role="status">{m.knowledge_lifecycle_subtree({}, options)}</p> : null}
      {commandState === 'conflict' ? <p role="alert">{m.knowledge_lifecycle_conflict({}, options)}</p> : null}
      {commandState === 'not-found' ? <p role="alert">{m.knowledge_lifecycle_missing({}, options)}</p> : null}
      {controller.unresolved && !controller.pending ? <div className="space-y-3">
        <p role="alert">{m.knowledge_lifecycle_uncertain({}, options)}</p>
        <Button type="button" variant="outline" className={control} disabled={blocked || controller.actionAdmission !== 'available'} onClick={() => void controller.submit(blocked)}>
          {m.knowledge_private_retry_exact({}, options)}
        </Button>
      </div> : null}
      {readState !== 'ready' && readState !== 'preparing' && !controller.unresolved ? <Button type="button" variant="outline" className={control} onClick={() => void controller.reread()}>
        {m.knowledge_lifecycle_reread({}, options)}
      </Button> : null}
    </section>
  );
}
