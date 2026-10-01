'use client';

import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { authorHref } from '../author/route.ts';
import { ReportAction } from '../safety/report-action.tsx';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { useFeed } from './feed-context.tsx';
import type { MetaLead } from './lead.ts';
import { absoluteTime, relativeTime } from './time.ts';
import type { Avatar, FeedItem, Name } from './types.ts';

/**
 * CJK running text: the taller line the frontend direction sets, and spacing
 * between Han and Latin runs. A post's words carry their language on a span
 * inside the preview, beside facts in the reader's, so the line follows them.
 */
export const readableText = '[text-autospace:normal] [&:is(:lang(zh),:lang(ja),:lang(ko))]:leading-[1.8] '
  + '[&_:is(:lang(zh),:lang(ja),:lang(ko))]:leading-[1.8]';

/**
 * A post's rhythm, from X's rows as measured on 2026-09-28 (a public profile at
 * 1440×900 and 390×844): 12 px above and below and 16 px at the sides at every
 * width, 15/20 px text, 12 px before an attachment and before the action bar,
 * and a 20 px bar whose larger targets overhang it. REZICS adds Reddit's title,
 * a step above the text, and keeps its meta line a step below. Skeletons and
 * other lists of posts take the same values, so every list breathes alike.
 */
export const postRhythm = {
  row: 'px-4 py-3',
  /** The meta line: one 20 px line; Follow and the menu overhang it rather than grow it. */
  meta: 'h-5 text-sm',
  /** Meta to title. */
  afterMeta: 'mt-2',
  title: 'text-[1.0625rem]/6 font-semibold',
  /** Title to preview. */
  afterTitle: 'gap-1.5',
  preview: 'text-[0.9375rem]/5',
  /** Before the attachment, and before the action bar. */
  section: 'mt-3',
  /** The action bar's line: 20 px, its 32 px targets centred on it. */
  bar: 'h-5',
} as const;

/** A bare icon action in a post's bar: no pill until hovered, as X draws them. */
export const barAction = 'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-2 font-medium '
  + 'text-muted-foreground text-[13px] outline-none transition-colors hover:bg-accent hover:text-accent-foreground '
  + 'focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4.5';

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
  return <div className={cn('flex min-w-0 items-center gap-2 text-muted-foreground', postRhythm.meta)}>
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

const leading = 'font-semibold text-foreground';

type Person = Pick<FeedItem['actor'], 'name' | 'handle'>;

/** People's names as one list in the reader's language ("Mei, Leo and Aria"), each leading to their profile. */
function People({ people, className }: { people: readonly Person[]; className?: string }) {
  const { locale } = useFeed();
  let next = 0;
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .formatToParts(people.map(person => person.name)).map((part, index) => {
      if (part.type === 'literal') return <span key={index}>{part.value}</span>;
      const person = people[next++]!;
      return <LocalizedLink key={person.handle} href={authorHref({ kind: 'agent', handle: person.handle })}
        className={cn(rowLink, className)}>{part.value}</LocalizedLink>;
    });
}

/**
 * The meta line's face and first parts: the leading identity in bold with
 * its icon, then the other, still a link. `people` is null where the card
 * leaves them unnamed, and empty where the author is gone, which `someone`
 * then says.
 */
export function useIdentity({ lead, realm, people, someone }: { lead: MetaLead; realm: FeedItem['realm'];
  people: readonly Person[] | null; someone?: string }): { icon: ReactNode; parts: MetaPart[] } {
  const { avatarQuery, realmPath } = useFeed();
  const venue = lead === 'realm' ? realm : null;
  const realmPart: MetaPart[] = realm ? [{ name: true, node: <LocalizedLink href={realmPath(realm.id)}
    lang={realm.name.language} dir={realm.name.direction}
    className={cn(rowLink, venue && leading)}>{realm.name.value}</LocalizedLink> }] : [];
  const peoplePart: MetaPart[] = !people ? []
    : people.length ? [{ name: true, node: <People people={people} className={venue ? undefined : leading} /> }]
      : someone ? [{ name: true, node: <span className="italic">{someone}</span> }] : [];
  return {
    icon: venue ? <CommunityIcon icon={venue.icon} name={venue.name.value} avatarQuery={avatarQuery} size="xs" />
      : <CommunityIcon icon={null} name={people?.[0]?.name ?? '·'} person size="xs" />,
    parts: venue ? [...realmPart, ...peoplePart] : [...peoplePart, ...realmPart],
  };
}

