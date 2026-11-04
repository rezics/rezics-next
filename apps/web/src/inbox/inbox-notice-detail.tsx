import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { ArrowLeft, Bell, ExternalLink, Flag, Gavel, MessageCircleReply } from 'lucide-react';
import {
  inboxNoticeQuery,
  markInboxViewerNoticeSeen,
  type InboxNoticeLoader,
} from './inbox-query';
import {
  inboxNoticeFailure,
  inboxOpenHref,
  inboxTargetContext,
  inboxSeenFailure,
  type InboxNoticePage,
  type InboxNoticeSeenAttempt,
  type NativeInboxFailure,
} from './inbox-read';
import { inboxViewerCsrfToken, useInboxViewer, type InboxViewer } from './inbox-viewer';
import { InboxEntryState } from './inbox-entry-state';
import { initials } from '../threads/initials';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';

type NoticeSeenTransport = (attempt: InboxNoticeSeenAttempt, csrfToken: string) => Promise<void>;

function validNoticeId(value: string) {
  return value.length > 0 && value.length <= 128 && !/[\s/\\?#%\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..';
}

function unavailable(failure: NativeInboxFailure | undefined) {
  return (
    failure?.status === 401 ||
    failure?.status === 403 ||
    failure?.status === 404 ||
    failure?.code === 'unauthorized' ||
    failure?.code === 'forbidden' ||
    failure?.code === 'not_found'
  );
}

function retryable(failure: NativeInboxFailure) {
  if (failure.code === 'platform_closed' || unavailable(failure)) return false;
  return failure.retryable !== false && (failure.status === null || failure.status === 408 || failure.status === 429 || failure.status >= 500);
}

function unknownOutcome(failure: NativeInboxFailure) {
  return failure.status === null || failure.status === 408 || failure.status >= 500;
}

function backHref(cursor: string | undefined, view: 'all' | 'unread') {
  const query = new URLSearchParams({ view });
  if (cursor !== undefined) query.set('cursor', cursor);
  return localizeHref(`/inbox?${query.toString()}`);
}

function eventKind(notice: NonNullable<Extract<InboxNoticePage, { state: 'ready' }>['notice']>) {
  if (notice.reportId) return <Flag aria-hidden="true" size={18} />;
  if (notice.kind === 'moderation_decision') return <Gavel aria-hidden="true" size={18} />;
  if (notice.kind === 'thread_watch' || notice.kind === 'board_activity') return <Bell aria-hidden="true" size={18} />;
  return <MessageCircleReply aria-hidden="true" size={18} />;
}

export function InboxNoticeDetailPage({
  noticeId,
  cursor,
  view,
  loadNotice,
  acknowledgeNotice,
}: {
  noticeId: string;
  cursor?: string;
  view: 'all' | 'unread';
  loadNotice?: InboxNoticeLoader;
  acknowledgeNotice?: NoticeSeenTransport;
}) {
  const { state, csrfToken, viewer, sessionRead } = useInboxViewer();
  if (!viewer) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <a href={backHref(cursor, view)} className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4">
          <ArrowLeft aria-hidden="true" size={18} />
          {m.inbox_notice_back()}
        </a>
        <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">{m.inbox_notice_detail_heading()}</h1>
        <InboxEntryState state={state} sessionRead={sessionRead} />
      </main>
    );
  }
  return (
    <ViewerInboxNoticeDetail
      key={JSON.stringify([viewer.subject, viewer.epoch, noticeId])}
      viewer={viewer}
      csrfToken={csrfToken}
      noticeId={noticeId}
      cursor={cursor}
      view={view}
      loadNotice={loadNotice}
      acknowledgeNotice={acknowledgeNotice}
    />
  );
}

