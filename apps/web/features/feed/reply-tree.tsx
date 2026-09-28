'use client';

import { cn } from '@rezics/ui/utils';
import { ArrowRightIcon, CheckIcon, LinkIcon, MinusIcon, PlusIcon, ReplyIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { VoteControl } from './actions.tsx';
import { readableText } from './post-row.tsx';
import { useFeed } from './feed-context.tsx';
import { ReplyComposer, type ReplyTarget } from './reply-composer.tsx';
import { type ReplyNode, THREAD_DEPTH, type ThreadReply } from './thread.ts';
import { absoluteTime, relativeTime } from './time.ts';

/** Replies scored this low start folded, as Reddit folds them; one tap opens them. */
const FOLD_SCORE = -5;

const action = 'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium text-muted-foreground text-xs '
  + 'outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 '
  + 'focus-visible:ring-ring';

export interface ThreadContext {
  target: ReplyTarget;
  /** A reply's own page, where a deep branch continues. */
  replyHref: (reply: string) => string;
  /** Who opened the discussion, marked OP beside their replies. */
  opener: string | null;
}

/** Copies a reply's own address. */
function CopyLink({ href }: { href: string }) {
  const { t, locale } = useFeed();
  const [copied, setCopied] = useState(false);
  return <button type="button" className={cn(action, 'max-sm:hidden')} onClick={() => {
    const url = new URL(href.startsWith(`/${locale}/`) ? href : `/${locale}${href}`, location.origin).toString();
    void navigator.clipboard.writeText(url).then(() => setCopied(true), () => setCopied(false));
  }}>
    {copied ? <CheckIcon aria-hidden="true" className="size-3.5 text-success-foreground" />
      : <LinkIcon aria-hidden="true" className="size-3.5" />}{copied ? t.linkCopied : t.copyLink}
    {copied ? <span role="status" className="sr-only">{t.linkCopied}</span> : null}
  </button>;
}

/** The reply's words, paragraph by paragraph, in its own language. */
export function ReplyBody({ reply, className }: { reply: ThreadReply; className?: string }) {
  return <div lang={reply.language ?? undefined} className={cn('grid gap-2 text-pretty text-[0.9375rem]/relaxed',
    '[overflow-wrap:anywhere]', readableText, className)}>
    {reply.body.split(/\n{2,}/).map((paragraph, index) => <p key={index} className="whitespace-pre-line">
      {paragraph}</p>)}
  </div>;
}

/** Who wrote it and when; the discussion's opener is marked OP. */
export function ReplyByline({ reply, opener, id }: { reply: ThreadReply; opener: string | null; id?: string }) {
  const { t, locale, now } = useFeed();
  return <p id={id} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
    {reply.author ? <LocalizedLink href={`/@${reply.author.handle}`} className="truncate font-semibold text-foreground
      outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{reply.author.name}</LocalizedLink>
      : <span className="italic">{t.someone}</span>}
    {reply.author && reply.author.id === opener ? <abbr title={t.originalPoster} className="rounded bg-info/10 px-1
      font-semibold text-[11px] text-info-foreground no-underline">{t.op}</abbr> : null}
    <span aria-hidden="true">·</span>
    <time dateTime={reply.time} title={absoluteTime(reply.time, locale)} suppressHydrationWarning>
      {relativeTime(reply.time, now, locale)}</time>
  </p>;
}

/**
 * One reply and its replies, as a Reddit comment: the author's mark with a
 * line running down beside the replies that folds the branch, the words, then
 * vote, Reply and link. Past `THREAD_DEPTH` a branch continues on the reply's
 * own page.
 */
function Reply({ node, context }: { node: ReplyNode; context: ThreadContext }) {
  const { t } = useFeed();
  const { reply } = node;
  const [folded, setFolded] = useState(reply.vote.score <= FOLD_SCORE);
  const [replying, setReplying] = useState(false);
  const bylineId = useId();
  const repliesId = useId();
  const name = reply.author?.name ?? t.someone;
  const deep = node.depth >= THREAD_DEPTH && node.children.length > 0;
  return <li className="min-w-0">
    <article aria-labelledby={bylineId} id={`reply-${reply.reply.slice(-36)}`} className="grid scroll-mt-24
      grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
      <div className="col-start-1 row-start-1 grid place-items-center">
        <CommunityIcon icon={null} name={name} person className="size-7 text-[11px]" />
      </div>
      <div className="col-start-2 row-start-1 flex min-h-7 items-center">
        <ReplyByline reply={reply} opener={context.opener} id={bylineId} />
      </div>
      {/* The line beside the replies folds this branch, as on Reddit; the button is its keyboard twin. */}
      <button type="button" aria-expanded={!folded} aria-controls={repliesId}
        aria-label={folded ? t.expandReply({ name }) : t.collapseReply({ name })} onClick={() => setFolded(!folded)}
        className="group/line col-start-1 row-start-2 flex cursor-pointer justify-center pt-1 outline-none">
        {folded ? <span className="grid size-5 place-items-center rounded-full border border-border bg-background
          text-muted-foreground group-hover/line:border-foreground/50 group-focus-visible/line:ring-2
          group-focus-visible/line:ring-ring"><PlusIcon aria-hidden="true" className="size-3" /></span>
          : <span className="h-full w-px bg-border transition-colors group-hover/line:bg-foreground/50
            group-focus-visible/line:w-0.5 group-focus-visible/line:bg-ring" />}
      </button>
      {folded ? <p className="col-start-2 row-start-2 self-center text-muted-foreground text-xs">
        {node.descendants ? t.foldedReplies(node.descendants + 1) : t.folded}</p> : null}
      <div id={repliesId} hidden={folded} className="col-start-2 row-start-2 grid min-w-0 gap-1.5 pt-0.5">
        <ReplyBody reply={reply} />
        <div role="group" aria-label={t.actions} className="-ms-1.5 flex flex-wrap items-center gap-0.5">
          <VoteControl target={{ id: reply.placement, vote: reply.vote.value, score: reply.vote.score,
            revision: reply.vote.revision, open: reply.vote.open }} plain />
          <button type="button" aria-expanded={replying} className={action} onClick={() => setReplying(!replying)}>
            <ReplyIcon aria-hidden="true" className="size-3.5" />{t.replyAction}</button>
          <CopyLink href={context.replyHref(reply.reply)} />
          <button type="button" className={cn(action, 'sm:hidden')} onClick={() => setFolded(true)}>
            <MinusIcon aria-hidden="true" className="size-3.5" />{t.collapse}</button>
        </div>
        {replying ? <div className="pt-1">
          <ReplyComposer target={context.target} parent={{ reply: reply.reply, revisionId: reply.revisionId }}
            parentAuthor={name} inline autoFocus onDone={() => setReplying(false)} />
        </div> : null}
        {deep ? <LocalizedLink href={context.replyHref(reply.reply)} className="inline-flex w-fit items-center gap-1.5
          py-1 font-medium text-primary text-sm underline-offset-4 hover:underline">
          {t.continueThread}<ArrowRightIcon aria-hidden="true" className="size-4" /></LocalizedLink>
          : node.children.length ? <ReplyList nodes={node.children} context={context} /> : null}
      </div>
    </article>
  </li>;
}

/** Sibling replies, in the order Main sorted them. */
export function ReplyList({ nodes, context }: { nodes: readonly ReplyNode[]; context: ThreadContext }) {
  return <ul className="grid gap-4 pt-2">
    {nodes.map(node => <Reply key={node.reply.reply} node={node} context={context} />)}
  </ul>;
}
