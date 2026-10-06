'use client';

import { buttonVariants } from '@rezics/ui/button';
import { ArrowRightIcon, ClockIcon, FlameIcon, TrophyIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { LinkMenu } from '../feed/controls.tsx';
import { DiscussionCard, type DiscussionPost } from '../feed/discussion-card.tsx';
import { threadPath } from '../feed/discussion.ts';
import { useFeed } from '../feed/feed-context.tsx';
import type { ThreadSort, ThreadSummary, ThreadWindow } from '../feed/thread.ts';
import LocalizedLink from '../shell/localized-link.tsx';

const sortIcons: Record<ThreadSort, typeof FlameIcon> = { best: FlameIcon, new: ClockIcon, top: TrophyIcon };

/** A listed thread as a post in the Realm's own list, where the Realm goes without saying. */
export function threadPost(item: ThreadSummary, realmPath: string): DiscussionPost {
  return { kind: 'discussion', href: threadPath(realmPath, item.reply),
    vote: { id: item.placement, vote: item.vote.value, score: item.vote.score, revision: item.vote.revision,
      open: item.vote.open },
    realm: null, author: item.author, time: item.time, title: item.title, body: item.excerpt,
    language: item.language, spoiler: item.spoiler,
    work: { ...item.work, types: [], byline: null }, comments: item.replies };
}

/**
 * A Realm's discussions as a subreddit lists its posts: the sort menu (and
 * Top's period) on one line, the threads as divided rows, and the next page.
 * Every choice is its own address.
 */
export function DiscussionList({ items, realmPath, sort, window, hrefs, next, first, empty }: {
  items: readonly ThreadSummary[];
  /** The Realm's unlocalized `/r/{ref}`, which its threads live under. */
  realmPath: string;
  sort: ThreadSort; window: ThreadWindow;
  hrefs: { sorts: Record<ThreadSort, string>; windows: Record<ThreadWindow, string> };
  /** The next page and, past the first, the first; null where there is none. */
  next: string | null; first: string | null;
  /** What an empty list says, with the fix that fits. */
  empty: ReactNode;
}) {
  const { t } = useFeed();
  const SortIcon = sortIcons[sort];
  return <section aria-labelledby="realm-discussions" className="min-w-0">
    <div className="flex min-h-12 flex-wrap items-center gap-1 border-border/60 border-b pb-1.5">
      <h2 id="realm-discussions" className="me-auto font-semibold text-lg">{t.discussionsLabel}</h2>
      <LinkMenu label={t.sortLabel} value={sort} icon={<SortIcon aria-hidden="true" className="size-4" />}
        options={(['best', 'new', 'top'] as const).map(option => ({ value: option, label: t[option],
          help: option === 'best' ? t.bestHelp : option === 'new' ? t.newHelp : t.topHelp, href: hrefs.sorts[option] }))} />
      {sort === 'top' ? <LinkMenu label={t.period} value={window} options={(['week', 'month', 'all'] as const)
        .map(option => ({ value: option, label: option === 'week' ? t.week : option === 'month' ? t.month : t.allTime,
          href: hrefs.windows[option] }))} /> : null}
    </div>
    {items.length ? <div role="feed" aria-label={t.discussionsLabel}>
      {items.map((item, index) => <DiscussionCard key={item.reply} post={threadPost(item, realmPath)}
        position={index + 1} total={next ? undefined : items.length} />)}
    </div> : empty}
    {next || first ? <nav aria-label={t.discussionsLabel} className="flex flex-wrap justify-between gap-2 px-3 py-4
      sm:px-4">
      {first ? <LocalizedLink href={first} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        {t.firstThreads}</LocalizedLink> : <span />}
      {next ? <LocalizedLink href={next} className={buttonVariants({ variant: 'outline', size: 'sm', pill: true })}>
        {t.moreThreads}<ArrowRightIcon aria-hidden="true" /></LocalizedLink> : null}
    </nav> : null}
  </section>;
}