export interface AttachedWork { id: string; title: Name; cover: Avatar; types: readonly string[]; byline: string | null }

/** The Work a post is about, on its own line as X attaches a link: its cover and one line of title and author. */
export function WorkAttachment({ work }: { work: AttachedWork }) {
  const { avatarQuery } = useFeed();
  return <LocalizedLink href={`/w/${work.id.slice(-36)}`} className="relative z-10 flex h-11 w-fit min-w-0 max-w-full
    items-center gap-2.5 rounded-xl border border-border/70 bg-background/60 py-1 ps-1 pe-3 text-sm outline-none
    transition-colors hover:border-border hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring sm:max-w-md">
    <CatalogueCover work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types),
      authors: [] }} avatarQuery={avatarQuery} size="xs" className="w-6 shrink-0 rounded-[0.1875rem]"
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
 * below, the whole row leading to the post and tinting on hover (X's 3% ink).
 * In Reddit's order: the meta line, the post's own title, at most three lines
 * of preview, the Work attached, then the bare action bar, spaced as
 * `postRhythm` measures X. There is one view: dense lists are for catalogues.
 */
export function PostRow({ kind, href, report, reportKind = 'post', meta, title, titleLang, titleDir, titleClass, label, preview, thumbnail,
  attachment, vote, comments, actions, below, position, total }: {
  kind: string;
  /** The REZICS ID of what the post is about, which the Report action sends; a post with none cannot be reported here. */
  report?: string | null;
  /** What `report` is: the post itself, or the Work it is about (a review is not a Work and passes no ID until Main accepts review IDs). */
  reportKind?: 'post' | 'work';
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
  const { t } = useFeed();
  const titleId = useId();
  const heading = title ?? label;
  const link = (children: ReactNode, className?: string) => href
    ? <LocalizedLink href={href} className={cn('outline-none after:absolute after:inset-0 after:content-[""]',
      'focus-visible:underline', className)}>{children}</LocalizedLink> : children;
  return <article aria-labelledby={titleId} aria-posinset={position} aria-setsize={position ? total ?? -1 : undefined}
    data-kind={kind} className={cn('group/post relative border-border/60 border-b transition-colors',
      'hover:bg-foreground/[0.03] has-[:focus-visible]:bg-foreground/[0.03]', postRhythm.row)}>
    {meta}
    <div className={cn('grid gap-x-3', postRhythm.afterMeta, thumbnail && 'grid-cols-[minmax(0,1fr)_auto]')}>
      <div className={cn('grid min-w-0 content-start', postRhythm.afterTitle)}>
        <h3 id={titleId} lang={titleLang} dir={titleDir} className={cn(title === null && 'sr-only',
          'line-clamp-2 text-pretty [overflow-wrap:anywhere]', postRhythm.title, titleClass)}>
          {title === null ? heading : link(title)}</h3>
        {preview ? <div className={cn('line-clamp-3 text-muted-foreground [overflow-wrap:anywhere]', postRhythm.preview,
          readableText)}>{title === null ? link(preview) : preview}</div> : null}
        {below}
      </div>
      {thumbnail ? <div className="relative z-10 self-start">{thumbnail}</div> : null}
    </div>
    {attachment ? <div className={cn('flex min-w-0', postRhythm.section)}>{attachment}</div> : null}
    <div className={cn('-ms-2 flex items-center', postRhythm.section, postRhythm.bar)}>
      <div role="group" aria-label={t.actions} className="relative z-10 flex items-center gap-x-1 sm:gap-x-3">
        {vote}{comments}{actions}</div>
      {report ? <ReportAction target={report} kind={reportKind} iconOnly className={cn(barAction, 'ms-auto w-8 justify-center px-0')} /> : null}
    </div>
  </article>;
}