function ViewerInboxNoticeDetail({
  viewer,
  csrfToken,
  noticeId,
  cursor,
  view,
  loadNotice,
  acknowledgeNotice,
}: {
  viewer: InboxViewer;
  csrfToken: string | null;
  noticeId: string;
  cursor?: string;
  view: 'all' | 'unread';
  loadNotice?: InboxNoticeLoader;
  acknowledgeNotice?: NoticeSeenTransport;
}) {
  const client = useQueryClient();
  const query = useQuery(inboxNoticeQuery(viewer, noticeId, loadNotice));
  const active = useRef(false);
  const sending = useRef(false);
  const attempt = useRef<InboxNoticeSeenAttempt | null>(null);
  const [pending, setPending] = useState(false);
  const [commandFailure, setCommandFailure] = useState<NativeInboxFailure>();
  const [confirmed, setConfirmed] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sending.current = false;
      attempt.current = null;
    };
  }, []);

  const sendAcknowledgement = async (original: InboxNoticeSeenAttempt) => {
    if (!active.current || !viewer.isCurrent() || sending.current) return;
    const token = inboxViewerCsrfToken(client, viewer);
    if (!token) return;
    sending.current = true;
    setPending(true);
    try {
      const send = acknowledgeNotice
        ? async ({ data }: { data: InboxNoticeSeenAttempt; headers: HeadersInit }) => {
            await acknowledgeNotice(data, token);
            return { signedIn: true as const };
          }
        : undefined;
      await markInboxViewerNoticeSeen(
        client,
        viewer,
        original,
        token,
        send,
        () => active.current,
      );
      if (!active.current || !viewer.isCurrent()) return;
      attempt.current = null;
      setCommandFailure(undefined);
      setConfirmed(true);
    } catch (error: unknown) {
      if (!active.current || !viewer.isCurrent() || (error instanceof DOMException && error.name === 'AbortError'))
        return;
      const failure = inboxSeenFailure(error).failure;
      setCommandFailure(failure);
      if (unavailable(failure)) {
        setWithdrawn(true);
        attempt.current = null;
        queryClient.removeQueries({ queryKey: inboxNoticeQuery(viewer, noticeId, loadNotice).queryKey, exact: true });
      }
    } finally {
      sending.current = false;
      if (active.current && viewer.isCurrent()) setPending(false);
    }
  };

  const startAcknowledgement = () => {
    const token = inboxViewerCsrfToken(client, viewer);
    if (!active.current || !viewer.isCurrent() || !token || pending || !notice?.unread || withdrawn) return;
    const original =
      attempt.current ??
      Object.freeze({ accountId: viewer.subject, noticeId, idempotencyKey: crypto.randomUUID() });
    attempt.current = original;
    setCommandFailure(undefined);
    setConfirmed(false);
    void sendAcknowledgement(original);
  };

  const nativeFailure =
    query.isError
      ? inboxNoticeFailure(query.error).failure
      : query.data?.signedIn && query.data.state === 'unavailable'
        ? query.data.failure
        : undefined;
  const accessLost = withdrawn || unavailable(nativeFailure) || query.data?.signedIn === false;
  const notice =
    validNoticeId(noticeId) && !accessLost && query.data?.signedIn && query.data.state === 'ready'
      ? query.data.notice
      : undefined;
  const destination = notice ? inboxOpenHref(notice) : undefined;
  const actor = notice?.actor;
  const actorName =
    actor?.state === 'available'
      ? actor.displayName
      : actor?.state === 'system'
        ? m.inbox_actor_moderation()
        : actor?.state === 'withheld'
          ? m.inbox_actor_unknown()
          : undefined;
  const targetContext = notice ? inboxTargetContext(notice.target) : undefined;
  const date =
    notice && Number.isFinite(Date.parse(notice.createdAt))
      ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'long' }).format(
          new Date(notice.createdAt),
        )
      : undefined;

  return (
    <main aria-labelledby="inbox-notice-heading" className="min-h-screen w-full bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <a href={backHref(cursor, view)} className="inline-flex min-h-11 w-fit max-w-full items-center gap-2 underline underline-offset-4">
          <ArrowLeft aria-hidden="true" size={18} />
          {m.inbox_notice_back()}
        </a>
        <h1 id="inbox-notice-heading" className="font-display text-3xl font-semibold tracking-tight">
          {m.inbox_notice_detail_heading()}
        </h1>
        {!validNoticeId(noticeId) ? (
          <p role="status" className="rounded-lg border border-border p-5 text-muted-foreground">
            {m.inbox_unavailable_item()}
          </p>
        ) : accessLost ? (
          <p role="status" className="rounded-lg border border-border p-5 text-muted-foreground">
            {m.inbox_unavailable_item()}
          </p>
        ) : query.isPending ? (
          <p role="status" className="rounded-lg border border-border p-5 text-muted-foreground">
            {m.inbox_loading()}
          </p>
        ) : !notice && nativeFailure ? (
          <section role="status" aria-live="polite" className="grid justify-items-start gap-3 rounded-lg border border-border p-5">
            <p className="text-muted-foreground">{m.inbox_unavailable_item()}</p>
            {retryable(nativeFailure) ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
                disabled={query.isFetching || !viewer.isCurrent()}
                onClick={() => void query.refetch()}
              >
                {m.inbox_retry()}
              </Button>
            ) : null}
          </section>
        ) : notice ? (
          <article className="grid gap-6 rounded-xl border border-border p-5 sm:p-7">
            <div className="flex min-w-0 items-start gap-3">
              {actor?.state === 'available' ? (
                <Avatar aria-hidden="true" size="md" className="shrink-0">
                  {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
                  <AvatarFallback>{initials(actor.displayName)}</AvatarFallback>
                </Avatar>
              ) : (
                <span aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground">
                  {eventKind(notice)}
                </span>
              )}
              <div className="min-w-0">
                <p className="font-medium">{actorName ?? m.inbox_notice_actor_unavailable()}</p>
                {actor?.state === 'available' && actor.handle ? (
                  <p className="break-words text-sm text-muted-foreground">@{actor.handle}</p>
                ) : actor?.state !== 'available' ? (
                  <p className="text-sm text-muted-foreground">{m.inbox_notice_actor_unavailable()}</p>
                ) : null}
              </div>
            </div>

            <section aria-label={m.inbox_notice_event_time()} className="grid gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">{m.inbox_notice_event_time()}</h2>
              <time className="text-sm" dateTime={notice.createdAt}>
                {date ?? notice.createdAt}
              </time>
            </section>

            <section className="grid gap-3">
              <h2 className="text-xl font-medium">{notice.summary}</h2>
              <div className="grid gap-2 rounded-lg bg-muted/40 p-4">
                <h3 className="text-sm font-medium text-muted-foreground">{m.inbox_notice_context()}</h3>
                {notice.target.state === 'available' && targetContext ? (
                  <p>{targetContext}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{m.inbox_notice_target_unavailable()}</p>
                )}
              </div>
            </section>

            <section aria-label={m.inbox_notice_destination()} className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">{m.inbox_notice_destination()}</h2>
              {destination ? (
                <a
                  href={destination}
                  className="inline-flex min-h-11 w-fit max-w-full items-center gap-2 whitespace-normal underline underline-offset-4"
                >
                  <ExternalLink aria-hidden="true" size={17} />
                  {m.inbox_notice_open_destination()}
                </a>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {m.inbox_notice_destination_unavailable()}
                </p>
              )}
            </section>

            <section className="grid justify-items-start gap-3 border-t border-border pt-5">
              <p className="text-sm text-muted-foreground">
                {notice.unread ? m.inbox_notice_unread() : m.inbox_notice_read()}
              </p>
              {confirmed ? <p role="status">{m.inbox_notice_marked_seen()}</p> : null}
              {commandFailure ? (
                <div role="status" aria-live="polite" className="grid gap-2">
                  <p>
                    {unavailable(commandFailure)
                      ? m.inbox_unavailable_item()
                      : unknownOutcome(commandFailure)
                        ? m.inbox_notice_seen_unknown()
                        : m.inbox_notice_ack_refused()}
                  </p>
                  {retryable(commandFailure) ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
                      disabled={pending || !csrfToken || !viewer.isCurrent()}
                      onClick={startAcknowledgement}
                    >
                      {m.inbox_notice_seen_retry()}
                    </Button>
                  ) : null}
                </div>
              ) : notice.unread ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
                  disabled={pending || !csrfToken || !viewer.isCurrent()}
                  onClick={startAcknowledgement}
                >
                  {pending ? m.inbox_notice_marking_seen() : m.inbox_notice_mark_seen()}
                </Button>
              ) : null}
            </section>
          </article>
        ) : query.isPending ? (
          <p role="status" aria-busy="true" className="rounded-lg border border-border p-5 text-muted-foreground">
            {m.inbox_loading()}
          </p>
        ) : (
          <section role="status" className="grid justify-items-start gap-3 rounded-lg border border-border p-5">
            <p className="text-muted-foreground">
              {nativeFailure?.code === 'platform_closed' ? m.inbox_closed() : m.inbox_unavailable()}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal px-3 py-2"
              disabled={query.isFetching || !viewer.isCurrent()}
              onClick={() => void query.refetch({ cancelRefetch: false })}
            >
              {query.isFetching ? m.inbox_loading() : m.inbox_retry()}
            </Button>
          </section>
        )}
      </div>
    </main>
  );
}

