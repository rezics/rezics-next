'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, EyeIcon, EyeOffIcon, MessageCircleIcon, MessageSquareReplyIcon, ReplyIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { JoinButton, pill, ShareButton, type VoteTarget, VoteControl } from './actions.tsx';
import { announcesSpoilers, discussionText } from './discussion.ts';
import { useFeed } from './feed-context.tsx';
import { absoluteTime, relativeTime } from './time.ts';
import type { Avatar, FeedItem, Name } from './types.ts';

/** CJK body text: a taller line and spacing between Han and Latin runs. */
export const readableText = '[text-autospace:normal] [&:is(:lang(zh),:lang(ja),:lang(ko))]:leading-[1.8]';

/** A discussion or a reply as a post, wherever it is listed: Home, a Realm's Discussions, a Work's. */
export interface DiscussionPost {
  kind: 'discussion' | 'reply';
  /** The thread page: the discussion, or the reply with its parents for context. */
  href: string;
  vote: VoteTarget;
  /** The Realm it was posted in; left out where the page is the Realm's own. */
  realm: FeedItem['realm'];
  author: { name: string; handle: string } | null;
  time: string;
  /** The author's words: a discussion's first line is its title. */
  text: string;
  language: string | null;
  work: { id: string; title: Name; cover: Avatar; types: readonly string[] } | null;
  comments: { value: number; kind: 'exact' | 'lower-bound' } | null;
  /** Discussions Home grouped under this one, and where to find them. */
  more?: { count: number; href: string } | null;
}

function Byline({ post }: { post: DiscussionPost }) {
  const { t, locale, now, avatarQuery, realmPath } = useFeed();
  const author = post.author
    ? <LocalizedLink href={`/@${post.author.handle}`} className={cn('relative z-10 truncate outline-none hover:underline',
      'focus-visible:ring-2 focus-visible:ring-ring', !post.realm && 'font-semibold text-foreground')}>
      {post.author.name}</LocalizedLink>
    : <span className="truncate italic">{t.someone}</span>;
  return <div className="flex min-w-0 items-center gap-2 text-[13px]">
    {post.realm ? <CommunityIcon icon={post.realm.icon} name={post.realm.name.value} avatarQuery={avatarQuery} />
      : <CommunityIcon icon={null} name={post.author?.name ?? '·'} person />}
    <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      {post.realm ? <>
        <LocalizedLink href={realmPath(post.realm.id)} lang={post.realm.name.language}
          className="relative z-10 truncate font-semibold text-foreground outline-none hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{post.realm.name.value}</LocalizedLink>
        <span aria-hidden="true">·</span>
      </> : null}
      {author}
      <span aria-hidden="true">·</span>
      <time dateTime={post.time} title={absoluteTime(post.time, locale)} suppressHydrationWarning
        className="whitespace-nowrap">{relativeTime(post.time, now, locale)}</time>
    </p>
    {post.realm ? <JoinButton realm={post.realm} /> : null}
  </div>;
}

/** The Work a discussion is about, as a link post names its site. */
function AboutWork({ work }: { work: NonNullable<DiscussionPost['work']> }) {
  const { t } = useFeed();
  const marker = '⁣';
  const [before = '', after = ''] = t.aboutWork({ title: marker }).split(marker);
  return <LocalizedLink href={`/w/${work.id.slice(-36)}`} className="relative z-10 inline-flex max-w-full items-center
    gap-1.5 self-start rounded-full text-muted-foreground text-xs outline-none hover:text-foreground
    hover:underline focus-visible:ring-2 focus-visible:ring-ring">
    <BookOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="truncate">{before}<span lang={work.title.language} className="font-medium">
      {work.title.value}</span>{after}</span>
  </LocalizedLink>;
}

/** A spoiler the author announced: the words stay out of the page until the reader asks for them. */
export function SpoilerVeil({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useFeed();
  const [shown, setShown] = useState(false);
  const id = useId();
  if (shown) return <div id={id} className={className}>{children}</div>;
  return <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/70',
    'border-dashed bg-muted/40 px-3 py-2.5 text-sm', className)}>
    <EyeOffIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 text-muted-foreground">{t.spoilerAnnounced}</span>
    <button type="button" aria-controls={id} onClick={() => setShown(true)}
      className={cn(buttonVariants({ variant: 'outline', size: 'xs', pill: true }), 'relative z-10')}>
      <EyeIcon aria-hidden="true" />{t.showSpoiler}</button>
  </div>;
}

