import type { NoticeInboxItem } from '@rezics/client';
import { ArrowLeft, Bell, ExternalLink, Flag, Gavel, MessageCircleReply } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { inboxOpenHref, inboxTargetContext, type InboxSelection } from './inbox-read';
import { InboxNoticeActorVisual, inboxNoticeActorPresentation } from './inbox-notice-actor';

export function inboxNoticeBackHref(selection: InboxSelection, cursor?: string): string {
  const query = new URLSearchParams({ selection });
  if (cursor !== undefined) query.set('cursor', cursor);
  return localizeHref(`/inbox?${query.toString()}`);
}

function eventKind(notice: NoticeInboxItem) {
  if (notice.reportId) return <Flag aria-hidden="true" size={18} />;
  if (notice.kind === 'moderation_decision') return <Gavel aria-hidden="true" size={18} />;
  if (notice.kind === 'thread_watch' || notice.kind === 'board_activity') return <Bell aria-hidden="true" size={18} />;
  return <MessageCircleReply aria-hidden="true" size={18} />;
}

function eventDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'long' }).format(new Date(timestamp))
    : value;
}

/** Present only the actor, current context and destination admitted with this native notice. */
export function InboxNoticeDetailView({
  notice,
  selection,
  cursor,
}: {
  notice: NoticeInboxItem;
  selection: InboxSelection;
  cursor?: string;
}) {
  const destination = inboxOpenHref(notice);
  const actor = notice.actor;
  const actorPresentation = inboxNoticeActorPresentation({
    actor,
    actorId: actor.state === 'available' ? actor.accountId : null,
    kind: notice.kind,
    reportId: notice.reportId,
  });
  const context = inboxTargetContext(notice.target);

  return (
    <main aria-labelledby="inbox-notice-heading" className="min-h-screen w-full bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <a
          href={inboxNoticeBackHref(selection, cursor)}
          className="inline-flex min-h-11 w-fit max-w-full items-center gap-2 underline underline-offset-4"
        >
          <ArrowLeft aria-hidden="true" size={18} />
          {m.inbox_notice_back()}
        </a>
        <h1 id="inbox-notice-heading" className="font-display text-3xl font-semibold tracking-tight">
          {m.inbox_notice_detail_heading()}
        </h1>
        <article className="grid gap-6 rounded-xl border border-border p-5 sm:p-7">
          <div className="flex min-w-0 items-start gap-3">
            <InboxNoticeActorVisual
              presentation={actorPresentation}
              size="default"
              avatarClassName="shrink-0"
              fallbackClassName="mt-1 shrink-0 text-muted-foreground"
              fallback={eventKind(notice)}
            />
            <div className="min-w-0">
              <p className="font-medium">{actorPresentation.label}</p>
              {actorPresentation.handle ? (
                <p className="break-words text-sm text-muted-foreground">@{actorPresentation.handle}</p>
              ) : actorPresentation.unavailable ? (
                <p className="text-sm text-muted-foreground">{m.inbox_notice_actor_unavailable()}</p>
              ) : null}
            </div>
          </div>

          <section aria-label={m.inbox_notice_event_time()} className="grid gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">{m.inbox_notice_event_time()}</h2>
            <time className="text-sm" dateTime={notice.createdAt}>
              {eventDate(notice.createdAt)}
            </time>
          </section>

          <section className="grid gap-3">
            <h2 className="text-xl font-medium">{notice.summary}</h2>
            <div className="grid gap-2 rounded-lg bg-muted/40 p-4">
              <h3 className="text-sm font-medium text-muted-foreground">{m.inbox_notice_context()}</h3>
              {notice.target.state === 'available' && context ? (
                <p>{context}</p>
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
        </article>
      </div>
    </main>
  );
}
