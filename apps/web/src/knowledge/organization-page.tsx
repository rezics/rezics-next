import { KnowledgeDetails } from './workspace';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';
import type { KnowledgeNavigationFrontier } from './navigation-model';
import type { KnowledgeNavigationReturn, KnowledgeNavigationRestoration } from './navigation-return';
import { useKnowledgeNavigationOrientation } from './navigation-focus';
import { knowledgeNavigationControl as control, knowledgeNavigationLink as link } from './navigation-return-link';
import { KnowledgeOrganizationReading } from './organization-model';
import type { OrganizationOperations } from './organization-read';
import { organizationCopy } from './organization-copy';

type Operations = {
  current?: (() => boolean) | undefined;
  subscribeRetirement?: ((retire: () => void) => () => void) | undefined;
};
export function KnowledgeOrganizationOwner({
  frontier,
  expired,
  locale,
  binding,
  operations,
  returning,
  restored,
  embedded,
  selectedDocumentId,
  current,
  subscribeRetirement,
}: {
  frontier: KnowledgeNavigationFrontier;
  expired: boolean;
  locale: string;
  binding: string;
  operations: OrganizationOperations;
  returning?: KnowledgeNavigationReturn | undefined;
  restored?: KnowledgeNavigationRestoration | undefined;
  embedded?: boolean | undefined;
  selectedDocumentId?: string | undefined;
} & Operations) {
  const [reading, setReading] = useState<KnowledgeOrganizationReading>();
  useLayoutEffect(() => {
    const reading = new KnowledgeOrganizationReading(operations, frontier, expired, current);
    const stop = subscribeRetirement?.(() => reading.retire());
    setReading(reading);
    if (!expired)
      queueMicrotask(() => {
        void reading.open();
      });
    return () => {
      stop?.();
      reading.retire();
    };
  }, [operations, frontier, expired, current, subscribeRetirement]);
  return reading ? (
    <KnowledgeOrganizationPage
      reading={reading}
      locale={locale}
      binding={binding}
      returning={returning}
      restored={restored}
      embedded={embedded}
      selectedDocumentId={selectedDocumentId}
    />
  ) : (
    <p role="status">{m.knowledge_navigation_preparing({}, { locale: locale as never })}</p>
  );
}

