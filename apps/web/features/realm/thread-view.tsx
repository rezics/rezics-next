'use client';

import { cn } from '@rezics/ui/utils';
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ClockIcon,
  FlameIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  TrophyIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { ShareButton, VoteControl } from '../feed/actions.tsx';
import { LinkMenu } from '../feed/controls.tsx';
import { SpoilerVeil } from '../feed/discussion-card.tsx';
import { resourceHref } from '../address/path.ts';
import { announcesSpoilers, threadPath } from '../feed/discussion.ts';
import { useFeed } from '../feed/feed-context.tsx';
import { ReplyComposer, type ReplyMode, type ReplyTarget } from '../feed/reply-composer.tsx';
import { ReplyBody, ReplyByline, ReplyList, type ThreadContext } from '../feed/reply-tree.tsx';
import { mainThreadApi, type ThreadApi } from '../feed/thread-api.ts';
import { replyTree, type ThreadRead, type ThreadReply, type ThreadSort } from '../feed/thread.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

const sortIcons: Record<ThreadSort, typeof FlameIcon> = {
  best: FlameIcon,
  top: TrophyIcon,
  new: ClockIcon,
};

export interface ThreadViewProps {
  read: ThreadRead;
  /** The Realm the thread lives in; `path` is its unlocalized `/r/{ref}`. */
  realm: { id: string; name: string; path: string };
  sort: ThreadSort;
  /** Each sort's address, which keeps the reader on this thread. */
  sortHrefs: Record<ThreadSort, string>;
  replyMode: ReplyMode;
  /** Stories: an in-memory Main. */
  threadApi?: ThreadApi;
}

/** Opens the composer when the page is reached through a card's Reply (`#reply`). */
function useReplyAnchor() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || location.hash !== '#reply') return;
    done.current = true;
    document.querySelector<HTMLTextAreaElement>('#reply textarea')?.focus();
  }, []);
}

/** The Work a thread discusses, with its cover, as a link post names its source. */
function AboutWork({ work }: { work: ThreadRead['work'] }) {
  const { t, avatarQuery } = useFeed();
  return (
    <LocalizedLink
      href={resourceHref('/w/', work.id)}
      className="group/work flex max-w-md items-center gap-3
    rounded-xl border border-border/70 bg-background/60 p-2 pe-3 outline-none transition-colors hover:bg-accent/40
    focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CatalogueCover
        work={{
          id: work.id,
          title: work.title,
          cover: work.cover,
          kind: coverKindOf([]),
          authors: [],
        }}
        avatarQuery={avatarQuery}
        size="xs"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-muted-foreground text-xs">{t.discussedWork}</span>
        <span
          lang={work.title.language}
          className="truncate font-medium text-sm group-hover/work:underline"
        >
          {work.title.value}
        </span>
      </span>
      <ArrowUpRightIcon
        aria-hidden="true"
        className="ms-auto size-4 shrink-0 text-muted-foreground"
      />
    </LocalizedLink>
  );
}

/** The discussion as its own page: who opened it and when, the title, every word, then votes and share. */
function OpeningPost({
  post,
  read,
  realm,
  count,
}: {
  post: ThreadReply;
  read: ThreadRead;
  realm: ThreadViewProps['realm'];
  count: number;
}) {
  const { t } = useFeed();
  const title = post.blocked ? t.blockedUser : (post.title ?? ''),
    body = post.body;
  const href = threadPath(realm.path, post.reply);
  const words = body ? <ReplyBody reply={{ ...post, body }} ratingTarget={read.work.id} className="text-base/relaxed" /> : null;
  return (
    <article aria-labelledby="thread-title" className="grid gap-3">
      <div className="flex items-center gap-2">
        <CommunityIcon
          icon={null}
          name={post.author?.name ?? '·'}
          person
          className="size-8 text-xs"
        />
        <ReplyByline reply={post} opener={null} />
      </div>
      <h1
        id="thread-title"
        lang={post.language ?? undefined}
        className="text-pretty font-semibold text-xl/snug
      [overflow-wrap:anywhere] sm:text-2xl/snug"
      >
        {title || t.untitled}
      </h1>
      {post.blocked ? null : announcesSpoilers(title) ? (
        <>
          <span
            className="w-fit rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-[11px] text-warning-foreground
        uppercase tracking-wide"
          >
            {t.spoilerTag}
          </span>
          {words ? <SpoilerVeil>{words}</SpoilerVeil> : null}
        </>
      ) : (
        words
      )}
      <AboutWork work={read.work} />
      <fieldset className="-ms-1 flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">{t.actions}</legend>
        {post.blocked ? null : (
          <VoteControl
            target={{
              id: post.placement,
              vote: post.vote.value,
              score: post.vote.score,
              revision: post.vote.revision,
              open: post.vote.open,
            }}
          />
        )}
        <a
          href="#comments"
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 font-medium
        text-muted-foreground text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageCircleIcon aria-hidden="true" className="size-4" />
          {t.comments(count)}
          {read.complete ? '' : '+'}
        </a>
        <ShareButton href={href} title={title} />
      </fieldset>
    </article>
  );
}

