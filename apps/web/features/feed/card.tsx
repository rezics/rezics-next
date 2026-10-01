'use client';

import { cn } from '@rezics/ui/utils';
import { BookCheckIcon, BookOpenIcon, BookPlusIcon, EyeOffIcon, FileTextIcon, LibraryBigIcon, MessageCircleIcon,
  MessageSquareQuoteIcon, MessageSquareTextIcon, MessagesSquareIcon, PackageIcon, SparklesIcon, StampIcon,
  type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { StarMeter } from '../catalogue/rating.tsx';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { authorSeparator, type CoverWork, coverKindOf } from '../catalogue/work.ts';
import { authorHref } from '../author/route.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type Dismissal, DismissedPost, FollowRealmButton, MoreMenu, PrimaryAction, ShareButton, VoteControl } from './actions.tsx';
import { DiscussionCard, type DiscussionPost } from './discussion-card.tsx';
import { threadPath } from './discussion.ts';
import { useFeed } from './feed-context.tsx';
import { followsPoster, metaLead } from './lead.ts';
import { type AttachedWork, barAction, MetaLine, PostRow, PostTime, rowLink, useIdentity, WorkAttachment } from './post-row.tsx';
import type { FeedItem } from './types.ts';

type T = ReturnType<typeof useFeed>['t'];

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
    // The meta line already names the Realm, so its own pick says only that it picked the Work.
    case 'realm-pick': return { icon: StampIcon, text: item.realm?.id === reason.realm ? t.pickedHere : t.pickedByRealm };
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
    case 'adoption': return { icon: StampIcon, text: item.realm ? t.pickedHere : t.pickedByRealm };
    case 'decision': return { icon: StampIcon, text: t.decision };
    case 'discussion': return { icon: MessagesSquareIcon, text: t.discussion };
    case 'reply': return { icon: MessageSquareTextIcon, text: t.reply };
    case 'collection': return { icon: LibraryBigIcon, text: t.list };
    case 'review': return { icon: MessageSquareQuoteIcon, text: t.review };
  }
}

const spoilerHidden = (item: FeedItem) => item.viewerState.status === 'available' && item.viewerState.spoiler.hidden;

/** What a chapter post is titled: its number and, unless it could spoil, its own title. */
function chapterTitle(item: FeedItem, card: Extract<FeedItem['card'], { kind: 'chapter' }>, t: T, locale: string): string {
  const { range } = item.group;
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  if (range && range.from !== range.to) return t.chapterRange({ from: format(range.from), to: format(range.to) });
  const number = card.number !== undefined ? t.chapterNumber({ number: format(card.number) }) : t.newChapter;
  // A chapter title can spoil as much as its text.
  return card.title && !spoilerHidden(item) ? `${number} · ${card.title}` : number;
}