/** Shares the existing exact editor link and return slot; placement movement never changes document identity. */
export function KnowledgeOrganizationPage({
  embedded,
  selectedDocumentId,
  restored,
  reading,
  locale,
  binding,
  returning,
}: {
  reading: KnowledgeOrganizationReading;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn | undefined;
  restored?: KnowledgeNavigationRestoration | undefined;
  embedded?: boolean | undefined;
  selectedDocumentId?: string | undefined;
}) {
  const snapshot = useSyncExternalStore(reading.subscribe, reading.getSnapshot, reading.getSnapshot);
  const options = { locale: locale as never };
  const copy = organizationCopy(locale);
  const root = m.knowledge_navigation_root({}, options);
  const actions = reading.actions(snapshot, root);
  const documentId = selectedDocumentId ?? restored?.documentId;
  const { boundary, selected, activate } = useKnowledgeNavigationOrientation(snapshot, reading.getSnapshot, {
    restored,
    embedded,
    selectedDocumentId: documentId,
  });
  const { page, frontier, command } = snapshot;
  const historical = frontier.request.kind === 'historical';
  const history = frontier.request.kind === 'history';
  const busy = snapshot.state === 'preparing' || command === 'preparing' || command === 'sending';
  const locked = command !== 'idle';
  const review = snapshot.review ?? snapshot.previous;
  const showRows = snapshot.state === 'ready' && command === 'idle' && page;
  const notebookId = page?.notebookId ?? frontier.request.notebookId;
  const parentPlacementId = frontier.request.kind === 'history' ? null : frontier.request.parentPlacementId;
  const parentTitle = frontier.breadcrumbs.at(-1)?.title ?? root;
  const sourceParentPlacementId = (source: NonNullable<typeof snapshot.source>) =>
    source.frontier.request.kind === 'history' ? null : source.frontier.request.parentPlacementId;
  const sourceParentTitle = (source: NonNullable<typeof snapshot.source>) =>
    source.frontier.breadcrumbs.at(-1)?.title ?? root;
  const reviewDestinationPlacementId = review
    ? review.intent.destinationParentPlacementId
    : parentPlacementId;
  const reviewOrder = review?.before ? `${copy.before}: ${review.before}` : copy.end;
  const remember = (documentId: string) => {
    if (snapshot !== reading.getSnapshot() || page?.kind !== 'outline' || frontier.request.kind !== 'outline') return;
    returning?.save(binding, { notebookId: page.notebookId, documentId }, { ...frontier, request: frontier.request });
  };
  return (
    <section
      ref={boundary}
      tabIndex={-1}
      aria-busy={busy}
      aria-label={m.knowledge_navigation_reading({}, options)}
      className="min-w-0 space-y-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <nav
        aria-label={m.knowledge_navigation_breadcrumbs({}, options)}
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-4"
      >
        <Link to="/knowledge" preload={false} className={link}>
          {m.knowledge_navigation_heading({}, options)}
        </Link>
        {!history && (
          <Button
            variant="ghost"
            className={control}
            disabled={busy || locked}
            onClick={(event) => activate(event, actions.root)}
          >
            {root}
          </Button>
        )}
        {!history &&
          frontier.breadcrumbs.map((crumb, index) => (
            <Button
              key={crumb.placementId}
              variant="ghost"
              className={control}
              disabled={busy || locked || snapshot.state !== 'ready'}
              aria-current={index === frontier.breadcrumbs.length - 1 ? 'location' : undefined}
              onClick={(event) => activate(event, () => actions.ancestor(index))}
            >
              {crumb.title}
            </Button>
          ))}
      </nav>
      {history || historical ? (
        <section aria-labelledby="knowledge-organization-structure-heading" className="min-w-0 space-y-4">
          <h2 id="knowledge-organization-structure-heading" className="text-lg font-semibold">
            {history ? copy.history : copy.historical}
          </h2>
          {historical && frontier.request.kind === 'historical' && (
            <p className="text-sm text-muted-foreground">
              {copy.revision}: <span className="break-all font-mono">{frontier.request.revisionId}</span>
            </p>
          )}
          {historical && (
            <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">{copy.parent}</dt>
              <dd className="min-w-0 break-words">
                {parentTitle}
                {parentPlacementId && <span className="ml-2 break-all font-mono text-xs">{parentPlacementId}</span>}
              </dd>
            </dl>
          )}
          <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
            <p className="break-all font-mono text-xs">{notebookId}</p>
          </KnowledgeDetails>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className={control}
              disabled={busy}
              onClick={(event) => activate(event, () => actions.current())}
            >
              {copy.parent}
            </Button>
            <Button
              variant="outline"
              className={control}
              disabled={busy}
              onClick={(event) => activate(event, () => actions.current(true))}
            >
              {copy.current}
            </Button>
            {historical && (
              <Button
                variant="outline"
                className={control}
                disabled={busy}
                onClick={(event) => activate(event, actions.history)}
              >
                {copy.history}
              </Button>
            )}
          </div>
        </section>
      ) : (
        <section aria-labelledby="knowledge-organization-current-heading" className="min-w-0 space-y-4">
          <h2 id="knowledge-organization-current-heading" className="text-lg font-semibold">
            {copy.current}
          </h2>
          <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{copy.parent}</dt>
            <dd className="min-w-0 break-words">
              {parentTitle}
              {parentPlacementId && <span className="ml-2 break-all font-mono text-xs">{parentPlacementId}</span>}
            </dd>
          </dl>
          <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
            <p className="break-all font-mono text-xs">{notebookId}</p>
          </KnowledgeDetails>
          {snapshot.source && (command === 'idle' || command === 'preparing') && (
            <div className="min-w-0 space-y-3 border-t border-border pt-4">
              <h3 className="break-words text-base font-semibold">
                {copy.selected}: {snapshot.source.row.title}
              </h3>
              <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">{copy.source}</dt>
                <dd className="break-all font-mono text-xs">{snapshot.source.row.placementId}</dd>
                <dt className="text-muted-foreground">{copy.parent}</dt>
                <dd className="min-w-0 break-words">
                  {sourceParentTitle(snapshot.source)}
                  {sourceParentPlacementId(snapshot.source) && (
                    <span className="ml-2 break-all font-mono text-xs">
                      {sourceParentPlacementId(snapshot.source)}
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">{copy.destination}</dt>
                <dd className="min-w-0 break-words">
                  {parentTitle}
                  {parentPlacementId && <span className="ml-2 break-all font-mono text-xs">{parentPlacementId}</span>}
                </dd>
              </dl>
              {command === 'preparing' && <p role="status">{copy.preparing}</p>}
              {command === 'idle' && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className={control} onClick={actions.cancel}>
                    {copy.cancel}
                  </Button>
                  {snapshot.state === 'ready' && page?.kind === 'outline' && (
                    <Button className={control} onClick={() => actions.review(null)}>
                      {copy.end}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {page?.kind === 'outline' && !snapshot.source && command === 'idle' && (
            <Button
              variant="outline"
              className={control}
              disabled={busy || locked}
              onClick={(event) => activate(event, actions.history)}
            >
              {copy.history}
            </Button>
          )}
        </section>
      )}
      {review && (
        <section aria-labelledby="knowledge-organization-review-heading" className="min-w-0 space-y-4">
          <h2 id="knowledge-organization-review-heading" className="text-lg font-semibold">
            {copy.review}
          </h2>
          <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{copy.source}</dt>
            <dd className="min-w-0 break-words">
              {review.source.row.title}
              <span className="ml-2 break-all font-mono text-xs">{review.source.row.placementId}</span>
            </dd>
            <dt className="text-muted-foreground">{copy.parent}</dt>
            <dd className="min-w-0 break-words">
              {sourceParentTitle(review.source)}
              {sourceParentPlacementId(review.source) && (
                <span className="ml-2 break-all font-mono text-xs">
                  {sourceParentPlacementId(review.source)}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">{copy.destination}</dt>
            <dd className="min-w-0 break-words">
              {review.destination}
              {reviewDestinationPlacementId && (
                <span className="ml-2 break-all font-mono text-xs">{reviewDestinationPlacementId}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">{copy.order}</dt>
            <dd className="min-w-0 break-words">
              {reviewOrder}
              {review.intent.beforePlacementId && (
                <span className="ml-2 break-all font-mono text-xs">{review.intent.beforePlacementId}</span>
              )}
            </dd>
          </dl>
          <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
            <p className="break-all font-mono text-xs">{review.intent.notebookId}</p>
          </KnowledgeDetails>
          {command === 'review' && (
            <div className="flex flex-wrap gap-2">
              <Button className={control} onClick={actions.confirm}>
                {copy.confirm}
              </Button>
              <Button variant="outline" className={control} onClick={actions.cancel}>
                {copy.cancel}
              </Button>
            </div>
          )}
          {command === 'sending' && <p role="status">{copy.sending}</p>}
          {command === 'uncertain' && (
            <div role="alert" className="space-y-3">
              <p>{copy.uncertain}</p>
              <Button className={control} onClick={actions.confirm}>
                {copy.retry_move}
              </Button>
            </div>
          )}
          {(command === 'conflict' || command === 'rejected' || command === 'unavailable') && (
            <div role="alert" className="space-y-3">
              <p>
                {command === 'conflict'
                  ? copy.changed
                  : command === 'rejected'
                    ? copy.rejected
                    : m.knowledge_navigation_unavailable({}, options)}
              </p>
              <Button className={control} onClick={(event) => activate(event, actions.restart)}>
                {copy.reselect}
              </Button>
            </div>
          )}
        </section>
      )}
      {snapshot.receipt && !history && !historical && (
        <section aria-labelledby="knowledge-organization-moved-heading" className="min-w-0 space-y-3" role="status">
          <h2 id="knowledge-organization-moved-heading" className="text-lg font-semibold">
            {copy.moved}
          </h2>
          <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{copy.receipt}</dt>
            <dd className="break-all font-mono text-xs">{snapshot.receipt.structureRevisionId}</dd>
            <dt className="text-muted-foreground">{copy.source}</dt>
            <dd className="break-all font-mono text-xs">{snapshot.receipt.placementId}</dd>
          </dl>
          <p className="max-w-prose text-sm text-muted-foreground">{copy.readback_note}</p>
          {command === 'acknowledged' && (
            <div className="flex flex-wrap gap-2">
              <Button className={control} onClick={(event) => activate(event, () => actions.current())}>
                {copy.parent}
              </Button>
              <Button
                variant="outline"
                className={control}
                onClick={(event) => activate(event, () => actions.current(true))}
              >
                {copy.current}
              </Button>
            </div>
          )}
        </section>
      )}
      {command === 'preparing' && !snapshot.source && <p role="status">{copy.preparing}</p>}
      {snapshot.state === 'preparing' || snapshot.state === 'retired' ? (
        <p role="status">{m.knowledge_navigation_preparing({}, options)}</p>
      ) : snapshot.state !== 'ready' && !locked ? (
        <div role="alert" className="space-y-3">
          <p>
            {snapshot.state === 'changed'
              ? m.knowledge_navigation_changed({}, options)
              : snapshot.state === 'denied'
                ? m.knowledge_navigation_denied({}, options)
                : snapshot.state === 'signed-out'
                  ? m.knowledge_navigation_signed_out({}, options)
                  : m.knowledge_navigation_unavailable({}, options)}
          </p>
          {snapshot.state === 'unavailable' && (
            <Button className={control} onClick={(event) => activate(event, actions.retry)}>
              {m.knowledge_navigation_retry({}, options)}
            </Button>
          )}
          {snapshot.state === 'changed' && (
            <Button className={control} onClick={(event) => activate(event, actions.restart)}>
              {m.knowledge_navigation_restart({}, options)}
            </Button>
          )}
        </div>
      ) : null}
      {showRows && (
        <>
          {(page.kind === 'history' ? page.revisions.length : page.placements.length) === 0 && (
            <p role="status">
              {page.next
                ? m.knowledge_navigation_sparse({}, options)
                : page.kind === 'history'
                  ? copy.empty_history
                  : m.knowledge_navigation_empty_outline({}, options)}
            </p>
          )}
          {page.kind === 'history' ? (
            <ol className="min-w-0 divide-y divide-border">
              {page.revisions.map((row) => (
                <li key={row.structureRevisionId} className="min-w-0 space-y-3 py-4">
                  <h3 className="font-semibold">
                    {copy.revision} {row.revisionNumber}:{' '}
                    {
                      copy[
                        row.changeKind === 'placement_added'
                          ? 'added'
                          : row.changeKind === 'placement_moved'
                            ? 'moved_kind'
                            : row.changeKind === 'placement_reordered'
                              ? 'reordered'
                              : row.changeKind
                      ]
                    }
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={row.createdAt}>
                      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                        new Date(row.createdAt),
                      )}
                    </time>
                  </p>
                  <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
                    {row.changes.map((change) => (
                      <div key={change.placementId} className="space-y-2 py-2">
                        <h4 className="font-medium">
                          {change.action === 'placement_added'
                            ? copy.added
                            : change.action === 'placement_moved'
                              ? copy.moved_kind
                              : copy.reordered}
                        </h4>
                        <dl className="grid min-w-0 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                          <dt className="text-muted-foreground">{copy.source}</dt>
                          <dd className="break-all font-mono text-xs">{change.placementId}</dd>
                          <dt className="text-muted-foreground">{copy.parent}</dt>
                          <dd className="break-all font-mono text-xs">
                            {change.previousParentPlacementId ?? root}
                          </dd>
                          <dt className="text-muted-foreground">{copy.destination}</dt>
                          <dd className="break-all font-mono text-xs">{change.parentPlacementId ?? root}</dd>
                          <dt className="text-muted-foreground">{copy.order}</dt>
                          <dd className="break-all font-mono text-xs">
                            {change.previousPosition ?? '—'} / {change.position}
                          </dd>
                        </dl>
                      </div>
                    ))}
                  </KnowledgeDetails>
                  {row.historyAvailable ? (
                    <Button
                      variant="outline"
                      className={control}
                      onClick={(event) => activate(event, () => actions.historical(row.structureRevisionId))}
                    >
                      {copy.historical}: {row.revisionNumber}
                    </Button>
                  ) : (
                    <p>{copy.history_unavailable}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <ul className="min-w-0 divide-y divide-border">
              {page.placements.map((row) => (
                <ListRow
                  key={row.placementId}
                  className="@container/content-item min-w-0 py-3 sm:py-4"
                >
                  <div className="min-w-0 wrap-anywhere @min-[40rem]/content-item:grid @min-[40rem]/content-item:grid-cols-[minmax(0,1fr)_fit-content(40%)] @min-[40rem]/content-item:items-start @min-[40rem]/content-item:gap-x-4">
                    <div className="min-w-0">
                      <div
                        data-content-item-slot="context"
                        className="mb-2 min-w-0 space-y-1 whitespace-normal text-sm leading-snug text-muted-foreground"
                      >
                        <p className="min-w-0 break-words">
                          <span className="text-muted-foreground">
                            {page.kind === 'outline' ? copy.destination : copy.parent}:
                          </span>{' '}
                          {parentTitle}
                          {parentPlacementId && (
                            <span className="ml-2 break-all font-mono text-xs">{parentPlacementId}</span>
                          )}
                        </p>
                        {snapshot.source && page.kind === 'outline' && (
                          <p className="min-w-0 break-words">
                            <span className="text-muted-foreground">{copy.selected}:</span>{' '}
                            {snapshot.source.row.title}
                            <span className="ml-2 break-all font-mono text-xs">
                              {snapshot.source.row.placementId}
                            </span>
                          </p>
                        )}
                      </div>
                      <ContentItemHeading
                        level={3}
                        className="whitespace-normal text-[17px] leading-snug font-semibold wrap-anywhere sm:text-lg md:text-xl"
                      >
                        <Link
                          to="/knowledge/notebooks/$notebookId/documents/$documentId"
                          params={{ notebookId: page.notebookId, documentId: row.documentId }}
                          preload={false}
                          className={link}
                          ref={row.documentId === documentId ? selected : undefined}
                          aria-current={row.documentId === documentId ? 'page' : undefined}
                          onClick={(event) => {
                            if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
                              remember(row.documentId);
                          }}
                        >
                          <span className="sr-only">{m.knowledge_navigation_open_document({}, options)}: </span>
                          {row.title}
                        </Link>
                      </ContentItemHeading>
                      <p data-content-item-slot="metadata" className="mt-2 break-all text-xs text-muted-foreground">
                        <span>{copy.source}:</span>{' '}
                        <span className="font-mono">{row.placementId}</span>
                      </p>
                    </div>
                    <ListRowControl
                      data-content-item-slot="actions"
                      className="mt-3 flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]/content-item:col-start-2 @min-[40rem]/content-item:row-start-1 @min-[40rem]/content-item:mt-0 @min-[40rem]/content-item:justify-end"
                    >
                      <Button
                        variant="outline"
                        className={control}
                        disabled={frontier.breadcrumbs.length >= 32}
                        onClick={(event) => activate(event, () => actions.children(row))}
                      >
                        {m.knowledge_navigation_children({}, options)}
                        <span className="sr-only">: {row.title}</span>
                      </Button>
                      {page.kind === 'outline' && !snapshot.source && (
                        <Button variant="outline" className={control} onClick={() => actions.source(row)}>
                          {copy.choose}
                          <span className="sr-only">: {row.title}</span>
                        </Button>
                      )}
                      {page.kind === 'outline' && snapshot.source && (
                        <Button
                          variant="outline"
                          className={control}
                          disabled={snapshot.source.row.placementId === row.placementId}
                          onClick={() => actions.review(row)}
                        >
                          {copy.before}
                          <span className="sr-only">: {row.title}</span>
                        </Button>
                      )}
                    </ListRowControl>
                  </div>
                </ListRow>
              ))}
            </ul>
          )}
          {page.next && (
            <Button variant="outline" className={control} onClick={(event) => activate(event, actions.more)}>
              {m.knowledge_navigation_more({}, options)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
