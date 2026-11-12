import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { KnowledgeTransferBinding, KnowledgeTransferSource } from './transfer';
import {
  KnowledgeTransferVisit,
  type KnowledgeTransferOperations,
  type KnowledgeTransferSaver,
} from './transfer-visit';

const control =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal px-4 py-2 text-start leading-snug [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The caller keys this entry by its complete reading lifetime, including source, session and locale. */
export function KnowledgeTransferEntry({
  source,
  title,
  locale,
  operations,
  binding = null,
  canExport = true,
  canCopy = true,
  blocked = false,
  saver,
  onSourceLost,
}: {
  source: KnowledgeTransferSource;
  title: string;
  locale: string;
  operations: KnowledgeTransferOperations;
  binding?: KnowledgeTransferBinding | null;
  canExport?: boolean;
  canCopy?: boolean;
  blocked?: boolean;
  saver?: KnowledgeTransferSaver;
  onSourceLost?: () => void;
}) {
  const [visit] = useState(() => new KnowledgeTransferVisit(source, operations, saver, binding, onSourceLost));
  const snapshot = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const heading = useId();
  const region = useRef<HTMLElement>(null);
  const pendingFocus = useRef<Element | null>(null);
  const destinationAction = (action: () => void) => {
    pendingFocus.current = document.activeElement;
    action();
  };
  const options = { locale: locale as never };
  const locked = ['preparing', 'pending', 'uncertain', 'readback', 'copied'].includes(snapshot.copyState);
  const busy =
    snapshot.navigationState === 'preparing' ||
    snapshot.copyState === 'preparing' ||
    snapshot.copyState === 'pending' ||
    snapshot.copyState === 'readback';
  const page = snapshot.page;
  const parent = snapshot.parents.at(-1);
  useEffect(() => visit.connect(), [visit]);
  useEffect(() => {
    if (blocked) visit.retire();
  }, [blocked, visit]);
  useLayoutEffect(() => {
    const requesting = pendingFocus.current;
    if (busy || !requesting || !region.current) return;
    if (
      document.activeElement === document.body ||
      document.activeElement === requesting ||
      region.current.contains(document.activeElement)
    )
      region.current.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [snapshot, busy]);
  if (blocked)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.knowledge_transfer_save_first({}, options)}
      </p>
    );
  if (snapshot.retired || (!canExport && !canCopy)) return null;
  return (
    <section
      aria-labelledby={heading}
      className="min-w-0 space-y-5 border-t border-border pt-6 [overflow-wrap:anywhere]"
    >
      <h2 id={heading} className="text-lg font-semibold">
        {m.knowledge_transfer_heading({}, options)}
      </h2>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-medium">
            {source.representation === 'public'
              ? m.knowledge_transfer_public({}, options)
              : m.knowledge_transfer_authoring({}, options)}
          </dt>
          <dd>{title}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium">{m.knowledge_private_revision({}, options)}</dt>
          <dd>
            <bdi dir="ltr">{source.revisionId}</bdi>
          </dd>
        </div>
      </dl>
      <div className="flex min-w-0 flex-wrap gap-3">
        {canExport ? (
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={snapshot.exportState === 'preparing'}
            onClick={() => void visit.exportFresh()}
          >
            {m.knowledge_transfer_export({}, options)}
          </Button>
        ) : null}
        {snapshot.exportState === 'saved' || snapshot.exportState === 'save-failed' ? (
          <Button type="button" variant="outline" className={control} onClick={() => visit.saveAgain()}>
            {m.knowledge_transfer_save_again({}, options)}
          </Button>
        ) : null}
        {canCopy && ['idle', 'unavailable'].includes(snapshot.copyState) && !snapshot.receipt ? (
          <Button
            type="button"
            className={control}
            onClick={() =>
              destinationAction(() => {
                void visit.openCopy();
              })
            }
          >
            {m.knowledge_transfer_copy({}, options)}
          </Button>
        ) : null}
      </div>
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {snapshot.exportState === 'preparing' ? m.knowledge_preparing({}, options) : null}
        {snapshot.exportState === 'saved' ? m.knowledge_transfer_download_requested({}, options) : null}
        {snapshot.exportState === 'save-failed' ? m.knowledge_transfer_save_failed({}, options) : null}
        {snapshot.exportState === 'unavailable' ? m.knowledge_unavailable({}, options) : null}
      </div>
      {snapshot.copyState !== 'idle' && canCopy ? (
        <section
          ref={region}
          tabIndex={-1}
          aria-label={m.knowledge_transfer_choose_notebook({}, options)}
          aria-busy={busy}
          className="min-w-0 space-y-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <p className="max-w-prose text-sm leading-relaxed">{m.knowledge_transfer_description({}, options)}</p>
          <h3 className="font-semibold">
            {snapshot.notebook?.title ?? m.knowledge_transfer_choose_notebook({}, options)}
          </h3>
          {snapshot.notebook ? (
            <p className="text-sm">{parent?.title ?? m.knowledge_navigation_root({}, options)}</p>
          ) : null}
          {snapshot.notebook && !locked ? (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                className={control}
                disabled={busy}
                onClick={() => destinationAction(() => visit.owned())}
              >
                {m.knowledge_transfer_choose_notebook({}, options)}
              </Button>
              {parent ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={busy}
                  onClick={() => destinationAction(() => visit.up())}
                >
                  {m.knowledge_private_return_destination({}, options)}
                </Button>
              ) : null}
              {parent ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={busy}
                  onClick={() => destinationAction(() => visit.up(true))}
                >
                  {m.knowledge_navigation_root({}, options)}
                </Button>
              ) : null}
            </div>
          ) : null}
          {busy ? <p role="status">{m.knowledge_preparing({}, options)}</p> : null}
          {snapshot.navigationState === 'unavailable' || snapshot.navigationState === 'changed' ? (
            <div className="space-y-3">
              <p role="status">
                {snapshot.navigationState === 'changed'
                  ? m.knowledge_transfer_structure_changed({}, options)
                  : m.knowledge_unavailable({}, options)}
              </p>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={() => (snapshot.navigationState === 'changed' ? visit.refresh() : visit.retryNavigation())}
              >
                {m.knowledge_navigation_retry({}, options)}
              </Button>
            </div>
          ) : null}
          {page && !locked ? (
            <>
              <ul className="min-w-0 divide-y divide-border">
                {page.kind === 'owned'
                  ? page.notebooks.map((row) => (
                      <li key={row.notebookId} className="py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          className={control}
                          onClick={() => destinationAction(() => visit.chooseNotebook(row))}
                        >
                          {row.title}
                        </Button>
                      </li>
                    ))
                  : page.placements.map((row) => (
                      <li key={row.placementId} className="py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          className={control}
                          onClick={() => destinationAction(() => visit.descend(row))}
                        >
                          {row.title}
                        </Button>
                      </li>
                    ))}
              </ul>
              {(page.kind === 'owned' ? page.notebooks.length : page.placements.length) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {page.kind === 'owned'
                    ? m.knowledge_transfer_empty({}, options)
                    : m.knowledge_navigation_empty_outline({}, options)}
                </p>
              ) : null}
              <div className="flex min-w-0 flex-wrap gap-3">
                {page.next ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={busy}
                    onClick={() => destinationAction(() => visit.more())}
                  >
                    {m.knowledge_navigation_more({}, options)}
                  </Button>
                ) : null}
                {page.kind === 'outline' && snapshot.copyState !== 'conflict' ? (
                  <Button type="button" variant="outline" className={control} onClick={() => visit.review()}>
                    {m.knowledge_transfer_review({}, options)}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          {snapshot.copyState === 'review' && page?.kind === 'outline' ? (
            <div className="space-y-3 border-t border-border pt-4">
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="font-medium">{m.knowledge_private_notebook_id({}, options)}</dt>
                  <dd>
                    <bdi dir="ltr">{page.notebookId}</bdi>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">{m.knowledge_private_structure_revision({}, options)}</dt>
                  <dd>
                    <bdi dir="ltr">{page.structureRevisionId}</bdi>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">{m.knowledge_private_destination_parent({}, options)}</dt>
                  <dd>{parent?.title ?? m.knowledge_navigation_root({}, options)}</dd>
                </div>
              </dl>
              <Button type="button" className={control} onClick={() => destinationAction(() => visit.confirm())}>
                {m.knowledge_transfer_confirm({}, options)}
              </Button>
            </div>
          ) : null}
          {snapshot.copyState === 'conflict' ? (
            <div className="space-y-3">
              <p role="status">{m.knowledge_transfer_structure_changed({}, options)}</p>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={() => destinationAction(() => visit.refresh())}
              >
                {m.knowledge_transfer_refresh({}, options)}
              </Button>
            </div>
          ) : null}
          {snapshot.copyState === 'uncertain' ? (
            <div className="space-y-3">
              <p role="status">{m.knowledge_transfer_uncertain({}, options)}</p>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={() => destinationAction(() => visit.retryCopy())}
              >
                {m.knowledge_private_retry_exact({}, options)}
              </Button>
            </div>
          ) : null}
          {snapshot.copyState === 'unavailable' ? (
            <div className="space-y-3">
              <p role="status">{m.knowledge_unavailable({}, options)}</p>
              {snapshot.receipt ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  onClick={() =>
                    destinationAction(() => {
                      void visit.readCopied();
                    })
                  }
                >
                  {m.knowledge_private_retry({}, options)}
                </Button>
              ) : null}
            </div>
          ) : null}
          {snapshot.copyState === 'copied' && snapshot.receipt ? (
            <div className="space-y-3">
              <p role="status">{m.knowledge_transfer_copied({}, options)}</p>
              <a
                href={`/${encodeURIComponent(locale)}/knowledge/notebooks/${snapshot.receipt.notebookId}/documents/${snapshot.receipt.documentId}`}
                className={buttonVariants({ className: control })}
                onClick={(event) => {
                  if (!operations.current()) {
                    event.preventDefault();
                    visit.retire();
                  }
                }}
              >
                {m.knowledge_transfer_open({}, options)}
              </a>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