/** The small facts a post's preview opens with: length, version level, time to cook, running time, helpfulness. */
function details(item: FeedItem, t: T): string[] {
  const { card } = item;
  const facts: string[] = [];
  if (card.kind === 'chapter' && card.wordCount !== undefined) facts.push(t.words(card.wordCount));
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

/**
 * The Work's credited authors under its title, where readers look for them.
 * Authors on REZICS and Open Library authors link to their pages; the poster
 * or the curator is never named here.
 */
function Authors({ authors }: { authors: FeedItem['authors'] }) {
  const { t } = useFeed();
  const named = authors.filter((author): author is typeof author & { displayName: string } => author.displayName !== null);
  if (!named.length) return null;
  const separator = authorSeparator(named.map(author => author.displayName));
  const marker = '\u2063';
  const [before = '', after = ''] = t.writtenBy({ names: marker }).split(marker);
  return <span className="block truncate">{before}{named.map((author, index) => {
    const href = author.handle ? authorHref({ kind: 'agent', handle: author.handle })
      : author.provider === 'open-library' && author.key ? authorHref({ kind: 'external', key: author.key }) : null;
    return <span key={author.id}>{index ? separator : null}{href
      ? <LocalizedLink href={href} className={cn(rowLink, 'text-foreground')}>{author.displayName}</LocalizedLink>
      : <span className="text-foreground">{author.displayName}</span>}</span>;
  })}{after}</span>;
}

/** The Work's credited authors as a line of names, the poster or curator never among them. */
function authorLine(authors: FeedItem['authors']): string | null {
  const named = authors.flatMap(author => author.displayName ? [author.displayName] : []);
  return named.length ? named.join(authorSeparator(named)) : null;
}

/**
 * The followed author of the Work a card answers to, named as the card names
 * them. Main puts an author's news under their follow before the Realm's, so
 * this is the reason worth saying. A followed poster needs no such note: the
 * card leads with them. Nor does a curator, whom a pick never names.
 */
function followedAuthor(item: FeedItem): string | null {
  const reason = item.reason;
  if (reason.kind !== 'followed' || followsPoster(item)) return null;
  if (reason.targetKind === 'external-author') {
    const id = reason.target.slice('open-library:'.length);
    return item.authors.find(author => author.provider === 'open-library' && author.key === `/authors/${id}`)
      ?.displayName ?? id;
  }
  if (reason.targetKind !== 'agent') return null;
  return item.authors.find(author => author.agent === reason.target)?.displayName ?? null;
}

/**
 * The one meta line: who and where, in the order `metaLead` picks, then time
 * and what happened, then Follow and the post's menu. A pick is the Realm's act,
 * so its curator is not named as if they wrote the Work; reasons show only
 * where they are exceptions, which is only ever inside Following.
 */
function FeedMeta({ item, end }: { item: FeedItem; end: ReactNode }) {
  const { t, now, tab } = useFeed();
  const author = tab === 'following' ? followedAuthor(item) : null;
  const reason = author ? t.becauseYouFollow({ name: author })
    : item.reason.kind === 'trending-in-realm' ? t.trending({ realm: item.realm?.name.value ?? '' })
    : item.reason.kind === 'editorial' ? t.editorial
      // In All every post is REZICS-wide; only a suggestion inside Following is an exception worth naming.
      : item.reason.kind === 'recommended' && tab === 'following' ? t.suggested : null;
  const why = item.reason.kind === 'recommended'
    ? item.reason.basis === 'thin-following' ? t.suggestedThin : t.suggestedAll : undefined;
  const hidden = item.reasons.some(candidate => candidate.kind === 'realm-pick') || item.kind === 'adoption' && item.realm;
  const identity = useIdentity({ lead: metaLead(item), realm: item.realm, people: hidden ? null : item.group.actors });
  const { icon: Icon, text } = kicker(item, now, t);
  return <MetaLine icon={identity.icon} parts={[
    ...identity.parts,
    { keep: true, node: <PostTime time={item.time} /> },
    { node: <span className="inline-flex items-center gap-1"><Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {text}</span> },
    reason ? { node: <span title={why} className="rounded-full bg-info/10 px-1.5 font-medium text-[11px]
      text-info-foreground">{reason}</span> } : null,
  ]} end={end} />;
}

/** A review has no title of its own; its opening line stands in, and the rest follows as its preview. */
function firstLine(text: string): { title: string; body: string } {
  const trimmed = text.trim(), end = trimmed.indexOf('\n');
  return end < 0 ? { title: trimmed, body: '' } : { title: trimmed.slice(0, end).trim(), body: trimmed.slice(end + 1).trim() };
}

/** A review's title: its stars, then its opening line, or its rating when it keeps the plot back. */
function reviewHeading(card: Extract<FeedItem['card'], { kind: 'review' }>, t: T, locale: string) {
  const rating = card.rating === null ? null : new Intl.NumberFormat(locale).format(card.rating);
  const { title, body } = firstLine(card.opening ?? '');
  return { title: <span className="inline-flex max-w-full items-baseline gap-2">
    {card.rating === null || rating === null ? null : <>
      <StarMeter mean={card.rating} max={card.scale} className="translate-y-px text-[0.8125rem]" />
      <span className="sr-only">{t.ratedOutOf({ rating, scale: String(card.scale) })}</span>
      {card.scale === 5 ? null : <span aria-hidden="true" className="font-semibold tabular-nums">{rating}/{card.scale}</span>}
    </>}
    <span className="min-w-0">{title || t.review}</span>
  </span>, body };
}

/** A spoiler Main keeps back: one line that says so, in place of the words. */
function Withheld({ title, body }: { title: string; body: string }) {
  return <span className="flex items-center gap-1.5 text-muted-foreground">
    <EyeOffIcon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="truncate"><span className="font-medium text-foreground">{title}</span> {body}</span>
  </span>;
}

/**
 * A list's first Works as small covers, each leading to its page, and how
 * many the list holds, so a list reads as its contents rather than a title.
 */
function ListPreview({ card }: { card: Extract<FeedItem['card'], { kind: 'list' }> }) {
  const { t, avatarQuery } = useFeed();
  if (!card.works.length) return null;
  return <div className="mt-1 flex items-end gap-2">
    <ul aria-label={t.listPreview} className="flex items-end gap-2">
      {card.works.map(work => <li key={work.id}><LocalizedLink href={`/w/${work.id.slice(-36)}`}
        aria-label={work.title.value} className="relative z-10 block rounded-[0.1875rem] outline-none
          focus-visible:ring-2 focus-visible:ring-ring">
        <CatalogueCover work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types),
          authors: [] }} avatarQuery={avatarQuery} size="xs" />
      </LocalizedLink></li>)}
    </ul>
    <span className="text-muted-foreground text-sm">{card.count.kind === 'exact' ? t.listWorks(card.count.value)
      : t.listWorksAtLeast(card.count.value)}</span>
  </div>;
}

