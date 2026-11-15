import type { NoticeInboxItem } from '@rezics/client';
import { ArrowLeft, Bell, ExternalLink, Flag, Gavel, MessageCircleReply } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { inboxOpenHref, inboxTargetContext, type InboxSelection } from './inbox-read';
import { InboxNoticeActorVisual, inboxNoticeActorPresentation } from './inbox-notice-actor';
import type { InboxContentPort } from './ports/content';

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
  content,
}: {
  notice: NoticeInboxItem;
  selection: InboxSelection;
  cursor?: string;
  content: InboxContentPort;
}) {
  const destination = inboxOpenHref(notice, content.threadHref);
  const actor = notice.actor;
  const actorPresentation = inboxNoticeActorPresentation(
    {
      actor,
      actorId: actor.state === 'available' ? actor.accountId : null,
      kind: notice.kind,
      reportId: notice.reportId,
    },
    content.initials,
  );
  const context = inboxTargetContext(notice.target);

  return (
    <main aria-labelledby="inbox-notice-heading" className="min-h-screen w-full bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <a
          href={inboxNoticeBackHref(selection, cursor)}
          className="inline-flex min-h-11 min-w-11 w-fit max-w-full items-center gap-2 whitespace-normal rounded-sm underline underline-offset-4 wrap-anywhere focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ArrowLeft aria-hidden="true" size={18} className="shrink-0" />
          <span className="min-w-0 wrap-anywhere">{m.inbox_notice_back()}</span>
        </a>
        <article className="grid min-w-0 gap-6 rounded-xl border border-border p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:gap-10">
          <div className="min-w-0 wrap-anywhere">
            <header className="max-w-prose">
              <p className="text-sm font-medium text-muted-foreground">{m.inbox_notice_detail_heading()}</p>
              <h1 id="inbox-notice-heading" className="mt-2 font-display text-3xl font-semibold tracking-tight wrap-anywhere">
                {notice.summary}
              </h1>
              <div className="mt-5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
                <div className="flex min-w-0 items-center gap-3">
                  <InboxNoticeActorVisual
                    presentation={actorPresentation}
                    size="default"
                    avatarClassName="shrink-0"
                    fallbackClassName="mt-1 shrink-0 text-muted-foreground"
                    fallback={eventKind(notice)}
                  />
                  <div className="min-w-0">
                    <p className="wrap-anywhere font-medium">{actorPresentation.label}</p>
                    {actorPresentation.handle ? (
                      <p className="wrap-anywhere text-sm text-muted-foreground">@{actorPresentation.handle}</p>
                    ) : actorPresentation.unavailable ? (
                      <p role="status" className="text-sm text-muted-foreground">
                        {m.inbox_notice_actor_unavailable()}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{m.inbox_notice_event_time()}</p>
                  <time className="wrap-anywhere text-sm text-muted-foreground" dateTime={notice.createdAt}>
                    {eventDate(notice.createdAt)}
                  </time>
                </div>
              </div>
            </header>

            <section className="mt-7 max-w-prose border-s-2 border-border ps-4">
              <h2 className="text-sm font-semibold text-muted-foreground">{m.inbox_notice_context()}</h2>
              {notice.target.state === 'available' && context ? (
                <p className="mt-2 wrap-anywhere leading-relaxed">{context}</p>
              ) : (
                <p role="status" className="mt-2 text-sm text-muted-foreground">
                  {m.inbox_notice_target_unavailable()}
                </p>
              )}
            </section>
          </div>

          <section
            aria-label={m.inbox_notice_destination()}
            className="grid min-w-0 content-start gap-3 rounded-xl border-2 border-primary/30 bg-muted/30 p-4 sm:p-5"
          >
            <h2 className="text-base font-semibold wrap-anywhere">{m.inbox_notice_destination()}</h2>
            {destination ? (
              <a
                href={destination}
                className="inline-flex min-h-11 min-w-11 w-full max-w-full items-center justify-center gap-2 whitespace-normal rounded-md bg-primary px-4 py-3 text-center font-medium text-primary-foreground underline-offset-4 wrap-anywhere hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <ExternalLink aria-hidden="true" size={17} className="shrink-0" />
                <span className="min-w-0 wrap-anywhere">{m.inbox_notice_open_destination()}</span>
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
