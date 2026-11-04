import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItem, type ContentItemProps } from '@rezics/ui/content-item';
import { RelativeTime } from '@rezics/ui/relative-time';
import { Bell, Flag, Gavel, MessageCircleReply } from 'lucide-react';
import {
  inboxPageQuery,
  inboxViewerQueryKey,
  markInboxViewerNoticeSeen,
  markInboxViewerSeen,
  type InboxPageLoader,
} from './inbox-query';
import { InboxUnreadSummary } from './unread-badge';
import { inboxViewerCsrfToken, useInboxViewer, type InboxViewer } from './inbox-viewer';
import { InboxEntryState, retryInboxSession } from './inbox-entry-state';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { preferenceRetryDeadline, usePreferenceRetry } from '../settings/preference-failure-retry';
import {
  confirmLoadedInboxSeen,
  confirmInboxNoticeSeen,
  emptyInboxPagination,
  nextInboxPage,
  readableInboxPage,
  receiveInboxPage,
  restartInboxPage,
  selectInboxPage,
} from './inbox-pagination';
import {
  inboxTargetContext,
  inboxSeenFailure,
  type InboxNoticeSeenAttempt,
  type InboxPage,
  type InboxSeenAttempt,
  type InboxSelection,
  type NativeInboxFailure,
  type ResolvedInboxPage,
} from './inbox-read';
import { InboxNoticeActorVisual, inboxNoticeActorPresentation } from './inbox-notice-actor';
import {
  inboxAcknowledgementRecovery,
  inboxAcknowledgementRetryAllowed,
  type InboxAcknowledgementRecovery,
} from './inbox-acknowledgement-recovery';

type InboxLoadedSeenIntent = Readonly<{
  attempt: Readonly<InboxSeenAttempt>;
  eligibleNoticeIds: readonly string[];
}>;

type InboxPageIntent = Readonly<{
  viewer: InboxViewer;
  selection: InboxSelection;
  cursor: string | undefined;
}>;