/** A discussion or reply from Home, as the post it is: its thread is where it leads. */
function discussionPost(item: FeedItem & { realm: NonNullable<FeedItem['realm']> },
  realmPath: (realm: string) => string): DiscussionPost {
  const { target } = item;
  return { kind: item.kind === 'reply' ? 'reply' : 'discussion',
    href: threadPath(realmPath(item.realm.id), target.id),
    vote: { id: item.id, vote: item.vote, score: item.score, revision: item.voteRevision },
    realm: item.realm, lead: metaLead(item), author: { name: item.actor.name, handle: item.actor.handle }, time: item.time,
    title: item.post.title, body: item.post.excerpt ?? '', language: item.post.language,
    showSpoilers: item.viewerState.status === 'available' && item.viewerState.spoiler.policy === 'show',
    work: target.work ? { id: target.work, title: target.title, cover: target.cover, types: target.types,
      byline: authorLine(item.authors) } : null,
    comments: item.kind === 'discussion' ? item.comments : null,
    // Home groups a Realm's discussions of one Work on one day; the rest are on the Realm's Discussions tab.
    more: item.group.count > 1 ? { count: item.group.count - 1, href: `${realmPath(item.realm.id)}/discussions` } : null };
}

function FeedDiscussion({ item, position, total }: { item: FeedItem & { realm: NonNullable<FeedItem['realm']> };
  position?: number; total?: number }) {
  const { realmPath } = useFeed();
  const [dismissed, setDismissed] = useState<Dismissal | null>(null);
  if (dismissed) return <DismissedPost dismissal={dismissed} onUndo={() => setDismissed(null)} />;
  const post = discussionPost(item, realmPath);
  const title = post.title ?? post.body;
  return <DiscussionCard post={post} position={position} total={total}
    menu={<MoreMenu item={item} share={{ href: post.href, title }} onDismiss={setDismissed} />} />;
}

export function FeedCard({ item, position, total }: { item: FeedItem; position?: number; total?: number }) {
  if ((item.kind === 'discussion' || item.kind === 'reply') && item.realm) {
    return <FeedDiscussion item={{ ...item, realm: item.realm }} position={position} total={total} />;
  }
  return <FeedPost item={item} position={position} total={total} />;
}

/**
 * One post, in the same anatomy for every kind: the meta line, the post's own
 * title (a chapter, a release, a review, or the Work itself), a short preview,
 * the Work attached, then the bar. Repeated updates arrive grouped from Main
 * and read as one post ("Chapters 212–214"); a chapter past the reader's
 * position keeps its title and text hidden.
 */
