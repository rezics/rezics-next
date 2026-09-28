'use client';

import { cn } from '@rezics/ui/utils';
import { BookCheckIcon, BookOpenIcon, BookPlusIcon, EyeOffIcon, FileTextIcon, LibraryBigIcon, MessageSquareQuoteIcon,
  MessageSquareTextIcon, MessagesSquareIcon, PackageIcon, SparklesIcon, StampIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { localizedPath } from '../../i18n/locale.ts';
import { StarMeter } from '../catalogue/rating.tsx';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { authorSeparator, type CoverWork, coverKindOf } from '../catalogue/work.ts';
import { authorHref } from '../author/route.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { type Dismissal, DismissedPost, EngagementBar, JoinButton } from './actions.tsx';
import { useFeed } from './feed-context.tsx';
import { absoluteTime, relativeTime } from './time.ts';
import type { FeedItem } from './types.ts';

type T = ReturnType<typeof useFeed>['t'];

/** CJK body text: a taller line and spacing between Han and Latin runs. */
const readableText = '[text-autospace:normal] [&:is(:lang(zh),:lang(ja),:lang(ko))]:leading-[1.8]';

/** Where the post's title leads: its Work or thread. Lists have no page yet, so they lead nowhere. */
function targetHref(item: FeedItem): string | null {
  return item.links.target.startsWith('/w/') ? item.links.target : null;
}

/** The language a title is written in: Main's requested name, or the content's language for a fallback. */
function titleLanguage(item: FeedItem): string | undefined {
  const { title, language } = item.target;
  return title.basis === 'requested' ? title.language : language ?? undefined;
}

/** How long a Work is "new" after it is published; later its card says only that it was published. */
const NEW_WORK_MS = 3 * 86_400_000;

/** The Work's one cover, drawn from the same facts as on every other page. */
function coverWork(item: FeedItem, title: string, lang: string | undefined): CoverWork {
  return { id: item.target.work ?? item.target.id, title: { ...item.target.title, value: title,
    language: lang ?? item.target.title.language }, cover: item.target.cover, kind: coverKindOf(item.target.types),
  authors: item.authors.flatMap(author => author.displayName ? [{ name: author.displayName,
    href: author.handle ? authorHref({ kind: 'agent', handle: author.handle })
      : author.provider === 'open-library' && author.key
        ? authorHref({ kind: 'external', key: author.key }) : null }] : []) };
}

type Reason = FeedItem['reasons'][number];

/**
 * The one reason a Work's card is here, in words. A Realm's pick outranks the
 * Work's creation, and names the Realm, never its curator; a created Work is
 * "new" only for its first days.
 */
function reasonOf(item: FeedItem, now: number, t: T): { icon: LucideIcon; text: string } | null {
  const reason = item.reasons.find(candidate => candidate.kind === 'realm-pick') ?? item.reasons[0];
  if (!reason) return null;
  return reasonWords(reason, item, now, t);
}

function reasonWords(reason: Reason, item: FeedItem, now: number, t: T): { icon: LucideIcon; text: string } {
  switch (reason.kind) {
    case 'new-work': return now - Date.parse(item.time) < NEW_WORK_MS ? { icon: SparklesIcon, text: t.newWork }
      : { icon: BookCheckIcon, text: t.published };
    case 'added-to-rezics': return { icon: BookPlusIcon, text: t.addedToRezics };
    case 'realm-pick': return { icon: StampIcon, text: item.realm?.id === reason.realm
      ? t.picked({ realm: item.realm.name.value }) : t.pickedByRealm };
  }
}

/**
 * The small line above a title that says what happened, in words: one
 * reason for a Work (a pick, or that it is new), and what other kinds are.
 */
function kicker(item: FeedItem, now: number, t: T): { icon: LucideIcon; text: string } {
  const { card, group } = item;
  const reason = reasonOf(item, now, t);
  if (reason) return reason;
  switch (item.kind) {
    case 'work': return reasonWords({ kind: 'new-work', actor: item.actor.id }, item, now, t);
    case 'added': return { icon: BookPlusIcon, text: t.addedToRezics };
    case 'contribution':
      if (card.kind === 'release') return { icon: PackageIcon, text: t.newRelease };
      if (card.kind !== 'chapter') return { icon: FileTextIcon, text: t.update };
      return { icon: BookOpenIcon, text: group.range && group.range.from !== group.range.to
        ? t.chapterRange({ from: String(group.range.from), to: String(group.range.to) }) : t.newChapter };
    case 'adoption': return { icon: StampIcon, text: item.realm ? t.picked({ realm: item.realm.name.value }) : t.pickedByRealm };
    case 'decision': return { icon: StampIcon, text: t.decision };
    case 'discussion': return { icon: MessagesSquareIcon, text: t.discussion };
    case 'reply': return { icon: MessageSquareTextIcon, text: t.reply };
    case 'collection': return { icon: LibraryBigIcon, text: t.list };
    case 'review': return { icon: MessageSquareQuoteIcon, text: t.review };
  }
}

const spoilerHidden = (item: FeedItem) => item.viewerState.status === 'available' && item.viewerState.spoiler.hidden;

/** The kind-specific facts under a title: chapter, version, time to cook, running time. */
function details(item: FeedItem, t: T, locale: string): string[] {
  const { card } = item;
  const facts: string[] = [];
  if (card.kind === 'chapter') {
    if (card.number !== undefined && !(item.group.range && item.group.range.from !== item.group.range.to)) {
      facts.push(t.chapterNumber({ number: new Intl.NumberFormat(locale).format(card.number) }));
    }
    // A chapter title can spoil as much as its text.
    if (card.title && !spoilerHidden(item)) facts.push(card.title);
    if (card.wordCount !== undefined) facts.push(t.words(card.wordCount));
  }
  if (card.kind === 'release' && card.version) facts.push(t.version({ version: card.version }));
  if (card.kind === 'release' && card.level) facts.push(card.level);
  if (card.kind === 'recipe') facts.push(...[card.totalTime, card.servings].filter(fact => fact !== undefined));
  if (card.kind === 'media' && card.durationSeconds !== undefined) {
    facts.push(t.minutes(Math.max(1, Math.round(card.durationSeconds / 60))));
  }
  if (card.kind === 'review' && card.helpfulCount > 0) facts.push(t.helpful(card.helpfulCount));
  if (item.group.count > 1 && !item.group.range) {
    facts.push(card.kind === 'review' ? t.moreReviews(item.group.count - 1) : t.moreUpdates(item.group.count - 1));
  }
  return facts;
}

function excerptOf(item: FeedItem): string | null {
  const { card } = item;
  if (card.kind === 'chapter' && card.excerpt) return card.excerpt;
  if (card.kind === 'release' && card.changelogExcerpt) return card.changelogExcerpt;
  return item.target.excerpt;
}


function Byline({ item }: { item: FeedItem }) {
  const { t, locale, now, avatarQuery, tab, realmPath } = useFeed();
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .format(item.group.actors.map(actor => actor.name));
  const reason = item.reason.kind === 'trending-in-realm' ? t.trending({ realm: item.realm?.name.value ?? '' })
    : item.reason.kind === 'editorial' ? t.editorial
      // In All every post is REZICS-wide; only a suggestion inside Following is an exception worth naming.
      : item.reason.kind === 'recommended' && tab === 'following' ? t.suggested : null;
  const why = item.reason.kind === 'recommended'
    ? item.reason.basis === 'thin-following' ? t.suggestedThin : t.suggestedAll : undefined;
  // A pick is the Realm's act. Naming its curator here would read as the Work's author.
  const people = item.reasons.some(reason => reason.kind === 'realm-pick') || item.kind === 'adoption' && item.realm
    ? null : names;
  return <div className="flex min-w-0 items-center gap-2 text-[13px]">
    {item.realm
      ? <CommunityIcon icon={item.realm.icon} name={item.realm.name.value} avatarQuery={avatarQuery} />
      : <CommunityIcon icon={null} name={item.actor.name} person />}
    <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      {item.realm ? <>
        <Link href={localizedPath(realmPath(item.realm.id), locale)} lang={item.realm.name.language}
          className="relative z-10 truncate font-semibold text-foreground outline-none hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{item.realm.name.value}</Link>
        <span aria-hidden="true">·</span>
      </> : null}
      {people ? <>
        <span className={cn('truncate', !item.realm && 'font-semibold text-foreground')}>{people}</span>
        <span aria-hidden="true">·</span>
      </> : null}
      <time dateTime={item.time} title={absoluteTime(item.time, locale)} suppressHydrationWarning
        className="whitespace-nowrap">{relativeTime(item.time, now, locale)}</time>
      {reason ? <span title={why} className="rounded-full bg-info/10 px-2 py-0.5 font-medium text-[11px]
        text-info-foreground">{reason}</span> : null}
    </p>
    {item.realm ? <JoinButton realm={item.realm} /> : null}
  </div>;
}

/**
 * The Work's credited authors, under its title where readers look for them.
 * Authors on REZICS link to their profiles; the poster or the curator is
 * never named here.
 */
function Authors({ authors }: { authors: FeedItem['authors'] }) {
  const { t } = useFeed();
  const named = authors.filter((author): author is typeof author & { displayName: string } => author.displayName !== null);
  if (!named.length) return null;
  const separator = authorSeparator(named.map(author => author.displayName));
  const marker = '\u2063';
  const [before = '', after = ''] = t.writtenBy({ names: marker }).split(marker);
  return <p className="truncate text-muted-foreground text-sm">{before}
    {named.map((author, index) => {
      const href = author.handle ? authorHref({ kind: 'agent', handle: author.handle })
        : author.provider === 'open-library' && author.key
          ? authorHref({ kind: 'external', key: author.key }) : null;
      return <span key={author.id}>{index ? separator : null}{href
        ? <LocalizedLink href={href} className="relative z-10 font-medium text-foreground outline-none
          hover:underline focus-visible:ring-2 focus-visible:ring-ring">{author.displayName}</LocalizedLink>
        : <span className="font-medium text-foreground">{author.displayName}</span>}</span>;
    })}{after}</p>;
}

/**
 * A reader's review under the Work's title: their stars, then the opening
 * lines, or a note when the review discusses the plot. Its page has the rest.
 */
function ReviewBody({ card, lang }: { card: Extract<FeedItem['card'], { kind: 'review' }>; lang?: string }) {
  const { t, locale } = useFeed();
  const rating = new Intl.NumberFormat(locale).format(card.rating);
  return <div className="grid gap-1.5">
    <p className="flex items-center gap-2 text-sm">
      <StarMeter mean={card.rating} max={card.scale} />
      <span className="sr-only">{t.ratedOutOf({ rating, scale: String(card.scale) })}</span>
      {card.scale === 5 ? null : <span aria-hidden="true" className="font-semibold tabular-nums">{rating}/{card.scale}</span>}
    </p>
    {card.opening ? <blockquote lang={lang} className={cn('line-clamp-4 whitespace-pre-line border-border border-s-2 ps-3',
      'text-pretty text-sm/relaxed', readableText)}>{card.opening}</blockquote>
      : card.spoiler ? <div className="flex items-start gap-3 rounded-xl border border-border/70 border-dashed bg-muted/40
        px-3 py-2.5 text-sm">
        <EyeOffIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p><span className="font-medium">{t.reviewSpoilerTitle}</span>
          <span className="block text-muted-foreground">{t.reviewSpoilerBody}</span></p>
      </div> : null}
  </div>;
}

/**
 * One post, in the same anatomy for every kind: who and where, what happened,
 * the content, then the engagement bar. Repeated updates arrive grouped from
 * Main and read as one post ("Chapters 212–214"); a chapter past the reader's
 * position keeps its text hidden.
 */
/**
 * A list's first Works as small covers, each leading to its page, and how
 * many the list holds, so a list reads as its contents rather than a title.
 */
function ListPreview({ card }: { card: Extract<FeedItem['card'], { kind: 'list' }> }) {
  const { t, avatarQuery } = useFeed();
  if (!card.works.length) return null;
  return <div className="mt-1 grid gap-2">
    <ul aria-label={t.listPreview} className="flex items-end gap-2.5">
      {card.works.map(work => <li key={work.id}>
        <LocalizedLink href={`/w/${work.id.slice(-36)}`} aria-label={work.title.value} className="block rounded-[0.25rem]
          outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CatalogueCover work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types),
            authors: [] }} avatarQuery={avatarQuery} size="sm" className="sm:w-[4.5rem]" />
        </LocalizedLink>
      </li>)}
    </ul>
    <p className="text-muted-foreground text-sm">{card.count.kind === 'exact' ? t.listWorks(card.count.value)
      : t.listWorksAtLeast(card.count.value)}</p>
  </div>;
}

