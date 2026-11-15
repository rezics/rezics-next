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
  'h-auto min-h-7 max-w-full whitespace-normal text-start leading-snug [overflow-wrap:anywhere]';

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
  const presentationFocus = useRef<HTMLElement | null>(null);
  const destinationAction = (
    event: { detail: number; currentTarget: HTMLElement },
    action: () => void,
  ) => {
    presentationFocus.current = null;
    if (event.detail === 0 && document.activeElement === event.currentTarget && event.currentTarget.isConnected)
      presentationFocus.current = event.currentTarget;
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
  const scopePage =
    page?.kind === 'outline' && ['review', 'pending', 'uncertain', 'conflict'].includes(snapshot.copyState)
      ? page
      : null;
  const visiblePage =
    page && !locked && !snapshot.receipt && snapshot.copyState === 'choosing' ? page : null;
  const canReview = visiblePage?.kind === 'outline' && snapshot.navigationState === 'ready';
  useEffect(() => visit.connect(), [visit]);
  useEffect(() => {
    const cancelPresentation = () => {
      presentationFocus.current = null;
    };
    document.addEventListener('focusin', cancelPresentation, true);
    document.addEventListener('pointerdown', cancelPresentation, true);
    document.addEventListener('pointermove', cancelPresentation, true);
    document.addEventListener('keydown', cancelPresentation, true);
    window.addEventListener('pagehide', cancelPresentation);
    window.addEventListener('blur', cancelPresentation);
    return () => {
      document.removeEventListener('focusin', cancelPresentation, true);
      document.removeEventListener('pointerdown', cancelPresentation, true);
      document.removeEventListener('pointermove', cancelPresentation, true);
      document.removeEventListener('keydown', cancelPresentation, true);
      window.removeEventListener('pagehide', cancelPresentation);
      window.removeEventListener('blur', cancelPresentation);
    };
  }, []);
  useEffect(() => {
    if (blocked) visit.retire();
  }, [blocked, visit]);
  useLayoutEffect(() => {
    const requesting = presentationFocus.current;
    if (blocked || snapshot.retired) {
      presentationFocus.current = null;
      return;
    }
    const result = region.current;
    if (busy || !requesting || !result?.isConnected) return;
    const stillOwnsFocus = document.activeElement === requesting;
    const targetWasRemoved = !requesting.isConnected && document.activeElement === document.body;
    if (!stillOwnsFocus && !targetWasRemoved) {
      presentationFocus.current = null;
      return;
    }
    presentationFocus.current = null;
    result.focus({ preventScroll: true });
  }, [snapshot, busy, blocked]);
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
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]">
        <section className="min-w-0 space-y-4 rounded-md border border-border p-4 sm:p-5">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium">
              {source.representation === 'public'
                ? m.knowledge_transfer_public({}, options)
                : m.knowledge_transfer_authoring({}, options)}
            </p>
            <h3 className="break-words text-base font-semibold">{title}</h3>
            <dl className="text-sm">
              <dt className="font-medium">{m.knowledge_private_revision({}, options)}</dt>
              <dd>
                <bdi dir="ltr">{source.revisionId}</bdi>
              </dd>
            </dl>
          </div>
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
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {snapshot.exportState === 'preparing' ? m.knowledge_preparing({}, options) : null}
            {snapshot.exportState === 'saved' ? m.knowledge_transfer_download_requested({}, options) : null}
            {snapshot.exportState === 'save-failed' ? m.knowledge_transfer_save_failed({}, options) : null}
            {snapshot.exportState === 'unavailable' ? m.knowledge_unavailable({}, options) : null}
          </div>
        </section>
        {canCopy ? (
          <section
            ref={region}
            tabIndex={-1}
            aria-labelledby={`${heading}-destination`}
            aria-busy={busy}
            className="min-w-0 space-y-4 rounded-md border border-border p-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:p-5"
          >
            <div className="min-w-0 space-y-3">
              <h3 id={`${heading}-destination`} className="break-words font-semibold">
                {snapshot.notebook?.title ?? m.knowledge_transfer_choose_notebook({}, options)}
              </h3>
              {snapshot.notebook ? (
                <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="font-medium">{m.knowledge_private_notebook_id({}, options)}</dt>
                    <dd className="break-words">
                      <bdi dir="ltr">{snapshot.notebook.notebookId}</bdi>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-medium">{m.knowledge_private_destination_parent({}, options)}</dt>
                    <dd className="break-words">{parent?.title ?? m.knowledge_navigation_root({}, options)}</dd>
                  </div>
                </dl>
              ) : null}
              <p className="max-w-prose text-sm leading-relaxed">{m.knowledge_transfer_description({}, options)}</p>
            </div>
            {snapshot.copyState === 'idle' || (snapshot.copyState === 'unavailable' && !snapshot.receipt) ? (
              <Button
                type="button"
                className={control}
                onClick={(event) => destinationAction(event, () => void visit.openCopy())}
              >
                {m.knowledge_transfer_copy({}, options)}
              </Button>
            ) : null}
            {snapshot.copyState !== 'idle' ? (
              <>
                {snapshot.notebook && !locked && !snapshot.receipt ? (
                  <div className="flex min-w-0 flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className={control}
                      disabled={busy}
                      onClick={(event) => destinationAction(event, () => visit.owned())}
                    >
                      {m.knowledge_transfer_choose_notebook({}, options)}
                    </Button>
                    {parent ? (
                      <Button
                        type="button"
                        variant="outline"
                        className={control}
                        disabled={busy}
                        onClick={(event) => destinationAction(event, () => visit.up())}
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
                        onClick={(event) => destinationAction(event, () => visit.up(true))}
                      >
                        {m.knowledge_navigation_root({}, options)}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {canReview ? (
                  <Button
                    type="button"
                    className={control}
                    onClick={(event) => destinationAction(event, () => visit.review())}
                  >
                    {m.knowledge_transfer_review({}, options)}
                  </Button>
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
                      onClick={(event) =>
                        destinationAction(event, () =>
                          snapshot.navigationState === 'changed' ? visit.refresh() : visit.retryNavigation(),
                        )
                      }
                    >
                      {snapshot.navigationState === 'changed'
                        ? m.knowledge_transfer_refresh({}, options)
                        : m.knowledge_navigation_retry({}, options)}
                    </Button>
                  </div>
                ) : null}
                {visiblePage ? (
                  <>
                    <ul className="min-w-0 divide-y divide-border">
                      {visiblePage.kind === 'owned'
                        ? visiblePage.notebooks.map((row) => (
                            <li key={row.notebookId} className="py-2">
                              <Button
                                type="button"
                                variant="ghost"
                                className={control}
                                onClick={(event) => destinationAction(event, () => visit.chooseNotebook(row))}
                              >
                                {row.title}
                              </Button>
                            </li>
                          ))
                        : visiblePage.placements.map((row) => (
                            <li key={row.placementId} className="py-2">
                              <Button
                                type="button"
                                variant="ghost"
                                className={control}
                                onClick={(event) => destinationAction(event, () => visit.descend(row))}
                              >
                                {row.title}
                              </Button>
                            </li>
                          ))}
                    </ul>
                    {(visiblePage.kind === 'owned'
                      ? visiblePage.notebooks.length
                      : visiblePage.placements.length) === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {visiblePage.kind === 'owned'
                          ? m.knowledge_transfer_empty({}, options)
                          : m.knowledge_navigation_empty_outline({}, options)}
                      </p>
                    ) : null}
                    {visiblePage.next ? (
                      <Button
                        type="button"
                        variant="outline"
                        className={control}
                        disabled={busy}
                        onClick={(event) => destinationAction(event, () => visit.more())}
                      >
                        {m.knowledge_navigation_more({}, options)}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {scopePage ? (
                  <div className="space-y-3 border-t border-border pt-4">
                    <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="font-medium">{m.knowledge_private_notebook_id({}, options)}</dt>
                        <dd className="break-words">
                          <bdi dir="ltr">{scopePage.notebookId}</bdi>
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="font-medium">{m.knowledge_private_structure_revision({}, options)}</dt>
                        <dd className="break-words">
                          <bdi dir="ltr">{scopePage.structureRevisionId}</bdi>
                        </dd>
                      </div>
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="font-medium">{m.knowledge_private_destination_parent({}, options)}</dt>
                        <dd className="break-words">
                          {scopePage.parentPlacementId === null ? (
                            m.knowledge_navigation_root({}, options)
                          ) : (
                            <>
                              {parent?.title ?? m.knowledge_navigation_root({}, options)}{' '}
                              <bdi dir="ltr">{scopePage.parentPlacementId}</bdi>
                            </>
                          )}
                        </dd>
                      </div>
                    </dl>
                    {snapshot.copyState === 'review' ? (
                      <Button
                        type="button"
                        className={control}
                        onClick={(event) => destinationAction(event, () => visit.confirm())}
                      >
                        {m.knowledge_transfer_confirm({}, options)}
                      </Button>
                    ) : null}
                    {snapshot.copyState === 'uncertain' ? (
                      <div className="space-y-3">
                        <p role="status">{m.knowledge_transfer_uncertain({}, options)}</p>
                        <Button
                          type="button"
                          variant="outline"
                          className={control}
                          onClick={(event) => destinationAction(event, () => visit.retryCopy())}
                        >
                          {m.knowledge_private_retry_exact({}, options)}
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
                          onClick={(event) => destinationAction(event, () => visit.refresh())}
                        >
                          {m.knowledge_transfer_refresh({}, options)}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {snapshot.copyState === 'unavailable' && !snapshot.receipt ? (
                  <p role="status">{m.knowledge_unavailable({}, options)}</p>
                ) : null}
                {snapshot.receipt ? (
                  <div className="space-y-3 border-t border-border pt-4">
                    <p role="status">{m.knowledge_transfer_copied({}, options)}</p>
                    {snapshot.copyState === 'unavailable' ? (
                      <div className="space-y-3">
                        <p role="status">{m.knowledge_unavailable({}, options)}</p>
                        <Button
                          type="button"
                          variant="outline"
                          className={control}
                          onClick={(event) => destinationAction(event, () => void visit.readCopied())}
                        >
                          {m.knowledge_private_retry({}, options)}
                        </Button>
                      </div>
                    ) : null}
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
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}