function FeedPost({ item, position, total }: { item: FeedItem; position?: number; total?: number }) {
  const { t, locale, avatarQuery } = useFeed();
  const [dismissed, setDismissed] = useState<Dismissal | null>(null);
  if (dismissed) return <DismissedPost dismissal={dismissed} onUndo={() => setDismissed(null)} />;
  const href = targetHref(item);
  const workTitle = item.target.title.value || t.untitled;
  const lang = titleLanguage(item);
  const { card } = item;
  const hidden = spoilerHidden(item);
  const facts = details(item, t);
  const excerpt = hidden ? null : excerptOf(item);
  const byline = authorLine(item.authors);
  const attached: AttachedWork | null = item.target.work ? { id: item.target.work,
    title: { ...item.target.title, value: workTitle, language: lang ?? item.target.title.language },
    cover: item.target.cover, types: item.target.types, byline } : null;
  const contentLang = item.target.language ?? undefined;
  const text = (value: string) => <span lang={contentLang} className="whitespace-pre-line">{value}</span>;
  const factLine = facts.length ? <span className="me-1.5 text-muted-foreground">{facts.join(' · ')}</span> : null;
  // A chapter, release or review is about its Work, attached below; any other post is the Work, cover beside it.
  let title: ReactNode = workTitle, titleLang = lang, titleClass = 'font-work-title font-medium';
  let preview: ReactNode = null, about: AttachedWork | null = null;
  if (card.kind === 'chapter') {
    title = chapterTitle(item, card, t, locale); titleLang = contentLang; titleClass = '';
    preview = hidden ? <Withheld title={t.spoilerTitle} body={t.spoilerBody} />
      : <>{factLine}{excerpt ? text(excerpt) : null}</>;
    about = attached;
  } else if (card.kind === 'release') {
    title = card.version ? t.version({ version: card.version }) : t.newRelease; titleLang = undefined; titleClass = '';
    preview = <>{factLine}{excerpt ? text(excerpt) : null}</>;
    about = attached;
  } else if (card.kind === 'review') {
    const review = reviewHeading(card, t, locale);
    title = review.title; titleLang = contentLang; titleClass = '';
    preview = card.opening ? review.body ? <>{factLine}{text(review.body)}</> : factLine
      : card.spoiler ? <>{factLine ? <span className="block">{facts.join(' · ')}</span> : null}
        <Withheld title={t.reviewSpoilerTitle} body={t.reviewSpoilerBody} /></> : factLine;
    about = attached;
  } else if (card.kind === 'list') {
    titleLang = item.target.title.language; titleClass = '';
    preview = <ListPreview card={card} />;
  } else if (card.kind === 'prompt' && card.preview) {
    preview = <><Authors authors={item.authors} />
      <code lang={contentLang} className="font-mono text-code-foreground text-xs">{card.preview}</code></>;
  } else {
    preview = <><Authors authors={item.authors} />{factLine}{excerpt ? text(excerpt) : null}</>;
  }
  const comments = item.target.work ? item.links.comments : null;
  const count = new Intl.NumberFormat(locale, { notation: 'compact' }).format(item.comments.value);
  const plainTitle = card.kind === 'review' ? workTitle : typeof title === 'string' ? title : workTitle;
  return <PostRow kind={item.kind} href={href} report={item.target.work} position={position} total={total}
    meta={<FeedMeta item={item} end={<>
      {item.realm ? <FollowRealmButton realm={item.realm} /> : null}
      <MoreMenu item={item} share={href ? { href, title: plainTitle } : null} onDismiss={setDismissed} />
    </>} />}
    title={title} titleLang={titleLang} titleDir={item.target.title.direction} titleClass={titleClass}
    preview={preview}
    thumbnail={about || card.kind === 'list' || !href || item.target.work === null ? null
      : <LocalizedLink href={href} tabIndex={-1} aria-hidden="true" className="block">
        <CatalogueCover work={coverWork(item, workTitle, lang)} avatarQuery={avatarQuery} size="xs"
          className="w-14 sm:w-16" />
      </LocalizedLink>}
    attachment={about ? <WorkAttachment work={about} /> : null}
    vote={<VoteControl target={{ id: item.id, vote: item.vote, score: item.score, revision: item.voteRevision }} plain />}
    comments={comments ? <LocalizedLink href={comments} className={barAction}
      aria-label={item.comments.kind === 'exact' ? t.comments(item.comments.value) : t.commentsAtLeast(item.comments.value)}>
      <MessageCircleIcon aria-hidden="true" />
      <span aria-hidden="true" className="tabular-nums">{count}{item.comments.kind === 'exact' ? '' : '+'}</span>
    </LocalizedLink> : null}
    actions={<>
      <PrimaryAction item={item} title={workTitle} />
      {href ? <ShareButton href={href} title={plainTitle} /> : null}
    </>} />;
}
