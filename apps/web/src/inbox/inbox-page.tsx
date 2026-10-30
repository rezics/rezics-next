import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { RelativeTime } from '@rezics/ui/relative-time';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Flag, Gavel, MessageCircleReply } from 'lucide-react';
import { inboxPageQuery, markInboxViewerSeen, type InboxPageLoader } from './inbox-query';
import { useInboxViewer, type InboxViewer } from './inbox-viewer';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { initials } from '../threads/initials';
import { emptyInboxPagination, nextInboxPage, readableInboxPage, receiveInboxPage } from './inbox-pagination';
import type { InboxSeenAttempt, ResolvedInboxPage } from './inbox-read';

function kindLabel(item: ResolvedInboxPage['items'][number]) {
  if (item.reportId || item.kind === 'moderation_decision') return m.inbox_kind_moderation();
  return item.kind === 'mention' ? m.inbox_kind_mention() : m.inbox_kind_reply();
}

export function InboxRows({
  page,
  onLoadMore,
  loading = false,
}: {
  page: ResolvedInboxPage;
  onLoadMore?: () => void;
  loading?: boolean;
}) {
  return (
    <>
      <ol aria-label={m.inbox_heading()} className="mt-6 space-y-1">
        {page.items.map((item) => (
          <ListRow
            key={item.id}
            data-notice-id={item.id}
            data-unread={item.unread}
            data-kind={item.reportId ? 'report_outcome' : item.kind}
            data-actor-id={item.actorId ?? undefined}
            className={`flex items-start gap-3 py-4 ${item.unread ? 'bg-muted/50' : ''}`}
          >
            {item.actorId ? (
              <Avatar aria-hidden="true" size="sm" className="mt-0.5 shrink-0">
                <AvatarFallback>{initials(item.actorId)}</AvatarFallback>
              </Avatar>
            ) : (
              <span
                data-icon-kind={item.reportId ? 'report_outcome' : item.kind}
                aria-hidden="true"
                className="mt-1 shrink-0 text-muted-foreground"
              >
                {item.reportId ? (
                  <Flag aria-hidden="true" size={18} />
                ) : item.kind === 'moderation_decision' ? (
                  <Gavel aria-hidden="true" size={18} />
                ) : (
                  <MessageCircleReply aria-hidden="true" size={18} />
                )}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {item.unavailable ? (
                <p className="text-sm text-muted-foreground">{m.inbox_unavailable_item()}</p>
              ) : item.href ? (
                <>
                  <ListRowLink href={item.href}>{item.text}</ListRowLink>
                  <p aria-hidden="true" className="text-sm leading-6">
                    {item.text}
                  </p>
                </>
              ) : (
                <p className="text-sm leading-6">{item.text}</p>
              )}
              <span className="sr-only">{item.unread ? 'Unread notification' : 'Read notification'}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                <span data-notice-byline="true">
                  {item.actorName || (item.actorId ? m.inbox_actor_unknown() : m.inbox_actor_moderation())}
                  <span aria-hidden="true"> · </span>
                  {kindLabel(item)}
                </span>
                <span aria-hidden="true"> · </span>
                <RelativeTime value={item.createdAt} locale={getLocale()} timeZone="UTC" />
                <span className="sr-only">
                  {new Intl.DateTimeFormat(getLocale(), {
                    dateStyle: 'full',
                    timeStyle: 'long',
                    timeZone: 'UTC',
                  }).format(new Date(item.createdAt))}
                </span>
              </span>
            </div>
          </ListRow>
        ))}
      </ol>
      {page.next && onLoadMore ? (
        <Button variant="outline" className="mt-5" onClick={onLoadMore} disabled={loading}>
          {m.inbox_load_more()}
        </Button>
      ) : null}
    </>
  );
}

export function InboxPageView({ loadPage }: { loadPage?: InboxPageLoader } = {}) {
  const { state, csrfToken, viewer } = useInboxViewer();
  if (viewer)
    return (
      <ViewerInboxPage
        key={JSON.stringify([viewer.subject, viewer.epoch])}
        viewer={viewer}
        csrfToken={csrfToken}
        loadPage={loadPage}
      />
    );
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
      <p className="mt-6 text-muted-foreground">
        {state === 'signed-out' ? m.inbox_sign_in() : state === 'unknown' ? m.inbox_loading() : m.inbox_unavailable()}
      </p>
    </main>
  );
}

/** Pagination owns its accumulated pages inside this immutable viewer boundary. */
export function ViewerInboxPage({
  viewer,
  csrfToken,
  loadPage,
}: {
  viewer: InboxViewer;
  csrfToken: string | null;
  loadPage?: InboxPageLoader | undefined;
}) {
  const queryClient = useQueryClient();
  const [pagination, setPagination] = useState(emptyInboxPagination);
  const { cursor } = pagination;
  const marked = useRef<string | null>(null);
  const seenAttempt = useRef<InboxSeenAttempt | null>(null);
  const marking = useRef(false);
  const active = useRef(false);
  const [seenFailed, setSeenFailed] = useState(false);
  const [seenRetry, setSeenRetry] = useState(0);
  const pageQuery = useQuery(inboxPageQuery(viewer, cursor, loadPage));
  const received = receiveInboxPage(pagination, pageQuery.data, pageQuery.isError);
  // Reconcile in this render so a native denial cannot commit even one frame of retained rows.
  if (received !== pagination) setPagination(received);
  const readable = readableInboxPage(received);
  const page = pageQuery.data?.signedIn && pageQuery.data.state === 'ready' ? pageQuery.data : null;
  const operationState = pageQuery.data?.signedIn && pageQuery.data.state !== 'ready' ? pageQuery.data : null;
  const pageSignedOut = pageQuery.data !== undefined && !pageQuery.data.signedIn;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!viewer.isCurrent() || cursor !== undefined || !csrfToken || marking.current || marked.current || seenFailed)
      return;
    const newest = page?.items[0];
    if (!seenAttempt.current) {
      if (!newest?.unread) return;
      seenAttempt.current = { through: newest.id, idempotencyKey: crypto.randomUUID() };
    }
    const attempt = seenAttempt.current;
    marking.current = true;
    void markInboxViewerSeen(queryClient, viewer, attempt, csrfToken)
      .then(() => {
        if (!active.current || !viewer.isCurrent()) return;
        marked.current = attempt.through;
        seenAttempt.current = null;
      })
      .catch(() => {
        if (active.current && viewer.isCurrent()) setSeenFailed(true);
      })
      .finally(() => {
        if (active.current && viewer.isCurrent()) marking.current = false;
      });
  }, [cursor, page?.items, queryClient, viewer, csrfToken, seenRetry, seenFailed]);

  const loadMore = () => {
    if (pageQuery.isFetching || !page?.next) return;
    const next = nextInboxPage(received);
    if (next === received) void pageQuery.refetch();
    else setPagination(next);
  };
  const failed = pageQuery.isError || operationState !== null;
  const failure = failed ? (
    <section
      role="status"
      data-response-status={operationState?.failure.status ?? ''}
      data-response-code={operationState?.failure.code ?? ''}
      className="mt-6 rounded-lg border border-border p-5"
    >
      <p className="text-muted-foreground">
        {operationState?.state === 'closed'
          ? m.inbox_closed()
          : operationState?.state === 'preparing'
            ? m.inbox_preparing()
            : m.inbox_unavailable()}
      </p>
      {cursor !== undefined && readable?.items.length ? (
        <p className="mt-2 text-sm text-muted-foreground">{m.inbox_page_retry_hint()}</p>
      ) : null}
      <Button
        variant="outline"
        className="mt-4"
        onClick={() => void pageQuery.refetch()}
        disabled={pageQuery.isFetching}
      >
        {m.inbox_retry()}
      </Button>
    </section>
  ) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
      {seenFailed ? (
        <section role="status" className="mt-4 space-y-2">
          <p>{m.inbox_seen_unavailable()}</p>
          <Button
            variant="outline"
            onClick={() => {
              setSeenFailed(false);
              setSeenRetry((value) => value + 1);
            }}
          >
            {m.inbox_retry()}
          </Button>
        </section>
      ) : null}
      {pageSignedOut ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_sign_in()}</p>
      ) : pageQuery.isPending && !readable ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_loading()}</p>
      ) : (
        <>
          {readable ? (
            readable.items.length === 0 && !readable.next ? (
              !failed && !pageQuery.isFetching ? (
                <p className="mt-6 text-muted-foreground">{m.inbox_empty()}</p>
              ) : null
            ) : (
              <InboxRows
                page={readable}
                {...(!failed && readable.next ? { onLoadMore: loadMore } : {})}
                loading={pageQuery.isFetching}
              />
            )
          ) : null}
          {pageQuery.isFetching && readable ? (
            <p role="status" className="mt-4 text-muted-foreground">
              {m.inbox_loading()}
            </p>
          ) : null}
          {failure}
        </>
      )}
    </main>
  );
}