/**
 * A discussion as Reddit's card view shows a post: where and who, the title,
 * a few lines, the Work it is about, then votes, comments and Reply. A reply
 * reads as a quoted comment that opens its place in the thread.
 */
export function DiscussionCard({ post, menu, position, total }: { post: DiscussionPost;
  /** The feed's hide and mute menu, where the post came from Home. */
  menu?: ReactNode; position?: number; total?: number }) {
  const { t, locale, avatarQuery } = useFeed();
  const titleId = useId();
  const { title, body } = post.kind === 'discussion' ? discussionText(post.text) : { title: '', body: post.text.trim() };
  const spoiler = post.kind === 'discussion' && announcesSpoilers(title);
  const count = post.comments ? new Intl.NumberFormat(locale, { notation: 'compact' }).format(post.comments.value) : null;
  const heading = post.kind === 'discussion' ? title || t.untitled : t.replyIn;
  const text = body ? <p lang={post.language ?? undefined} className={cn(
    post.kind === 'discussion' ? 'line-clamp-3 text-muted-foreground' : 'line-clamp-4 border-border border-s-2 ps-3',
    'whitespace-pre-line text-pretty text-sm/relaxed [overflow-wrap:anywhere]', readableText)}>{body}</p> : null;
  return <article aria-labelledby={titleId} aria-posinset={position} aria-setsize={position ? total ?? -1 : undefined}
    data-kind={post.kind} className="group/post relative grid gap-2 border-border/60 border-b px-3 py-3.5
      transition-colors hover:bg-accent/25 sm:px-4">
    <Byline post={post} />
    <div className={cn('grid gap-x-4', post.work && 'grid-cols-[minmax(0,1fr)_auto]')}>
      <div className="grid min-w-0 content-start gap-1.5">
        {post.kind === 'reply' ? <p className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
          <MessageSquareReplyIcon aria-hidden="true" className="size-3.5 shrink-0" />{t.reply}</p> : null}
        <h3 id={titleId} lang={post.kind === 'discussion' ? post.language ?? undefined : undefined}
          className={cn('text-pretty font-semibold [overflow-wrap:anywhere]', post.kind === 'discussion'
            ? 'text-[1.0625rem]/snug sm:text-lg/snug' : 'sr-only')}>
          <LocalizedLink href={post.href} className="outline-none decoration-1 underline-offset-2 hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{heading}</LocalizedLink>
        </h3>
        {spoiler ? <span className="w-fit rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-[11px]
          text-warning-foreground uppercase tracking-wide">{t.spoilerTag}</span> : null}
        {text ? spoiler ? <SpoilerVeil>{text}</SpoilerVeil> : text : null}
        {post.work ? <AboutWork work={post.work} /> : null}
        {post.more?.count ? <LocalizedLink href={post.more.href} className="w-fit font-medium text-primary text-xs
          underline-offset-4 hover:underline">{t.moreDiscussions(post.more.count)}</LocalizedLink> : null}
      </div>
      {post.work ? <LocalizedLink href={`/w/${post.work.id.slice(-36)}`} tabIndex={-1} aria-hidden="true"
        className="self-start">
        <CatalogueCover work={{ id: post.work.id, title: post.work.title, cover: post.work.cover,
          kind: coverKindOf(post.work.types), authors: [] }} avatarQuery={avatarQuery} size="xs"
        className="sm:w-12" />
      </LocalizedLink> : null}
    </div>
    <div role="group" aria-label={t.actions} className="-ms-1 flex flex-wrap items-center gap-1.5">
      <VoteControl target={post.vote} />
      {post.comments && count !== null ? <LocalizedLink href={`${post.href}#comments`} className={pill}
        aria-label={post.comments.kind === 'exact' ? t.comments(post.comments.value)
          : t.commentsAtLeast(post.comments.value)}>
        <MessageCircleIcon aria-hidden="true" className="size-4" />
        <span aria-hidden="true" className="tabular-nums">{count}{post.comments.kind === 'exact' ? '' : '+'}</span>
      </LocalizedLink> : null}
      <LocalizedLink href={`${post.href}#reply`} className={pill}>
        <ReplyIcon aria-hidden="true" className="size-4" />{post.kind === 'discussion' ? t.replyAction : t.viewThread}
      </LocalizedLink>
      <ShareButton href={post.href} title={heading} />
      {menu}
    </div>
  </article>;
}
