'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowRightIcon, ClockIcon, FlameIcon, TrophyIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DiscussionCard, type DiscussionPost } from '../feed/discussion-card.tsx';
import { threadPath } from '../feed/discussion.ts';
import { useFeed } from '../feed/feed-context.tsx';
import type { ThreadSort, ThreadSummary, ThreadWindow } from '../feed/thread.ts';
import LocalizedLink from '../shell/localized-link.tsx';

const sortIcons: Record<ThreadSort, typeof FlameIcon> = { best: FlameIcon, new: ClockIcon, top: TrophyIcon };
const segment = 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-medium text-sm '
  + 'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground '
  + 'focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-foreground aria-[current=page]:text-background';

/** A listed thread as a post in the Realm's own list, where the Realm goes without saying. */
export function threadPost(item: ThreadSummary, realmPath: string): DiscussionPost {
  return { kind: 'discussion', href: threadPath(realmPath, item.reply),
    vote: { id: item.placement, vote: item.vote.value, score: item.vote.score, revision: item.vote.revision,
      open: item.vote.open },
    realm: null, author: item.author, time: item.time, text: item.excerpt, language: item.language,
    work: { ...item.work, types: [], byline: null }, comments: item.replies };
}

/**
 * A Realm's discussions as a subreddit lists its posts: Best, New or Top
 * always in view, the threads as cards, and the next page. Every choice is
 * its own address.
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
  return <section aria-labelledby="realm-discussions" className="min-w-0 overflow-hidden border-border/60 border-y
    bg-card sm:rounded-2xl sm:border sm:shadow-(--aura-shadow-card)">
    <div className="grid gap-3 border-border/60 border-b px-3 pt-3 pb-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="realm-discussions" className="font-semibold text-lg">{t.discussionsLabel}</h2>
        <nav aria-label={t.sortLabel} className="flex items-center gap-1">
          {(['best', 'new', 'top'] as const).map(option => {
            const Icon = sortIcons[option];
            return <LocalizedLink key={option} href={hrefs.sorts[option]} aria-current={sort === option ? 'page' : undefined}
              title={option === 'best' ? t.bestHelp : option === 'new' ? t.newHelp : t.topHelp} className={segment}>
              <Icon aria-hidden="true" className="size-4" />{t[option]}</LocalizedLink>;
          })}
        </nav>
      </div>
      {sort === 'top' ? <nav aria-label={t.period} className="flex flex-wrap items-center gap-1">
        {(['week', 'month', 'all'] as const).map(option => <LocalizedLink key={option} href={hrefs.windows[option]}
          aria-current={window === option ? 'page' : undefined} className={cn(segment, 'h-8 px-3 text-xs')}>
          {option === 'week' ? t.week : option === 'month' ? t.month : t.allTime}</LocalizedLink>)}
      </nav> : null}
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