/** A reply's own page: the discussion it belongs to and the reply it answers, then the reply and its branch. */
function ReplyContext({ read, realm }: { read: ThreadRead; realm: ThreadViewProps['realm'] }) {
  const { t } = useFeed();
  const opening = read.ancestors[0];
  const parent = read.ancestors.at(-1);
  return (
    <div className="grid gap-3">
      {opening && !opening.parent ? (
        <p className="grid gap-1">
          <span className="text-muted-foreground text-xs">{t.openingPost}</span>
          <LocalizedLink
            href={threadPath(realm.path, opening.reply)}
            lang={opening.language ?? undefined}
            className="text-pretty font-semibold text-lg/snug underline-offset-2 hover:underline"
          >
            {opening.title || t.untitled}
          </LocalizedLink>
        </p>
      ) : null}
      <p
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-info/10 px-3 py-2 text-info-foreground
      text-sm"
      >
        <span>{t.singleReply}</span>
        <LocalizedLink
          href={threadPath(realm.path, read.thread)}
          className="font-medium underline
        underline-offset-4"
        >
          {t.wholeDiscussion}
        </LocalizedLink>
      </p>
      {parent && parent.reply !== opening?.reply ? (
        <figure className="grid gap-1 border-border border-s-2 ps-3">
          <figcaption className="text-muted-foreground text-xs">{t.inReplyTo}</figcaption>
          <ReplyByline reply={parent} opener={opening?.author?.id ?? null} />
          <ReplyBody reply={parent} ratingTarget={read.work.id} className="line-clamp-4 text-muted-foreground text-sm" />
        </figure>
      ) : null}
    </div>
  );
}

/**
 * A Reddit-quality thread: the opening post, then its comments nested with
 * fold lines, sorted by Best, Top or New, each with votes and an inline
 * reply. A reply's own page shows its place in the discussion first.
 */
export function ThreadView({
  read,
  realm,
  sort,
  sortHrefs,
  replyMode,
  threadApi,
}: ThreadViewProps) {
  const { t } = useFeed();
  useReplyAnchor();
  const tree = useMemo(() => replyTree(read.items), [read.items]);
  const api = useRef<ThreadApi | null>(threadApi ?? null);
  if (!tree) return null;
  const focus = tree.reply;
  const opening = read.focus === read.thread;
  const opener = opening ? (focus.author?.id ?? null) : (read.ancestors[0]?.author?.id ?? null);
  const target: ReplyTarget = {
    mode: replyMode,
    realm: read.realm,
    work: read.work.id,
    rootRevision: read.rootRevision,
    api: () => (api.current ??= mainThreadApi()),
  };
  const context: ThreadContext = {
    target,
    opener,
    replyHref: (reply) => threadPath(realm.path, reply),
  };
  const replies = opening ? tree.children : [tree];
  const SortIcon = sortIcons[sort];
  const count = tree.descendants;
  return (
    <div className="grid min-w-0 gap-6">
      <LocalizedLink
        href={`${realm.path}/discussions`}
        className="inline-flex w-fit items-center gap-1.5
      text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        {t.backTo({ realm: realm.name })}
      </LocalizedLink>
      {opening ? (
        <OpeningPost post={focus} read={read} realm={realm} count={count} />
      ) : (
        <ReplyContext read={read} realm={realm} />
      )}
      <section
        id="comments"
        aria-labelledby="comments-heading"
        className="grid scroll-mt-24 gap-4 border-border/60
      border-t pt-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="comments-heading" className="font-semibold text-lg">
            {opening ? t.commentsHeading : t.replyIn}
          </h2>
          <LinkMenu
            label={t.sortComments}
            value={sort}
            icon={<SortIcon aria-hidden="true" className="size-4" />}
            options={(['best', 'top', 'new'] as const).map((option) => ({
              value: option,
              label: t[option],
              help: option === 'best' ? t.bestHelp : option === 'top' ? t.topHelp : t.newHelp,
              href: `${sortHrefs[option]}#comments`,
            }))}
          />
        </div>
        {opening ? (
          <ReplyComposer
            id="reply"
            target={target}
            parent={{ reply: focus.reply, revisionId: focus.revisionId }}
          />
        ) : null}
        {replies.length ? (
          <ReplyList nodes={replies} context={context} />
        ) : (
          <EmptyState
            icon={MessagesSquareIcon}
            headingLevel={3}
            title={t.noComments}
            description={t.noCommentsBody}
            className={cn('py-8')}
          />
        )}
        {read.complete ? null : (
          <p
            role="note"
            className="rounded-xl bg-muted/60 px-3 py-2 text-muted-foreground
        text-sm"
          >
            {t.threadIncomplete}
          </p>
        )}
      </section>
    </div>
  );
}
