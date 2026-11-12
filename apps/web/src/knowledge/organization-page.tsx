import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { KnowledgeNavigationFrontier } from './navigation-model';
import type { KnowledgeNavigationReturn } from './navigation-return';
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
  current,
  subscribeRetirement,
}: {
  frontier: KnowledgeNavigationFrontier;
  expired: boolean;
  locale: string;
  binding: string;
  operations: OrganizationOperations;
  returning?: KnowledgeNavigationReturn | undefined;
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
    <KnowledgeOrganizationPage reading={reading} locale={locale} binding={binding} returning={returning} />
  ) : (
    <p role="status">{m.knowledge_navigation_preparing({}, { locale: locale as never })}</p>
  );
}

/** Shares the existing exact editor link and return slot; placement movement never changes document identity. */
export function KnowledgeOrganizationPage({
  reading,
  locale,
  binding,
  returning,
}: {
  reading: KnowledgeOrganizationReading;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn | undefined;
}) {
  const snapshot = useSyncExternalStore(reading.subscribe, reading.getSnapshot, reading.getSnapshot);
  const options = { locale: locale as never };
  const copy = organizationCopy(locale);
  const root = m.knowledge_navigation_root({}, options);
  const actions = reading.actions(snapshot, root);
  const focus = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (
      snapshot.state === 'preparing' ||
      snapshot.state === 'retired' ||
      snapshot.command === 'preparing' ||
      snapshot.command === 'sending'
    )
      return;
    const active = document.activeElement;
    if (active === document.body || (active && focus.current?.contains(active)))
      focus.current?.focus({ preventScroll: true });
  }, [snapshot]);
  const { page, frontier, command } = snapshot;
  const historical = frontier.request.kind === 'historical';
  const history = frontier.request.kind === 'history';
  const busy = snapshot.state === 'preparing' || command === 'preparing' || command === 'sending';
  const locked = command !== 'idle';
  const review = snapshot.review ?? snapshot.previous;
  const showRows = snapshot.state === 'ready' && command === 'idle' && page;
  const remember = (documentId: string) => {
    if (snapshot !== reading.getSnapshot() || page?.kind !== 'outline' || frontier.request.kind !== 'outline') return;
    returning?.save(binding, { notebookId: page.notebookId, documentId }, { ...frontier, request: frontier.request });
  };
  return (
    <section
      ref={focus}
      tabIndex={-1}
      aria-busy={busy}
      aria-label={m.knowledge_navigation_reading({}, options)}
      className="min-w-0 space-y-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <nav
        aria-label={m.knowledge_navigation_breadcrumbs({}, options)}
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
      >
        <Link to="/knowledge" preload={false} className={link}>
          {m.knowledge_navigation_heading({}, options)}
        </Link>
        {!history && (
          <Button variant="ghost" className={control} disabled={busy || locked} onClick={actions.root}>
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
              onClick={() => actions.ancestor(index)}
            >
              {crumb.title}
            </Button>
          ))}
        {!historical && !history && (
          <Button variant="outline" className={control} disabled={busy || locked} onClick={actions.history}>
            {copy.history}
          </Button>
        )}
      </nav>
      {(historical || history) && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">{history ? copy.history : copy.historical}</h2>
          {historical && frontier.request.kind === 'historical' && (
            <p className="text-sm text-muted-foreground">
              {copy.revision}: {frontier.request.revisionId}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className={control} disabled={busy} onClick={() => actions.current(true)}>
              {copy.current}
            </Button>
            <Button variant="outline" className={control} disabled={busy} onClick={() => actions.current()}>
              {copy.parent}
            </Button>
          </div>
        </div>
      )}
      {snapshot.source && command === 'idle' && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            {copy.selected}: {snapshot.source.row.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {copy.destination}: {frontier.breadcrumbs.at(-1)?.title ?? root}
          </p>
          <Button variant="outline" className={control} onClick={actions.cancel}>
            {copy.cancel}
          </Button>
        </div>
      )}
      {review && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{copy.review}</h2>
          <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{copy.source}</dt>
            <dd>{review.source.row.title}</dd>
            <dt className="text-muted-foreground">{copy.destination}</dt>
            <dd>{review.destination}</dd>
            <dt className="text-muted-foreground">{copy.order}</dt>
            <dd>{review.before ? `${copy.before}: ${review.before}` : copy.end}</dd>
          </dl>
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
        </div>
      )}
      {command === 'preparing' || command === 'sending' ? (
        <p role="status">{command === 'sending' ? copy.sending : copy.preparing}</p>
      ) : null}
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
          <Button className={control} onClick={actions.restart}>
            {copy.reselect}
          </Button>
        </div>
      )}
      {snapshot.receipt && (
        <div className="space-y-3" role="status">
          <h2 className="text-lg font-semibold">{copy.moved}</h2>
          <p className="text-sm">
            {copy.receipt}: <span className="tabular-nums">{snapshot.receipt.structureRevisionId}</span>
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">{copy.readback_note}</p>
          {command === 'acknowledged' && (
            <div className="flex flex-wrap gap-2">
              <Button className={control} onClick={() => actions.current()}>
                {copy.parent}
              </Button>
              <Button variant="outline" className={control} onClick={() => actions.current(true)}>
                {copy.current}
              </Button>
            </div>
          )}
        </div>
      )}
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
            <Button className={control} onClick={actions.retry}>
              {m.knowledge_navigation_retry({}, options)}
            </Button>
          )}
          {snapshot.state === 'changed' && (
            <Button className={control} onClick={actions.restart}>
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
                  {row.changes.map((change) => (
                    <dl
                      key={change.placementId}
                      className="grid min-w-0 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]"
                    >
                      <dt className="text-muted-foreground">{copy.source}</dt>
                      <dd>{change.placementId}</dd>
                      <dt className="text-muted-foreground">{copy.parent}</dt>
                      <dd>{change.previousParentPlacementId ?? root}</dd>
                      <dt className="text-muted-foreground">{copy.destination}</dt>
                      <dd>{change.parentPlacementId ?? root}</dd>
                      <dt className="text-muted-foreground">{copy.order}</dt>
                      <dd className="tabular-nums">
                        {change.previousPosition ?? '—'} / {change.position}
                      </dd>
                    </dl>
                  ))}
                  {row.historyAvailable ? (
                    <Button
                      variant="outline"
                      className={control}
                      onClick={() => actions.historical(row.structureRevisionId)}
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
                <li key={row.placementId} className="min-w-0 space-y-3 py-4">
                  <h3 className="font-semibold leading-snug">{row.title}</h3>
                  <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">
                    <Link
                      to="/knowledge/notebooks/$notebookId/documents/$documentId"
                      params={{ notebookId: page.notebookId, documentId: row.documentId }}
                      preload={false}
                      className={link}
                      onClick={() => remember(row.documentId)}
                    >
                      {m.knowledge_navigation_open_document({}, options)}: {row.title}
                    </Link>
                    <Button
                      variant="outline"
                      className={control}
                      disabled={frontier.breadcrumbs.length >= 32}
                      onClick={() => actions.children(row)}
                    >
                      {m.knowledge_navigation_children({}, options)}: {row.title}
                    </Button>
                    {page.kind === 'outline' && !snapshot.source && (
                      <Button variant="outline" className={control} onClick={() => actions.source(row)}>
                        {copy.choose}: {row.title}
                      </Button>
                    )}
                    {page.kind === 'outline' && snapshot.source && (
                      <Button
                        variant="outline"
                        className={control}
                        disabled={snapshot.source.row.placementId === row.placementId}
                        onClick={() => actions.review(row)}
                      >
                        {copy.before}: {row.title}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {snapshot.source && page.kind === 'outline' && (
            <Button className={control} onClick={() => actions.review(null)}>
              {copy.end}
            </Button>
          )}
          {page.next && (
            <Button variant="outline" className={control} onClick={actions.more}>
              {m.knowledge_navigation_more({}, options)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