export function FeedCard({ item, position, total }: { item: FeedItem; position?: number; total?: number }) {
  const { t, locale, now, avatarQuery } = useFeed();
  const titleId = useId();
  const [dismissed, setDismissed] = useState<Dismissal | null>(null);
  if (dismissed) return <DismissedPost dismissal={dismissed} onUndo={() => setDismissed(null)} />;
  const href = targetHref(item);
  const title = item.target.title.value || t.untitled;
  const lang = titleLanguage(item);
  const { icon: Icon, text } = kicker(item, now, t);
  const facts = details(item, t, locale);
  const hidden = spoilerHidden(item);
  const excerpt = hidden ? null : excerptOf(item);
  const coverHref = item.target.work !== null ? href : null;
  return <article aria-labelledby={titleId} aria-posinset={position} aria-setsize={total ?? -1} data-kind={item.kind}
    className="group/post relative grid gap-2.5 border-border/60 border-b px-3 py-4 transition-colors
      hover:bg-accent/25 sm:px-4">
    <Byline item={item} />
    <div className={cn('grid gap-x-4', coverHref && 'grid-cols-[minmax(0,1fr)_auto]')}>
      <div className="grid min-w-0 content-start gap-1.5">
        <p className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />{text}</p>
        <h3 id={titleId} lang={lang} dir={item.target.title.direction}
          className={cn('text-pretty font-semibold text-[1.0625rem]/snug [overflow-wrap:anywhere] sm:text-lg/snug',
            coverHref && 'font-work-title font-medium')}>
          {href ? <LocalizedLink href={href} className="outline-none decoration-1 underline-offset-2 hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{title}</LocalizedLink> : title}
        </h3>
        <Authors authors={item.authors} />
        {facts.length ? <p className="flex flex-wrap gap-x-1.5 text-muted-foreground text-sm">
          {facts.map((fact, index) => <span key={fact} lang={index === 1 && item.card.kind === 'chapter' ? lang : undefined}>
            {index ? <span aria-hidden="true" className="me-1.5">·</span> : null}{fact}</span>)}
        </p> : null}
        {hidden ? <div className="mt-1 flex items-start gap-3 rounded-xl border border-border/70 border-dashed
          bg-muted/40 px-3 py-2.5 text-sm">
          <EyeOffIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p><span className="font-medium">{t.spoilerTitle}</span>
            <span className="block text-muted-foreground">{t.spoilerBody}</span></p>
        </div> : null}
        {item.card.kind === 'list' ? <ListPreview card={item.card} /> : null}
        {item.card.kind === 'review' ? <ReviewBody card={item.card} lang={item.target.language ?? undefined} />
          : item.card.kind === 'prompt' && item.card.preview
          ? <figure className="mt-1 grid gap-1">
            <figcaption className="sr-only">{t.promptPreview}</figcaption>
            <pre lang={item.target.language ?? undefined} className="line-clamp-4 whitespace-pre-wrap rounded-xl bg-code
              px-3 py-2.5 font-mono text-code-foreground text-xs/relaxed">{item.card.preview}</pre>
          </figure>
          : excerpt ? <p lang={item.target.language ?? undefined} className={cn('line-clamp-3 whitespace-pre-line',
            'text-pretty text-muted-foreground text-sm/relaxed', readableText)}>{excerpt}</p> : null}
      </div>
      {coverHref ? <LocalizedLink href={coverHref} tabIndex={-1} aria-hidden="true" className="self-start">
        <CatalogueCover work={coverWork(item, title, lang)} avatarQuery={avatarQuery} size="sm" className="sm:w-20" />
      </LocalizedLink> : null}
    </div>
    <EngagementBar item={item} title={title} href={href} onDismiss={setDismissed} />
  </article>;
}
