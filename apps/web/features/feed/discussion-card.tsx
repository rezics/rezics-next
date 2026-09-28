'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { EyeIcon, EyeOffIcon, MessageCircleIcon, ReplyIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { JoinButton, ShareButton, type VoteTarget, VoteControl } from './actions.tsx';
import { announcesSpoilers } from './discussion.ts';
import { useFeed } from './feed-context.tsx';
import { type AttachedWork, barAction, MetaLine, PostRow, PostTime, rowLink, WorkAttachment } from './post-row.tsx';
import type { FeedItem } from './types.ts';

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
  /** A discussion's title, its author's first line as Main reads it; a reply has none. */
  title: string | null;
  /** The words after the title, or all of a reply's. */
  body: string;
  language: string | null;
  work: AttachedWork | null;
  comments: { value: number; kind: 'exact' | 'lower-bound' } | null;
  /** Discussions Home grouped under this one, and where to find them. */
  more?: { count: number; href: string } | null;
}

/** A spoiler the author announced: the words stay out of the page until the reader asks for them. */
export function SpoilerVeil({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useFeed();
  const [shown, setShown] = useState(false);
  // The words take the veil's place, so the button controls nothing that stays.
  if (shown) return <div className={className}>{children}</div>;
  return <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm', className)}>
    <EyeOffIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="text-muted-foreground">{t.spoilerAnnounced}</span>
    <button type="button" onClick={() => setShown(true)}
      className={cn(buttonVariants({ variant: 'outline', size: 'xs', pill: true }), 'relative z-10 h-6')}>
      <EyeIcon aria-hidden="true" />{t.showSpoiler}</button>
  </div>;
}

/** The Spoiler mark, as Reddit tags a spoiler post. */
export function SpoilerTag() {
  const { t } = useFeed();
  return <span className="rounded bg-warning/15 px-1.5 font-semibold text-[11px] text-warning-foreground uppercase
    tracking-wide">{t.spoilerTag}</span>;
}

/**
 * A discussion as a post: the meta line, the author's first line as its
 * title, a few lines, then votes, comments and Reply with the Work attached.
 * A reply reads as its words, opening its place in the thread.
 */
export function DiscussionCard({ post, menu, position, total }: { post: DiscussionPost;
  /** The feed's hide and mute menu, where the post came from Home. */
  menu?: ReactNode; position?: number; total?: number }) {
  const { t, locale, avatarQuery, realmPath } = useFeed();
  const title = post.title ?? '', body = post.body.trim();
  const spoiler = post.kind === 'discussion' && announcesSpoilers(title);
  const count = post.comments ? new Intl.NumberFormat(locale, { notation: 'compact' }).format(post.comments.value) : null;
  const words = body ? <span lang={post.language ?? undefined} className={cn('whitespace-pre-line',
    post.kind === 'reply' && 'text-foreground')}>{body}</span> : null;
  const author = post.author
    ? <LocalizedLink href={`/@${post.author.handle}`} className={cn(rowLink,
      !post.realm && 'font-semibold text-foreground')}>{post.author.name}</LocalizedLink>
    : <span className="italic">{t.someone}</span>;
  return <PostRow kind={post.kind} href={post.href} position={position} total={total}
    compactMeta={<MetaLine icon={post.realm ? <CommunityIcon icon={post.realm.icon} name={post.realm.name.value}
      avatarQuery={avatarQuery} size="xs" /> : <CommunityIcon icon={null} name={post.author?.name ?? '·'} person size="xs" />}
    parts={[post.realm ? { name: true, node: <LocalizedLink href={realmPath(post.realm.id)} lang={post.realm.name.language}
      className={cn(rowLink, 'font-semibold text-foreground')}>{post.realm.name.value}</LocalizedLink> }
      : { name: true, node: author }, { keep: true, node: <PostTime time={post.time} /> }]} />}
    meta={<MetaLine icon={post.realm ? <CommunityIcon icon={post.realm.icon} name={post.realm.name.value}
      avatarQuery={avatarQuery} size="xs" /> : <CommunityIcon icon={null} name={post.author?.name ?? '·'} person size="xs" />}
    parts={[
      post.realm ? { name: true, node: <LocalizedLink href={realmPath(post.realm.id)} lang={post.realm.name.language}
        className={cn(rowLink, 'font-semibold text-foreground')}>{post.realm.name.value}</LocalizedLink> } : null,
      { name: true, node: author }, { keep: true, node: <PostTime time={post.time} /> },
      post.kind === 'reply' ? { node: t.replied } : null,
      spoiler ? { keep: true, node: <SpoilerTag /> } : null,
    ]} end={<>{post.realm ? <JoinButton realm={post.realm} /> : null}{menu}</>} />}
    title={post.kind === 'discussion' ? title || t.untitled : null} titleLang={post.language ?? undefined}
    label={t.replyIn}
    preview={words ? spoiler ? <SpoilerVeil>{words}</SpoilerVeil> : words : null}
    below={post.more?.count ? <LocalizedLink href={post.more.href} className={cn(rowLink, 'w-fit font-medium',
      'text-primary text-xs underline-offset-4')}>{t.moreDiscussions(post.more.count)}</LocalizedLink> : null}
    attachment={post.work ? <WorkAttachment work={post.work} /> : null}
    vote={<VoteControl target={post.vote} plain />}
    comments={post.comments && count !== null ? <LocalizedLink href={`${post.href}#comments`} className={barAction}
      aria-label={post.comments.kind === 'exact' ? t.comments(post.comments.value)
        : t.commentsAtLeast(post.comments.value)}>
      <MessageCircleIcon aria-hidden="true" className="size-4" />
      <span aria-hidden="true" className="tabular-nums">{count}{post.comments.kind === 'exact' ? '' : '+'}</span>
    </LocalizedLink> : null}
    actions={<>
      <LocalizedLink href={`${post.href}#reply`} className={barAction}>
        <ReplyIcon aria-hidden="true" className="size-4" />{post.kind === 'discussion' ? t.replyAction : t.viewThread}
      </LocalizedLink>
      <ShareButton href={post.href} title={title || body} />
    </>} />;
}
