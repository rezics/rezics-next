import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItem, type ContentItemProps } from '@rezics/ui/content-item';
import { RelativeTime } from '@rezics/ui/relative-time';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Bell, Flag, Gavel, MessageCircleReply } from 'lucide-react';
import { inboxPageQuery, inboxViewerQueryKey, markInboxViewerSeen, type InboxPageLoader } from './inbox-query';
import { inboxViewerCsrfToken, useInboxViewer, type InboxViewer } from './inbox-viewer';
import { InboxEntryState, retryInboxSession } from './inbox-entry-state';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { initials } from '../threads/initials';
import { usePreferenceRetry } from '../settings/preference-failure-retry';
import {
  confirmLoadedInboxSeen,
  emptyInboxPagination,
  nextInboxPage,
  readableInboxPage,
  receiveInboxPage,
  restartInboxPage,
} from './inbox-pagination';
import {
  inboxSeenFailure,
  type InboxPage,
  type InboxSeenAttempt,
  type NativeInboxFailure,
  type ResolvedInboxPage,
} from './inbox-read';

function kindLabel(item: ResolvedInboxPage['items'][number]) {
  if (item.watch === 'thread') return m.inbox_kind_thread_activity();
  if (item.watch === 'board') return m.inbox_kind_board_activity();
  if (item.reportId || item.kind === 'moderation_decision') return m.inbox_kind_moderation();
  if (item.kind === 'mention') return m.inbox_kind_mention();
  if (item.kind === 'reply') return m.inbox_kind_reply();
  return m.inbox_kind_unknown();
}

function accessRefused(failure: NativeInboxFailure | undefined) {
  return (
    failure?.status === 401 ||
    failure?.status === 403 ||
    failure?.code === 'unauthorized' ||
    failure?.code === 'forbidden'
  );
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
  const locale = getLocale();
  const exactDate = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone: 'UTC',
  });
  return (
    <>
      <ol aria-label={m.inbox_heading()} className="mt-6 space-y-1">
        {page.items.map((item) => {
          const href = item.unavailable ? undefined : item.href || undefined;
          const actorId = item.unavailable ? null : item.actorId;
          const actor =
            (!item.unavailable && item.actorName) ||
            (!item.unavailable && (item.reportId || item.kind === 'moderation_decision')
              ? m.inbox_actor_moderation()
              : m.inbox_actor_unknown());
          const kind = kindLabel(item);
          const text = item.unavailable ? m.inbox_unavailable_item() : item.text;
          const explanation =
            item.watch === 'thread'
              ? m.inbox_thread_activity_text()
              : item.watch === 'board'
                ? m.inbox_board_activity_text()
                : undefined;
          const readState = item.unread ? m.inbox_notice_unread() : m.inbox_notice_read();
          const date = exactDate.format(new Date(item.createdAt));
          const destinationProps = href ? { href } : {};
          const primaryLinkLabelProps = href
            ? ({
                primaryLinkLabel: [text, actor, kind, explanation, readState, date].filter(Boolean).join('. '),
              } satisfies Pick<ContentItemProps, 'primaryLinkLabel'>)
            : {};
          const visual = actorId ? (
            <Avatar aria-hidden="true" size="sm" className="mt-0.5 shrink-0">
              <AvatarFallback>{initials(actorId)}</AvatarFallback>
            </Avatar>
          ) : (
            <span
              data-icon-kind={item.reportId ? 'report_outcome' : item.kind}
              aria-hidden="true"
              className="mt-1 shrink-0 text-muted-foreground"
            >
              {item.watch ? (
                <Bell aria-hidden="true" size={18} />
              ) : item.reportId ? (
                <Flag aria-hidden="true" size={18} />
              ) : item.kind === 'moderation_decision' ? (
                <Gavel aria-hidden="true" size={18} />
              ) : (
                <MessageCircleReply aria-hidden="true" size={18} />
              )}
            </span>
          );
          return (
            <ContentItem
              key={item.id}
              title={text}
              {...(explanation ? { preview: <p>{explanation}</p> } : {})}
              {...destinationProps}
              {...primaryLinkLabelProps}
              headingLevel={2}
              visual={visual}
              metadata={
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span data-notice-byline="true" aria-hidden={href ? true : undefined}>
                    {actor}
                    <span aria-hidden="true"> · </span>
                    {kind}
                  </span>
                  <span aria-hidden="true"> · </span>
                  <span aria-hidden="true">
                    <RelativeTime value={item.createdAt} locale={locale} timeZone="UTC" />
                  </span>
                  {!href ? (
                    <time className="sr-only" dateTime={new Date(item.createdAt).toISOString()}>
                      {date}
                    </time>
                  ) : null}
                </div>
              }
              state={<span aria-hidden={href ? true : undefined}>{readState}</span>}
              data-notice-id={item.id}
              data-unread={item.unread}
              data-kind={item.reportId ? 'report_outcome' : item.kind}
              data-actor-id={actorId ?? undefined}
              className={`py-4 ${item.unread ? 'bg-muted/50' : ''}`}
            />
          );
        })}
      </ol>
      {page.next && onLoadMore ? (
        <Button
          variant="outline"
          className="mt-5 h-auto min-h-11 max-w-full whitespace-normal py-2"
          onClick={onLoadMore}
          disabled={loading}
        >
          {m.inbox_load_more()}
        </Button>
      ) : null}
    </>
  );
}

