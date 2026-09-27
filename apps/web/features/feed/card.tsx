'use client';

import { cn } from '@rezics/ui/utils';
import { WorkCover, type WorkCoverKind } from '@rezics/ui/work-cover';
import { BookOpenIcon, EyeOffIcon, FileTextIcon, LibraryBigIcon, MessageSquareTextIcon, MessagesSquareIcon,
  PackageIcon, SparklesIcon, StampIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { localizedPath } from '../../i18n/locale.ts';
import { coverImage } from '../catalogue/work.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { type Dismissal, DismissedPost, EngagementBar, JoinButton } from './actions.tsx';
import { useFeed } from './feed-context.tsx';
import { absoluteTime, relativeTime } from './time.ts';
import { type FeedItem, uuidOf } from './types.ts';

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

function coverKind(item: FeedItem): WorkCoverKind {
  return item.card.kind === 'recipe' ? 'recipe' : item.card.kind === 'release' ? 'package'
    : item.card.kind === 'prompt' || item.card.kind === 'media' ? 'document' : 'book';
}

/** The small line above a title that says what happened, in words. */
function kicker(item: FeedItem, t: T): { icon: LucideIcon; text: string } {
  const { card, group } = item;
  switch (item.kind) {
    case 'work': return { icon: SparklesIcon, text: t.newWork };
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
  if (item.group.count > 1 && !item.group.range) facts.push(t.moreUpdates(item.group.count - 1));
  return facts;
}

function excerptOf(item: FeedItem): string | null {
  const { card } = item;
  if (card.kind === 'chapter' && card.excerpt) return card.excerpt;
  if (card.kind === 'release' && card.changelogExcerpt) return card.changelogExcerpt;
  return item.target.excerpt;
}


function Byline({ item }: { item: FeedItem }) {
  const { t, locale, now, avatarQuery, tab } = useFeed();
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .format(item.group.actors.map(actor => actor.name));
  const reason = item.reason.kind === 'trending-in-realm' ? t.trending({ realm: item.realm?.name.value ?? '' })
    : item.reason.kind === 'editorial' ? t.editorial
      // In All every post is REZICS-wide; only a suggestion inside Following is an exception worth naming.
      : item.reason.kind === 'recommended' && tab === 'following' ? t.suggested : null;
  const why = item.reason.kind === 'recommended'
    ? item.reason.basis === 'thin-following' ? t.suggestedThin : t.suggestedAll : undefined;
  return <div className="flex min-w-0 items-center gap-2 text-[13px]">
    {item.realm
      ? <CommunityIcon icon={item.realm.icon} name={item.realm.name.value} avatarQuery={avatarQuery} />
      : <CommunityIcon icon={null} name={item.actor.name} person />}
    <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      {item.realm ? <>
        <Link href={localizedPath(`/r/${uuidOf(item.realm.id)}`, locale)} lang={item.realm.name.language}
          className="relative z-10 truncate font-semibold text-foreground outline-none hover:underline
            focus-visible:ring-2 focus-visible:ring-ring">{item.realm.name.value}</Link>
        <span aria-hidden="true">·</span>
      </> : null}
      <span className={cn('truncate', !item.realm && 'font-semibold text-foreground')}>{names}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={item.time} title={absoluteTime(item.time, locale)} suppressHydrationWarning
        className="whitespace-nowrap">{relativeTime(item.time, now, locale)}</time>
      {reason ? <span title={why} className="rounded-full bg-info/10 px-2 py-0.5 font-medium text-[11px]
        text-info-foreground">{reason}</span> : null}
    </p>
    {item.realm ? <JoinButton realm={item.realm} /> : null}
  </div>;
}

/**
 * One post, in the same anatomy for every kind: who and where, what happened,
 * the content, then the engagement bar. Repeated updates arrive grouped from
 * Main and read as one post ("Chapters 212–214"); a chapter past the reader's
 * position keeps its text hidden.
 */
export function FeedCard({ item, position, total }: { item: FeedItem; position?: number; total?: number }) {
  const { t, locale, avatarQuery } = useFeed();
  const titleId = useId();
  const [dismissed, setDismissed] = useState<Dismissal | null>(null);
  if (dismissed) return <DismissedPost dismissal={dismissed} onUndo={() => setDismissed(null)} />;
  const href = targetHref(item);
  const title = item.target.title.value || t.untitled;
  const lang = titleLanguage(item);
  const { icon: Icon, text } = kicker(item, t);
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
        {item.card.kind === 'prompt' && item.card.preview
          ? <figure className="mt-1 grid gap-1">
            <figcaption className="sr-only">{t.promptPreview}</figcaption>
            <pre lang={item.target.language ?? undefined} className="line-clamp-4 whitespace-pre-wrap rounded-xl bg-code
              px-3 py-2.5 font-mono text-code-foreground text-xs/relaxed">{item.card.preview}</pre>
          </figure>
          : excerpt ? <p lang={item.target.language ?? undefined} className={cn('line-clamp-3 whitespace-pre-line',
            'text-pretty text-muted-foreground text-sm/relaxed', readableText)}>{excerpt}</p> : null}
      </div>
      {coverHref ? <LocalizedLink href={coverHref} tabIndex={-1} aria-hidden="true" className="self-start">
        <WorkCover title={title} lang={lang} kind={coverKind(item)}
          seed={item.target.cover.kind === 'fallback' ? item.target.cover.key : item.target.id}
          image={coverImage(item.target.cover, avatarQuery)} size="sm" className="sm:w-20" />
      </LocalizedLink> : null}
    </div>
    <EngagementBar item={item} title={title} href={href} onDismiss={setDismissed} />
  </article>;
}