function kindLabel(item: ResolvedInboxPage['items'][number]) {
  if (item.kind === 'thread_watch' || item.watch === 'thread') return m.inbox_kind_thread_activity();
  if (item.kind === 'board_activity' || item.watch === 'board') return m.inbox_kind_board_activity();
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

function acknowledgementFailureMessage(failure: NativeInboxFailure) {
  if (failure.code === 'platform_closed') return m.inbox_seen_closed();
  if (accessRefused(failure)) return m.inbox_seen_denied();
  if (failure.status === 429) return m.inbox_seen_rate_limited();
  return m.inbox_seen_unknown();
}

export function InboxRows({
  page,
  onLoadMore,
  loading = false,
  onMarkSeen,
  onRetrySeen,
  pendingNoticeId,
  uncertainNoticeId,
  noticeFailure,
  noticeWaiting = false,
  noticeRetryBlocked = false,
  acknowledgementBlocked = false,
  confirmedNoticeId,
}: {
  page: Pick<ResolvedInboxPage, 'items' | 'next'>;
  onLoadMore?: () => void;
  loading?: boolean;
  onMarkSeen?: (noticeId: string) => void;
  onRetrySeen?: () => void;
  pendingNoticeId?: string | null;
  uncertainNoticeId?: string | null;
  noticeFailure?: NativeInboxFailure | undefined;
  noticeWaiting?: boolean;
  noticeRetryBlocked?: boolean;
  acknowledgementBlocked?: boolean;
  confirmedNoticeId?: string | null;
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
          const hasComposedDisclosure = !!item.actor && !!item.target && !!item.actions;
          const hiddenLegacyItem = item.unavailable && !hasComposedDisclosure;
          const href = hiddenLegacyItem ? undefined : item.href || undefined;
          const actor = inboxNoticeActorPresentation({
            ...(item.actor ? { actor: item.actor } : {}),
            actorId: item.actorId,
            ...(item.actorName !== undefined ? { actorName: item.actorName } : {}),
            kind: item.kind,
            reportId: item.reportId,
            hideLegacy: hiddenLegacyItem,
          });
          const kind = kindLabel(item);
          const text =
            item.summary ?? (hiddenLegacyItem ? m.inbox_unavailable_item() : item.text) ?? m.inbox_unavailable_item();
          const explanation =
            item.kind === 'thread_watch' || item.watch === 'thread'
              ? m.inbox_thread_activity_text()
              : item.kind === 'board_activity' || item.watch === 'board'
                ? m.inbox_board_activity_text()
                : undefined;
          const readState = item.unread ? m.inbox_notice_unread() : m.inbox_notice_read();
          const date = exactDate.format(new Date(item.createdAt));
          const context = item.context ?? inboxTargetContext(item.target);
          const chosenAction =
            onMarkSeen && (item.unread || uncertainNoticeId === item.id) ? (
              uncertainNoticeId === item.id ? (
                <div className="space-y-1">
                  <p role="status">
                    {noticeFailure ? acknowledgementFailureMessage(noticeFailure) : m.inbox_notice_seen_unknown()}
                  </p>
                  {noticeWaiting ? <p>{m.settings_retry_wait()}</p> : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
                    disabled={
                      pendingNoticeId === item.id || loading || noticeWaiting || noticeRetryBlocked || !onRetrySeen
                    }
                    onClick={onRetrySeen}
                  >
                    {m.inbox_notice_seen_retry()}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
                  disabled={
                    acknowledgementBlocked || loading || (pendingNoticeId !== null && pendingNoticeId !== undefined)
                  }
                  onClick={() => onMarkSeen(item.id)}
                >
                  {pendingNoticeId === item.id ? m.inbox_notice_marking_seen() : m.inbox_notice_mark_seen()}
                </Button>
              )
            ) : null;
          const destinationProps = href ? { href } : {};
          const primaryLinkLabelProps = href
            ? ({
                primaryLinkLabel: [text, context, actor.label, kind, explanation, readState, date]
                  .filter(Boolean)
                  .join('. '),
              } satisfies Pick<ContentItemProps, 'primaryLinkLabel'>)
            : {};
          const fallbackVisual = item.watch || item.kind === 'thread_watch' || item.kind === 'board_activity' ? (
            <Bell aria-hidden="true" size={18} />
          ) : item.reportId ? (
            <Flag aria-hidden="true" size={18} />
          ) : item.kind === 'moderation_decision' ? (
            <Gavel aria-hidden="true" size={18} />
          ) : (
            <MessageCircleReply aria-hidden="true" size={18} />
          );
          const visual = (
            <InboxNoticeActorVisual
              presentation={actor}
              size="sm"
              avatarClassName="mt-0.5 shrink-0"
              fallbackClassName="mt-1 shrink-0 text-muted-foreground"
              fallback={fallbackVisual}
              dataIconKind={item.reportId ? 'report_outcome' : item.kind}
            />
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
              context={context ? <p>{context}</p> : undefined}
              metadata={
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span data-notice-byline="true" aria-hidden={href ? true : undefined}>
                    {actor.label}
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
              state={
                <span aria-hidden={href ? true : undefined}>
                  {confirmedNoticeId === item.id ? m.inbox_notice_marked_seen() : readState}
                </span>
              }
              actions={chosenAction}
              data-notice-id={item.id}
              data-unread={item.unread}
              data-kind={item.reportId ? 'report_outcome' : item.kind}
              data-actor-id={actor.actorId ?? undefined}
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

type NoticeSeenStoryTransport = (attempt: InboxNoticeSeenAttempt, csrfToken: string) => Promise<void>;

export function InboxPageView({
  loadPage,
  acknowledgeNotice,
}: {
  loadPage?: InboxPageLoader;
  acknowledgeNotice?: NoticeSeenStoryTransport;
} = {}) {
  const queryClient = useQueryClient();
  const { state, csrfToken, viewer, sessionRead } = useInboxViewer();
  const ownerEpisode = useRef<{
    client: typeof queryClient;
    viewer: InboxViewer | null;
    csrfToken: string | null;
    id: number;
  } | null>(null);
  if (
    !ownerEpisode.current ||
    ownerEpisode.current.client !== queryClient ||
    ownerEpisode.current.viewer !== viewer ||
    ownerEpisode.current.csrfToken !== csrfToken
  )
    ownerEpisode.current = {
      client: queryClient,
      viewer,
      csrfToken,
      id: (ownerEpisode.current?.id ?? 0) + 1,
    };
  const episode = ownerEpisode.current!.id;
  if (viewer)
    return (
      <ViewerInboxPage
        key={episode}
        viewer={viewer}
        csrfToken={csrfToken}
        episode={episode}
        loadPage={loadPage}
        acknowledgeNotice={acknowledgeNotice}
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

/** Pagination retains only the current bounded page inside this immutable viewer boundary. */
export function ViewerInboxPage({
  viewer,
  csrfToken,
  episode,
  loadPage,
  acknowledgeNotice,
}: {
  viewer: InboxViewer;
  csrfToken: string | null;
  episode: number;
  loadPage?: InboxPageLoader | undefined;
  acknowledgeNotice?: NoticeSeenStoryTransport | undefined;
}) {
  const queryClient = useQueryClient();
  const episodeOwnerCurrent = useCallback(
    () => viewer.isCurrent() && inboxViewerCsrfToken(queryClient, viewer) === csrfToken,
    [csrfToken, queryClient, viewer],
  );
  const [pagination, setPagination] = useState(emptyInboxPagination);
  const boundaryId = useId();
  const boundary = useRef<HTMLHeadingElement>(null);
  const continuation = useRef<{ cursor: string } | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continuationMessage, setContinuationMessage] = useState('');
  const { cursor, selection } = pagination;
  const pageIntentRef = useRef<InboxPageIntent | null>(null);
  if (
    !pageIntentRef.current ||
    pageIntentRef.current.viewer !== viewer ||
    pageIntentRef.current.selection !== selection ||
    pageIntentRef.current.cursor !== cursor
  )
    pageIntentRef.current = Object.freeze({ viewer, selection, cursor });
  const pageIntent = pageIntentRef.current!;
  const pageRetryAtRef = useRef<{ intent: InboxPageIntent; deadline: number }>({ intent: pageIntent, deadline: 0 });
  const markedThrough = useRef<string | null>(null);
  const seenIntent = useRef<InboxLoadedSeenIntent | null>(null);
  const marking = useRef(false);
  const noticeAttempt = useRef<InboxNoticeSeenAttempt | null>(null);
  const noticeMarking = useRef(false);
  const [noticeAttemptView, setNoticeAttemptView] = useState<InboxNoticeSeenAttempt | null>(null);
  const [noticePendingId, setNoticePendingId] = useState<string | null>(null);
  const noticeRecovery = useRef<InboxAcknowledgementRecovery<InboxNoticeSeenAttempt> | null>(null);
  const [noticeRecoveryView, setNoticeRecoveryView] = useState<
    InboxAcknowledgementRecovery<InboxNoticeSeenAttempt> | null
  >(null);
  const [noticeConfirmedId, setNoticeConfirmedId] = useState<string | null>(null);
  const active = useRef(false);
  const seenRecovery = useRef<InboxAcknowledgementRecovery<Readonly<InboxSeenAttempt>> | null>(null);
  const [seenRecoveryView, setSeenRecoveryView] = useState<
    InboxAcknowledgementRecovery<Readonly<InboxSeenAttempt>> | null
  >(null);
  const seenRetryPolicy = useRef({ pageReady: false, allowed: false });
  const [seenConfirmed, setSeenConfirmed] = useState(false);
  const [markingPending, setMarkingPending] = useState(false);
  const accessPending = useRef(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessCheck, setAccessCheck] = useState<'checked' | 'unavailable'>();
  const pageQuery = useQuery(inboxPageQuery(viewer, cursor, loadPage, selection, episode, episodeOwnerCurrent));
  const received = receiveInboxPage(pagination, pageQuery.data, pageQuery.isError);
  // Reconcile in this render so a native denial cannot commit even one frame of retained rows.
  if (received !== pagination) setPagination(received);
  const readable = readableInboxPage(received);
  const visibleItems = readable?.items ?? [];
  const page = pageQuery.data?.signedIn && pageQuery.data.state === 'ready' ? pageQuery.data : null;
  const admittedMarkSeen = page?.actions?.markSeen ?? null;
  const operationState = pageQuery.data?.signedIn && pageQuery.data.state !== 'ready' ? pageQuery.data : null;
  const pageRetryAt = operationState
    ? preferenceRetryDeadline(operationState.failure.retryAfter, pageQuery.dataUpdatedAt)
    : 0;
  pageRetryAtRef.current = { intent: pageIntent, deadline: pageRetryAt };
  const pageWaitActive = (intent: InboxPageIntent) =>
    pageRetryAtRef.current.intent === intent && pageRetryAtRef.current.deadline > Date.now();
  const waiting = usePreferenceRetry(operationState?.failure, pageRetryAt);
  const noticeRecoveryViewCurrent =
    noticeRecoveryView?.attempt === noticeAttempt.current ? noticeRecoveryView : null;
  const seenRecoveryViewCurrent =
    seenRecoveryView && seenRecoveryView.attempt === seenIntent.current?.attempt ? seenRecoveryView : null;
  const noticeFailure = noticeRecoveryViewCurrent?.failure;
  const seenFailure = seenRecoveryViewCurrent?.failure;
  const noticeWaiting = usePreferenceRetry(noticeFailure, noticeRecoveryViewCurrent?.retryAt ?? 0);
  const seenWaiting = usePreferenceRetry(seenFailure, seenRecoveryViewCurrent?.retryAt ?? 0);
  const pageSignedOut = pageQuery.data !== undefined && !pageQuery.data.signedIn;
  const seenNeedsAccess = seenFailure?.code === 'platform_closed' || accessRefused(seenFailure);
  // A successful page read only establishes read access; the separate marker retry can still be refused.
  const offerSeenRetry =
    seenFailure?.code !== 'platform_closed' &&
    page !== null &&
    (accessRefused(seenFailure) ? accessCheck === 'checked' : seenFailure?.retryable !== false);
  seenRetryPolicy.current = { pageReady: page !== null, allowed: offerSeenRetry };

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      continuation.current = null;
      seenIntent.current = null;
      seenRecovery.current = null;
      noticeAttempt.current = null;
      noticeRecovery.current = null;
      const episodeQueryKey = [...inboxViewerQueryKey(viewer), episode];
      void queryClient.cancelQueries({ queryKey: episodeQueryKey });
      queryClient.removeQueries({ queryKey: episodeQueryKey });
    };
  }, [episode, queryClient, viewer]);

  useLayoutEffect(() => {
    const request = continuation.current;
    if (
      !request ||
      !active.current ||
      !episodeOwnerCurrent() ||
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

  const pageQueryFetching = useCallback(
    (intent: InboxPageIntent) => {
      if (intent.viewer !== viewer || !episodeOwnerCurrent()) return true;
      return (
        queryClient.getQueryState([
          ...inboxViewerQueryKey(viewer),
          episode,
          intent.selection,
          intent.cursor ?? null,
        ])?.fetchStatus === 'fetching'
      );
    },
    [episode, episodeOwnerCurrent, queryClient, viewer],
  );

  const sendSeenAttempt = useCallback(
    async (intent: InboxLoadedSeenIntent, deliberateRetry = false, dispatchIntent: InboxPageIntent = pageIntent) => {
      const attempt = intent.attempt;
      const recovery = seenRecovery.current;
      if (
        !active.current ||
        marking.current ||
        noticeAttempt.current !== null ||
        seenIntent.current !== intent ||
        !episodeOwnerCurrent() ||
        (!deliberateRetry && pageIntentRef.current !== dispatchIntent) ||
        (deliberateRetry
          ? !inboxAcknowledgementRetryAllowed(recovery, attempt)
          : recovery !== null) ||
        (deliberateRetry && (!seenRetryPolicy.current.pageReady || !seenRetryPolicy.current.allowed)) ||
        pageQueryFetching(pageIntentRef.current ?? dispatchIntent)
      )
        return;
      const token = inboxViewerCsrfToken(queryClient, viewer);
      if (!token) return;
      if (deliberateRetry) {
        seenRecovery.current = null;
        setSeenRecoveryView(null);
        setAccessCheck(undefined);
      }
      marking.current = true;
      setMarkingPending(true);
      try {
        await markInboxViewerSeen(queryClient, viewer, attempt, token);
        if (!active.current || !episodeOwnerCurrent() || seenIntent.current !== intent) return;
        setPagination((current) => {
          if (!active.current || !episodeOwnerCurrent()) return current;
          // Invalidation has settled, but its response may not have rendered yet. Consume denials
          // and authoritative replacements before touching the original eligible IDs.
          const refreshed = queryClient.getQueryState<InboxPage>([
            ...inboxViewerQueryKey(viewer),
            episode,
            current.selection,
            current.cursor ?? null,
          ]);
          return confirmLoadedInboxSeen(
            receiveInboxPage(current, refreshed?.data, refreshed?.status === 'error'),
            new Set(intent.eligibleNoticeIds),
          );
        });
        markedThrough.current = attempt.through;
        seenIntent.current = null;
        seenRecovery.current = null;
        setSeenRecoveryView(null);
        setSeenConfirmed(true);
      } catch (error: unknown) {
        if (active.current && episodeOwnerCurrent() && seenIntent.current === intent) {
          const failure = inboxSeenFailure(error).failure;
          const next = inboxAcknowledgementRecovery(attempt, failure, Date.now());
          seenRecovery.current = next;
          setSeenRecoveryView(next);
        }
      } finally {
        if (active.current && episodeOwnerCurrent()) {
          marking.current = false;
          setMarkingPending(false);
        }
      }
    },
    [episodeOwnerCurrent, pageIntent, pageQueryFetching, queryClient, viewer],
  );

  const sendNoticeSeenAttempt = useCallback(
    async (attempt: InboxNoticeSeenAttempt, deliberateRetry = false, dispatchIntent: InboxPageIntent = pageIntent) => {
      const recovery = noticeRecovery.current;
      if (
        !active.current ||
        noticeMarking.current ||
        noticeAttempt.current !== attempt ||
        seenIntent.current !== null ||
        !episodeOwnerCurrent() ||
        pageIntentRef.current !== dispatchIntent ||
        (deliberateRetry
          ? !inboxAcknowledgementRetryAllowed(recovery, attempt)
          : recovery !== null) ||
        pageQueryFetching(dispatchIntent)
      )
        return;
      const token = inboxViewerCsrfToken(queryClient, viewer);
      if (!token) return;
      if (deliberateRetry) {
        noticeRecovery.current = null;
        setNoticeRecoveryView(null);
      }
      noticeMarking.current = true;
      setNoticePendingId(attempt.noticeId);
      try {
        if (acknowledgeNotice) await acknowledgeNotice(attempt, token);
        else await markInboxViewerNoticeSeen(queryClient, viewer, attempt, token);
        if (!active.current || !episodeOwnerCurrent() || noticeAttempt.current !== attempt) return;
        setPagination((current) => {
          if (!active.current || !episodeOwnerCurrent()) return current;
          const refreshed = queryClient.getQueryState<InboxPage>([
            ...inboxViewerQueryKey(viewer),
            episode,
            current.selection,
            current.cursor ?? null,
          ]);
          return confirmInboxNoticeSeen(
            receiveInboxPage(current, refreshed?.data, refreshed?.status === 'error'),
            attempt.noticeId,
          );
        });
        noticeAttempt.current = null;
        noticeRecovery.current = null;
        setNoticeAttemptView(null);
        setNoticeRecoveryView(null);
        setNoticeConfirmedId(attempt.noticeId);
      } catch (error: unknown) {
        if (active.current && episodeOwnerCurrent() && noticeAttempt.current === attempt) {
          const failure = inboxSeenFailure(error).failure;
          const next = inboxAcknowledgementRecovery(attempt, failure, Date.now());
          noticeRecovery.current = next;
          setNoticeRecoveryView(next);
        }
      } finally {
        if (active.current && episodeOwnerCurrent()) {
          noticeMarking.current = false;
          setNoticePendingId(null);
        }
      }
    },
    [acknowledgeNotice, episode, episodeOwnerCurrent, pageIntent, pageQueryFetching, queryClient, viewer],
  );

  const markLoadedThroughLatest = () => {
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      !inboxViewerCsrfToken(queryClient, viewer) ||
      !episodeOwnerCurrent() ||
      !page ||
      !admittedMarkSeen ||
      noticeAttempt.current !== null ||
      seenIntent.current ||
      seenFailure ||
      marking.current ||
      accessPending.current ||
      pageQueryFetching(pageIntent)
    )
      return;
    if (markedThrough.current === admittedMarkSeen.through) return;
    const attempt = Object.freeze({ through: admittedMarkSeen.through, idempotencyKey: crypto.randomUUID() });
    const intent: InboxLoadedSeenIntent = Object.freeze({
      attempt,
      // Keep this bounded original eligible range with the key; later arrivals cannot join an exact retry.
      eligibleNoticeIds: Object.freeze(readable?.items.map((item) => item.id) ?? []),
    });
    seenIntent.current = intent;
    seenRecovery.current = null;
    setSeenRecoveryView(null);
    setSeenConfirmed(false);
    void sendSeenAttempt(intent, false, pageIntent);
  };

  const chooseSelection = (next: InboxSelection) => {
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      !episodeOwnerCurrent() ||
      pageQueryFetching(pageIntent) ||
      noticeAttempt.current !== null ||
      accessPending.current ||
      pageWaitActive(pageIntent)
    )
      return;
    const first = selectInboxPage(received, next);
    if (first === received) return;
    void queryClient.cancelQueries({ queryKey: inboxViewerQueryKey(viewer) });
    queryClient.removeQueries({ queryKey: inboxViewerQueryKey(viewer) });
    setPagination(first);
  };

  const markNoticeSeen = (noticeId: string) => {
    const item = readable?.items.find((candidate) => candidate.id === noticeId);
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      !episodeOwnerCurrent() ||
      !inboxViewerCsrfToken(queryClient, viewer) ||
      !page ||
      !item?.unread ||
      noticeAttempt.current !== null ||
      seenIntent.current !== null ||
      marking.current ||
      pageQueryFetching(pageIntent)
    )
      return;
    const attempt = Object.freeze({
      accountId: viewer.subject,
      noticeId: item.id,
      idempotencyKey: crypto.randomUUID(),
    });
    noticeAttempt.current = attempt;
    noticeRecovery.current = null;
    setNoticeAttemptView(attempt);
    setNoticeRecoveryView(null);
    setNoticeConfirmedId(null);
    void sendNoticeSeenAttempt(attempt, false, pageIntent);
  };

  const retryNoticeSeen = () => {
    const attempt = noticeAttempt.current;
    const recovery = noticeRecovery.current;
    if (
      !attempt ||
      !inboxAcknowledgementRetryAllowed(recovery, attempt) ||
      noticeMarking.current ||
      pageIntentRef.current !== pageIntent ||
      pageQueryFetching(pageIntent) ||
      !episodeOwnerCurrent()
    )
      return;
    void sendNoticeSeenAttempt(attempt, true, pageIntent);
  };

  const retryLoadedSeen = () => {
    const intent = seenIntent.current;
    if (
      !intent ||
      !inboxAcknowledgementRetryAllowed(seenRecovery.current, intent.attempt) ||
      marking.current ||
      pageIntentRef.current !== pageIntent ||
      pageQueryFetching(pageIntent) ||
      !inboxViewerCsrfToken(queryClient, viewer) ||
      !episodeOwnerCurrent()
    )
      return;
    void sendSeenAttempt(intent, true, pageIntent);
  };

  const checkAccess = async () => {
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      accessPending.current ||
      marking.current ||
      noticeMarking.current ||
      pageQueryFetching(pageIntent) ||
      pageWaitActive(pageIntent) ||
      !episodeOwnerCurrent()
    )
      return;
    accessPending.current = true;
    setCheckingAccess(true);
    setAccessCheck(undefined);
    try {
      // Session freshness alone grants nothing. The unchanged viewer must pass the same bounded page read.
      await retryInboxSession(queryClient);
      if (!active.current || !episodeOwnerCurrent()) return;
      const result = await pageQuery.refetch({ cancelRefetch: false });
      if (active.current && episodeOwnerCurrent())
        setAccessCheck(
          !result.isError && result.data?.signedIn && result.data.state === 'ready' ? 'checked' : 'unavailable',
        );
    } catch {
      if (active.current && episodeOwnerCurrent()) setAccessCheck('unavailable');
    } finally {
      if (active.current && episodeOwnerCurrent()) {
        accessPending.current = false;
        setCheckingAccess(false);
      }
    }
  };

  const loadMore = () => {
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      !episodeOwnerCurrent() ||
      continuation.current ||
      noticeAttempt.current !== null ||
      pageQueryFetching(pageIntent) ||
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
    if (
      !active.current ||
      pageIntentRef.current !== pageIntent ||
      pageQueryFetching(pageIntent) ||
      noticeAttempt.current !== null ||
      accessPending.current ||
      pageWaitActive(pageIntent) ||
      !episodeOwnerCurrent()
    )
      return;
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
      pageIntentRef.current !== pageIntent ||
      !episodeOwnerCurrent() ||
      continuation.current ||
      pageQueryFetching(pageIntent) ||
      accessPending.current ||
      pageWaitActive(pageIntent)
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
  const noticeAttemptRowVisible =
    noticeAttemptView !== null && visibleItems.some((item) => item.id === noticeAttemptView.noticeId);
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
            : operationState?.failure.code === 'invalid_cursor'
              ? m.inbox_invalid_cursor()
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
            disabled={pageQueryFetching(pageIntent) || checkingAccess || waiting}
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
      <InboxUnreadSummary />
      <p role="status" aria-atomic="true" className="sr-only">
        {continuationMessage}
      </p>
      {noticeAttemptView && !noticeAttemptRowVisible ? (
        <section
          role="status"
          data-response-status={noticeFailure?.status ?? ''}
          data-response-code={noticeFailure?.code ?? ''}
          data-retry-after={noticeFailure?.retryAfter}
          aria-busy={noticePendingId === noticeAttemptView.noticeId}
          className="mt-4 space-y-2"
        >
          <p>
            {noticeFailure
              ? acknowledgementFailureMessage(noticeFailure)
              : noticePendingId === noticeAttemptView.noticeId
                ? m.inbox_notice_marking_seen()
                : m.inbox_notice_seen_unknown()}
          </p>
          {noticeWaiting ? <p>{m.settings_retry_wait()}</p> : null}
          {noticeFailure ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal py-2"
              disabled={
                noticeWaiting ||
                noticeMarking.current ||
                pageQueryFetching(pageIntent) ||
                !csrfToken ||
                !episodeOwnerCurrent()
              }
              onClick={retryNoticeSeen}
            >
              {m.inbox_notice_seen_retry()}
            </Button>
          ) : null}
        </section>
      ) : null}
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
          <p>{acknowledgementFailureMessage(seenFailure)}</p>
          <p>{m.inbox_seen_readable()}</p>
          {seenWaiting ? <p>{m.settings_retry_wait()}</p> : null}
          <div className="flex flex-wrap items-start gap-3">
            <Button
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal py-2"
              disabled={
                pageWaitActive(pageIntent) ||
                checkingAccess ||
                markingPending ||
                pageQueryFetching(pageIntent) ||
                !episodeOwnerCurrent()
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
                    noticeAttempt.current !== null ||
                    markingPending ||
                    checkingAccess ||
                    pageQueryFetching(pageIntent) ||
                    !csrfToken ||
                    !episodeOwnerCurrent()
                  }
                  onClick={retryLoadedSeen}
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
              disabled={checkingAccess || waiting}
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
                  aria-pressed={selection === 'all'}
                  className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
                  onClick={() => chooseSelection('all')}
                >
                  {m.inbox_triage_filter_all()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={selection === 'unread'}
                  className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
                  onClick={() => chooseSelection('unread')}
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
                  disabled={pageQueryFetching(pageIntent) || checkingAccess || waiting}
                >
                  {m.inbox_start_first_page()}
                </Button>
              ) : null}
              <p className="text-sm text-muted-foreground">{m.inbox_triage_scope()}</p>
              {admittedMarkSeen && !seenFailure && admittedMarkSeen.through !== markedThrough.current ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{m.inbox_triage_mark_help()}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal py-2"
                    disabled={
                      markingPending ||
                      noticeAttempt.current !== null ||
                      checkingAccess ||
                      pageQueryFetching(pageIntent) ||
                      !csrfToken ||
                      !episodeOwnerCurrent() ||
                      page === null ||
                      seenIntent.current !== null
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
            ) : readable.items.length === 0 ? (
              <section className="mt-6 space-y-3">
                <p role="status" className="text-muted-foreground">
                  {selection === 'unread' ? m.inbox_triage_no_unread_loaded() : m.inbox_triage_no_loaded()}
                </p>
                <p className="text-sm text-muted-foreground">{m.inbox_selection_sparse()}</p>
                {readable.next ? <p className="text-sm text-muted-foreground">{m.inbox_triage_older_pages()}</p> : null}
              </section>
            ) : (
              <InboxRows
                page={{
                  ...readable,
                  items: visibleItems,
                }}
                onMarkSeen={markNoticeSeen}
                onRetrySeen={retryNoticeSeen}
                pendingNoticeId={noticePendingId}
                uncertainNoticeId={noticeFailure ? (noticeAttemptView?.noticeId ?? null) : null}
                noticeFailure={noticeFailure}
                noticeWaiting={noticeWaiting}
                noticeRetryBlocked={
                  noticeMarking.current ||
                  pageQueryFetching(pageIntent) ||
                  !csrfToken ||
                  !episodeOwnerCurrent()
                }
                acknowledgementBlocked={
                  noticeAttemptView !== null ||
                  seenIntent.current !== null ||
                  markingPending ||
                  checkingAccess ||
                  pageQueryFetching(pageIntent) ||
                  page === null ||
                  !csrfToken ||
                  !episodeOwnerCurrent()
                }
                confirmedNoticeId={noticeConfirmedId}
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
              aria-disabled={
                continuing || pageQueryFetching(pageIntent) || checkingAccess || (failed && pageWaitActive(pageIntent))
              }
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