export function InboxPreferencesLink() {
  return (
    <a
      className="mt-3 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
      href={`/${getLocale()}/settings#notifications`}
    >
      {m.inbox_notification_preferences()}
    </a>
  );
}

export function InboxPageView({ loadPage }: { loadPage?: InboxPageLoader } = {}) {
  const { state, csrfToken, viewer, sessionRead } = useInboxViewer();
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
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
      <InboxPreferencesLink />
      <InboxEntryState state={state} sessionRead={sessionRead} />
    </div>
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
  const [unreadOnly, setUnreadOnly] = useState(false);
  const boundaryId = useId();
  const boundary = useRef<HTMLHeadingElement>(null);
  const continuation = useRef<{ cursor: string } | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continuationMessage, setContinuationMessage] = useState('');
  const { cursor } = pagination;
  const markedThrough = useRef<string | null>(null);
  const seenAttempt = useRef<InboxSeenAttempt | null>(null);
  const seenLoaded = useRef<ReadonlySet<string> | null>(null);
  const marking = useRef(false);
  const active = useRef(false);
  const [seenFailure, setSeenFailure] = useState<NativeInboxFailure>();
  const [seenConfirmed, setSeenConfirmed] = useState(false);
  const [markingPending, setMarkingPending] = useState(false);
  const accessPending = useRef(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessCheck, setAccessCheck] = useState<'checked' | 'unavailable'>();
  const pageQuery = useQuery(inboxPageQuery(viewer, cursor, loadPage));
  const received = receiveInboxPage(pagination, pageQuery.data, pageQuery.isError);
  // Reconcile in this render so a native denial cannot commit even one frame of retained rows.
  if (received !== pagination) setPagination(received);
  const readable = readableInboxPage(received);
  const unreadItems = readable?.items.filter((item) => item.unread) ?? [];
  const hasUnreadLoaded = unreadItems.length > 0;
  const visibleItems = unreadOnly ? unreadItems : (readable?.items ?? []);
  const page = pageQuery.data?.signedIn && pageQuery.data.state === 'ready' ? pageQuery.data : null;
  const operationState = pageQuery.data?.signedIn && pageQuery.data.state !== 'ready' ? pageQuery.data : null;
  const waiting = usePreferenceRetry(operationState?.failure);
  const seenWaiting = usePreferenceRetry(seenFailure);
  const pageSignedOut = pageQuery.data !== undefined && !pageQuery.data.signedIn;
  const seenNeedsAccess = seenFailure?.code === 'platform_closed' || accessRefused(seenFailure);
  // A successful page read only establishes read access; the separate marker retry can still be refused.
  const offerSeenRetry =
    seenFailure?.code !== 'platform_closed' &&
    page !== null &&
    (accessRefused(seenFailure) ? accessCheck === 'checked' : seenFailure?.retryable !== false);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      continuation.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const request = continuation.current;
    if (
      !request ||
      !active.current ||
      !viewer.isCurrent() ||
      pageQuery.isFetching ||
      received.cursor !== request.cursor ||
      !received.result
    )
      return;
    continuation.current = null;
    setContinuing(false);
    if (!pageQuery.isError && received.result.signedIn && received.result.state === 'ready') {
      setContinuationMessage(received.result.next ? m.inbox_page_loaded() : m.inbox_page_end());
      boundary.current?.focus();
    } else {
      // The same control remains mounted as the exact retry; failure never moves focus.
      setContinuationMessage('');
    }
  });

  const sendSeenAttempt = useCallback(
    async (attempt: InboxSeenAttempt) => {
      if (!active.current || marking.current || seenAttempt.current !== attempt || !viewer.isCurrent()) return;
      const token = inboxViewerCsrfToken(queryClient, viewer);
      if (!token) return;
      marking.current = true;
      setMarkingPending(true);
      const loaded = seenLoaded.current;
      try {
        await markInboxViewerSeen(queryClient, viewer, attempt, token);
        if (!active.current || !viewer.isCurrent()) return;
        setPagination((current) => {
          if (!active.current || !viewer.isCurrent() || !loaded) return current;
          // Invalidation has settled, but its response may not have rendered yet. Consume denials
          // and authoritative replacements before touching retained local flags.
          const refreshed = queryClient.getQueryState<InboxPage>([
            ...inboxViewerQueryKey(viewer),
            current.cursor ?? null,
          ]);
          return confirmLoadedInboxSeen(
            receiveInboxPage(current, refreshed?.data, refreshed?.status === 'error'),
            loaded,
          );
        });
        markedThrough.current = attempt.through;
        seenAttempt.current = null;
        seenLoaded.current = null;
        setSeenFailure(undefined);
        setSeenConfirmed(true);
      } catch (error: unknown) {
        if (active.current && viewer.isCurrent()) setSeenFailure(inboxSeenFailure(error).failure);
      } finally {
        if (active.current && viewer.isCurrent()) {
          marking.current = false;
          setMarkingPending(false);
        }
      }
    },
    [queryClient, viewer],
  );

  const markLoadedThroughLatest = () => {
    if (
      !active.current ||
      !inboxViewerCsrfToken(queryClient, viewer) ||
      !viewer.isCurrent() ||
      !page ||
      !readable?.items.length ||
      !hasUnreadLoaded ||
      seenAttempt.current ||
      seenFailure ||
      marking.current ||
      accessPending.current ||
      pageQuery.isFetching ||
      waiting ||
      seenWaiting
    )
      return;
    const latest = readable.items[0];
    if (!latest || markedThrough.current === latest.id) return;
    const attempt: InboxSeenAttempt = { through: latest.id, idempotencyKey: crypto.randomUUID() };
    seenAttempt.current = attempt;
    // Native loaded order puts this target first. Keep its bounded eligible IDs with the
    // original attempt across unknown outcomes; later arrivals cannot join an exact retry.
    seenLoaded.current = new Set(readable.items.map((item) => item.id));
    setSeenConfirmed(false);
    void sendSeenAttempt(attempt);
  };

  const checkAccess = async () => {
    if (
      !active.current ||
      accessPending.current ||
      marking.current ||
      pageQuery.isFetching ||
      waiting ||
      seenWaiting ||
      !viewer.isCurrent()
    )
      return;
    accessPending.current = true;
    setCheckingAccess(true);
    setAccessCheck(undefined);
    try {
      // Session freshness alone grants nothing. The unchanged viewer must pass the same bounded page read.
      await retryInboxSession(queryClient);
      if (!active.current || !viewer.isCurrent()) return;
      const result = await pageQuery.refetch({ cancelRefetch: false });
      if (active.current && viewer.isCurrent()) setAccessCheck(result.isError ? 'unavailable' : 'checked');
    } catch {
      if (active.current && viewer.isCurrent()) setAccessCheck('unavailable');
    } finally {
      if (active.current && viewer.isCurrent()) {
        accessPending.current = false;
        setCheckingAccess(false);
      }
    }
  };

  const loadMore = () => {
    if (
      !active.current ||
      !viewer.isCurrent() ||
      continuation.current ||
      pageQuery.isFetching ||
      accessPending.current ||
      !page?.next
    )
      return;
    const next = nextInboxPage(received);
    continuation.current = { cursor: next.cursor! };
    setContinuing(true);
    setContinuationMessage(m.inbox_page_loading());
    if (next === received) void pageQuery.refetch();
    else setPagination(next);
  };
  const startAtFirstPage = () => {
    if (!active.current || pageQuery.isFetching || accessPending.current || waiting || !viewer.isCurrent()) return;
    const first = restartInboxPage(received);
    if (first === received) return;
    // Retire cached pages and any stale responses before observing the native first-page query.
    void queryClient.cancelQueries({ queryKey: inboxViewerQueryKey(viewer) });
    queryClient.removeQueries({ queryKey: inboxViewerQueryKey(viewer) });
    setPagination(first);
  };
  const retryPage = () => {
    if (
      !active.current ||
      !viewer.isCurrent() ||
      continuation.current ||
      pageQuery.isFetching ||
      accessPending.current ||
      waiting
    )
      return;
    if (cursor !== undefined) {
      continuation.current = { cursor };
      setContinuing(true);
      setContinuationMessage(m.inbox_page_loading());
    }
    void pageQuery.refetch({ cancelRefetch: false });
  };
  const failed = pageQuery.isError || operationState !== null;
  const failure = failed ? (
    <section
      id={`${boundaryId}-failure`}
      role="status"
      data-response-status={operationState?.failure.status ?? ''}
      data-response-code={operationState?.failure.code ?? ''}
      data-retry-after={operationState?.failure.retryAfter}
      className="mt-6 rounded-lg border border-border p-5"
    >
      <p className="text-muted-foreground">
        {operationState?.state === 'closed'
          ? m.inbox_closed()
          : operationState?.state === 'preparing'
            ? m.inbox_preparing()
            : accessRefused(operationState?.failure)
              ? m.inbox_read_denied()
              : m.inbox_unavailable()}
      </p>
      {cursor !== undefined && readable?.items.length ? (
        <p className="mt-2 text-sm text-muted-foreground">{m.inbox_page_retry_hint()}</p>
      ) : null}
      {waiting ? <p className="mt-2 text-sm text-muted-foreground">{m.settings_retry_wait()}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {cursor !== undefined ? (
          <Button
            variant="outline"
            className="h-auto min-h-11 max-w-full whitespace-normal py-2"
            onClick={startAtFirstPage}
            disabled={pageQuery.isFetching || checkingAccess || waiting}
          >
            {m.inbox_start_first_page()}
          </Button>
        ) : null}
      </div>
    </section>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 id={boundaryId} ref={boundary} tabIndex={-1} className="font-display text-3xl font-semibold tracking-tight">
        {m.inbox_heading()}
      </h1>
      <InboxPreferencesLink />
      <p role="status" aria-atomic="true" className="sr-only">
        {continuationMessage}
      </p>
      {seenFailure ? (
        <section
          role="status"
          data-response-status={seenFailure.status ?? ''}
          data-response-code={seenFailure.code ?? ''}
          data-retry-after={seenFailure.retryAfter}
          aria-busy={checkingAccess || markingPending}
          className="mt-4 space-y-2"
        >
          <p>{m.inbox_seen_unavailable()}</p>
          {seenFailure.code === 'platform_closed' ? (
            <p>{m.inbox_seen_closed()}</p>
          ) : accessRefused(seenFailure) ? (
            <p>{m.inbox_seen_denied()}</p>
          ) : seenFailure.status === 429 ? (
            <p>{m.inbox_seen_rate_limited()}</p>
          ) : (
            <p>{m.inbox_seen_unknown()}</p>
          )}
          <p>{m.inbox_seen_readable()}</p>
          {seenWaiting ? <p>{m.settings_retry_wait()}</p> : null}
          <div className="flex flex-wrap items-start gap-3">
            <Button
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal py-2"
              disabled={
                seenWaiting ||
                waiting ||
                checkingAccess ||
                markingPending ||
                pageQuery.isFetching ||
                !viewer.isCurrent()
              }
              onClick={() => void checkAccess()}
            >
              {m.inbox_check_access()}
            </Button>
            {offerSeenRetry ? (
              <fieldset className="min-w-0 max-w-full space-y-2">
                <legend className={seenNeedsAccess ? 'sr-only' : 'text-sm text-muted-foreground'}>
                  {m.inbox_seen_retry()}
                </legend>
                <Button
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal py-2"
                  disabled={
                    seenWaiting ||
                    waiting ||
                    markingPending ||
                    checkingAccess ||
                    pageQuery.isFetching ||
                    !csrfToken ||
                    !viewer.isCurrent()
                  }
                  onClick={() => {
                    if (
                      !active.current ||
                      !viewer.isCurrent() ||
                      seenWaiting ||
                      waiting ||
                      accessPending.current ||
                      pageQuery.isFetching ||
                      !seenAttempt.current
                    )
                      return;
                    setAccessCheck(undefined);
                    void sendSeenAttempt(seenAttempt.current);
                  }}
                >
                  {seenNeedsAccess ? m.inbox_seen_retry() : m.inbox_retry()}
                </Button>
              </fieldset>
            ) : null}
          </div>
          {accessCheck ? (
            <p>{accessCheck === 'checked' ? m.inbox_seen_access_checked() : m.inbox_seen_access_unavailable()}</p>
          ) : null}
        </section>
      ) : null}
      {pageSignedOut ? (
        <div className="mt-6 space-y-3">
          <p className="text-muted-foreground">{m.inbox_read_denied()}</p>
          {!seenFailure ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal py-2"
              disabled={checkingAccess || waiting || seenWaiting}
              onClick={() => void checkAccess()}
            >
              {m.inbox_check_access()}
            </Button>
          ) : null}
        </div>
      ) : pageQuery.isPending && !readable ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_loading()}</p>
      ) : (
        <>
          {readable ? (
            <section className="mt-5 space-y-3">
              <div role="group" aria-label={m.inbox_triage_filter_group()} className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={!unreadOnly}
                  className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
                  onClick={() => setUnreadOnly(false)}
                >
                  {m.inbox_triage_filter_all()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={unreadOnly}
                  className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
                  onClick={() => setUnreadOnly(true)}
                >
                  {m.inbox_triage_filter_unread()}
                </Button>
              </div>
              {cursor !== undefined && !failed && page ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal py-2"
                  onClick={startAtFirstPage}
                  disabled={pageQuery.isFetching || checkingAccess || waiting}
                >
                  {m.inbox_start_first_page()}
                </Button>
              ) : null}
              <p className="text-sm text-muted-foreground">{m.inbox_triage_scope()}</p>
              {hasUnreadLoaded && !seenFailure && readable.items[0]?.id !== markedThrough.current ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{m.inbox_triage_mark_help()}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal py-2"
                    disabled={
                      markingPending ||
                      checkingAccess ||
                      pageQuery.isFetching ||
                      waiting ||
                      seenWaiting ||
                      !csrfToken ||
                      !viewer.isCurrent() ||
                      page === null ||
                      seenAttempt.current !== null
                    }
                    onClick={markLoadedThroughLatest}
                  >
                    {m.inbox_triage_mark()}
                  </Button>
                </div>
              ) : null}
              {seenConfirmed ? <p role="status">{m.inbox_triage_marked()}</p> : null}
            </section>
          ) : null}
          {readable ? (
            readable.items.length === 0 && !readable.next ? (
              !failed && !pageQuery.isFetching ? (
                <p className="mt-6 text-muted-foreground">{m.inbox_empty()}</p>
              ) : null
            ) : unreadOnly && !hasUnreadLoaded ? (
              <section className="mt-6 space-y-3">
                <p role="status" className="text-muted-foreground">
                  {readable.items.length === 0 && !readable.next ? m.inbox_empty() : m.inbox_triage_no_unread_loaded()}
                </p>
                {readable.next ? <p className="text-sm text-muted-foreground">{m.inbox_triage_older_pages()}</p> : null}
              </section>
            ) : !unreadOnly && readable.items.length === 0 ? (
              <section className="mt-6 space-y-3">
                <p role="status" className="text-muted-foreground">
                  {m.inbox_triage_no_loaded()}
                </p>
                {readable.next ? <p className="text-sm text-muted-foreground">{m.inbox_triage_older_pages()}</p> : null}
              </section>
            ) : (
              <InboxRows
                page={{
                  ...readable,
                  items: visibleItems,
                }}
              />
            )
          ) : null}
          {pageQuery.isFetching && readable && !continuing ? (
            <p role="status" className="mt-4 text-muted-foreground">
              {m.inbox_loading()}
            </p>
          ) : null}
          {failure}
          {(failed ? !seenNeedsAccess : readable?.next) ? (
            <Button
              type="button"
              variant="outline"
              className="mt-5 h-auto min-h-11 max-w-full whitespace-normal py-2"
              aria-controls={boundaryId}
              aria-describedby={failed ? `${boundaryId}-failure` : undefined}
              aria-busy={continuing}
              aria-disabled={continuing || pageQuery.isFetching || checkingAccess || (failed && waiting)}
              onClick={failed ? retryPage : loadMore}
            >
              {continuing
                ? m.inbox_page_loading()
                : failed
                  ? m.inbox_retry()
                  : visibleItems.length === 0
                    ? m.inbox_next_page()
                    : m.inbox_load_more()}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
