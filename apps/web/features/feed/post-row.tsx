'use client';

import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { useFeed } from './feed-context.tsx';
import { absoluteTime, relativeTime } from './time.ts';
import type { Avatar, Name } from './types.ts';

/** CJK body text: a taller line and spacing between Han and Latin runs. */
export const readableText = '[text-autospace:normal] [&:is(:lang(zh),:lang(ja),:lang(ko))]:leading-[1.7]';

/** A bare icon action in a post's bar: no pill until hovered, as X draws them. */
export const barAction = 'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-2 font-medium '
  + 'text-muted-foreground text-[13px] outline-none transition-colors hover:bg-accent hover:text-accent-foreground '
  + 'focus-visible:ring-2 focus-visible:ring-ring';

/** Links inside a row sit above its stretched title link, so they keep their own target. */
export const rowLink = 'relative z-10 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';

/** "3 h ago", with the full date on hover. */
export function PostTime({ time }: { time: string }) {
  const { locale, now } = useFeed();
  return <time dateTime={time} title={absoluteTime(time, locale)} suppressHydrationWarning className="whitespace-nowrap">
    {relativeTime(time, now, locale)}</time>;
}

/** One part of the meta line: `keep` never shrinks (the time); `name` keeps a few letters (a Realm, a person). */
export interface MetaPart { node: ReactNode; keep?: boolean; name?: boolean }

/** The one meta line: its parts joined by dots, each giving way in turn so the line never wraps. */
export function MetaLine({ icon, parts, end }: { icon: ReactNode; parts: readonly (MetaPart | null | false)[];
  end?: ReactNode }) {
  const shown = parts.filter((part): part is MetaPart => Boolean(part));
  return <div className="flex h-6 min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
    {icon}
    <p className="flex min-w-0 flex-1 items-center gap-x-1 overflow-hidden whitespace-nowrap">
      {shown.map((part, index) => <span key={index} className={cn('flex min-w-0 items-center gap-x-1',
        part.keep ? 'shrink-0' : part.name ? 'min-w-[3.5rem] shrink' : 'shrink-[2]')}>
        {index ? <span aria-hidden="true">·</span> : null}
        <span className="min-w-0 truncate">{part.node}</span></span>)}
    </p>
    {end ? <div className="relative z-10 flex shrink-0 items-center gap-1">{end}</div> : null}
  </div>;
}

export interface AttachedWork { id: string; title: Name; cover: Avatar; types: readonly string[]; byline: string | null }

/** The Work a post is about, attached as X attaches a link: its cover and one line of title and author. */
export function WorkAttachment({ work }: { work: AttachedWork }) {
  const { avatarQuery } = useFeed();
  return <LocalizedLink href={`/w/${work.id.slice(-36)}`} className="relative z-10 flex h-8 min-w-0 max-w-full
    items-center gap-2 rounded-lg border border-border/70 bg-background/60 py-0.5 pe-2.5 ps-1 text-[13px] outline-none
    transition-colors hover:border-border hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring sm:max-w-80">
    <CatalogueCover work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types),
      authors: [] }} avatarQuery={avatarQuery} size="xs" className="w-[1.125rem] shrink-0 rounded-[0.125rem]"
    alt="" loading="lazy" />
    <span className="min-w-0 truncate">
      <span lang={work.title.language} dir={work.title.direction} className="font-medium text-foreground">
        {work.title.value}</span>
      {work.byline ? <span className="text-muted-foreground"> · {work.byline}</span> : null}
    </span>
  </LocalizedLink>;
}

/**
 * One post, with X's treatment and Reddit's anatomy: no frame, a divider
 * below, the whole row leading to the post and tinting on hover. One meta
 * line, the post's own title, at most three lines of preview, then the bare
 * action bar with the Work attached beside it. Compact view keeps one line.
 */
export function PostRow({ kind, href, meta, title, titleLang, titleDir, titleClass, label, preview, thumbnail,
  attachment, vote, comments, actions, below, position, total }: {
  kind: string;
  /** Where the row leads; a post with nowhere to go is not clickable. */
  href: string | null;
  meta: ReactNode;
  /** The post's own title; a reply has none and is named by `label` for assistive technology. */
  title: ReactNode | null; titleLang?: string; titleDir?: 'ltr' | 'rtl'; titleClass?: string; label?: string;
  preview?: ReactNode;
  /** The post is a Work: its cover beside the title. */
  thumbnail?: ReactNode;
  attachment?: ReactNode;
  vote: ReactNode; comments?: ReactNode; actions?: ReactNode;
  /** A note under the preview, such as the posts grouped into this one. */
  below?: ReactNode;
  position?: number; total?: number;
}) {
  const { t, view } = useFeed();
  const titleId = useId();
  const heading = title ?? label;
  const link = (children: ReactNode, className?: string) => href
    ? <LocalizedLink href={href} className={cn('outline-none after:absolute after:inset-0 after:content-[""]',
      'focus-visible:underline', className)}>{children}</LocalizedLink> : children;
  const row = 'group/post relative border-border/60 border-b transition-colors hover:bg-foreground/[0.03] '
    + 'has-[:focus-visible]:bg-foreground/[0.03]';
  if (view === 'compact') {
    return <article aria-labelledby={titleId} aria-posinset={position} aria-setsize={position ? total ?? -1 : undefined}
      data-kind={kind} className={cn(row, 'flex min-h-11 items-center gap-2 px-2 py-1 sm:px-3')}>
      <div className="relative z-10 shrink-0">{vote}</div>
      <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
        <h3 id={titleId} lang={titleLang} dir={titleDir} className="min-w-0 truncate font-medium text-sm">
          {link(heading)}</h3>
        <div className="min-w-0 shrink-0 text-xs sm:max-w-[45%] [&_p]:gap-x-1 [&>div]:h-5">{meta}</div>
      </div>
      {comments ? <div className="relative z-10 shrink-0">{comments}</div> : null}
    </article>;
  }
  return <article aria-labelledby={titleId} aria-posinset={position} aria-setsize={position ? total ?? -1 : undefined}
    data-kind={kind} className={cn(row, 'grid gap-1 px-3 pt-2.5 pb-1.5 sm:px-4')}>
    {meta}
    <div className={cn('grid gap-x-3', thumbnail && 'grid-cols-[minmax(0,1fr)_auto]')}>
      <div className="grid min-w-0 content-start gap-0.5">
        <h3 id={titleId} lang={titleLang} dir={titleDir} className={cn(title === null && 'sr-only',
          'line-clamp-2 text-pretty font-semibold text-base/snug [overflow-wrap:anywhere]', titleClass)}>
          {title === null ? heading : link(title)}</h3>
        {preview ? <div className={cn('line-clamp-3 text-muted-foreground text-sm/5 [overflow-wrap:anywhere]',
          readableText)}>{title === null ? link(preview) : preview}</div> : null}
        {below}
      </div>
      {thumbnail ? <div className="relative z-10 row-span-2 self-start">{thumbnail}</div> : null}
    </div>
    <div className="-ms-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">
      <div role="group" aria-label={t.actions} className="relative z-10 flex items-center gap-0.5">
        {vote}{comments}{actions}</div>
      {/* Beside the actions where there is room; on phones the Work comes first, as X puts a link card before them. */}
      {attachment ? <div className="ms-auto flex min-w-0 max-sm:order-first max-sm:ms-2 max-sm:basis-full max-sm:pt-0.5">
        {attachment}</div> : null}
    </div>
  </article>;
}
