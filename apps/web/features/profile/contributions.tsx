'use client';

import { communityHref, markedSpoiler, threadPath } from '../feed/discussion.ts';

import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { MarkdownBody } from '../post-composer/markdown.tsx';
import Link from '../shell/localized-link.tsx';
import type { ProfileMessages } from './messages.ts';

type Kind = 'posts' | 'comments';
interface Item { reply: string; realm: string; parent: string | null; time: string;
  title: string | null; excerpt: string; spoiler?: boolean }
export type ContributionPage = { items: Item[]; nextCursor: string | null };

/** The excerpt stays out of the page until the reader asks, as a feed card veils a declared spoiler. */
function SpoilerExcerpt({ text, showSpoiler, announced }: { text: string; showSpoiler: string; announced: string }) {
  const [shown, setShown] = useState(false);
  if (shown) return <MarkdownBody text={text} showSpoiler={showSpoiler}
    className="line-clamp-3 text-sm/relaxed [overflow-wrap:anywhere]" />;
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <EyeOffIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="text-muted-foreground">{announced}</span>
    <button type="button" onClick={() => setShown(true)}
      className={cn(buttonVariants({ variant: 'outline', size: 'xs', pill: true }), 'h-6')}>
      <EyeIcon aria-hidden="true" />{showSpoiler}</button>
  </div>;
}

export function ProfileContributions({ agent, actingSubject, locale, messages, children, load }: {
  agent: string; actingSubject: string | null; locale: UiLocale; messages: ProfileMessages;
  children: ReactNode; load?: (kind: Kind, cursor?: string) => Promise<ContributionPage>;
}) {
  const t = materializeData(messages, { locale });
  const id = useId();
  const [kind, setKind] = useState<'overview' | Kind>('overview');
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState<ContributionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (kind === 'overview') return;
    let current = true;
    setLoading(true);
    setFailed(false);
    const read = load ? load(kind, cursor) : browserMainApi().v1.agents({ id: agent.slice(-36) })
      ['realm-contributions'].get({ query: { kind, ...(cursor ? { cursor } : {}),
        ...(actingSubject ? { actingSubject } : {}) } }).then(result => result.data
        ? { items: result.data.items, nextCursor: result.data.nextCursor } : null);
    void read.then(result => {
      if (!current) return;
      setPage(result);
      setFailed(!result);
    }).catch(() => { if (current) { setPage(null); setFailed(true); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [agent, actingSubject, kind, cursor, load]);
  const select = (next: 'overview' | Kind) => { setKind(next); setCursor(undefined); setPage(null); };
  return <div className="grid gap-6">
    <div role="tablist" aria-label={t.activityTabs} className="flex gap-2 overflow-x-auto border-border border-b">
      {(['overview', 'posts', 'comments'] as const).map(tab => <button key={tab} type="button" role="tab"
        aria-selected={kind === tab} aria-controls={`${id}-panel`} id={`${id}-${tab}`}
        onClick={() => select(tab)} className={kind === tab
          ? 'shrink-0 border-primary border-b-2 px-3 py-2 font-semibold text-sm'
          : 'shrink-0 px-3 py-2 text-muted-foreground text-sm hover:text-foreground'}>{t[tab]}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${kind}`}>
      {kind === 'overview' ? children : <div className="grid gap-4">
        {loading ? <p role="status" className="text-muted-foreground">{t.contributionsLoading}</p>
          : failed ? <p role="alert" className="text-destructive-foreground">{t.contributionsFailed}</p>
            : page?.items.length ? <ol className="divide-y divide-border rounded-xl border border-border bg-card
              px-4">{page.items.map(item => <li key={item.reply} className="grid gap-1 py-4">
              <Link href={threadPath(communityHref(item.realm), item.reply)}
                className="font-semibold underline-offset-2 hover:underline">
                {item.title || (kind === 'comments' ? t.comment : t.post)}</Link>
              <time dateTime={item.time} className="text-muted-foreground text-xs">
                {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(item.time))}</time>
              {item.excerpt ? markedSpoiler(item.spoiler)
                ? <SpoilerExcerpt text={item.excerpt} showSpoiler={t.showSpoiler} announced={t.spoilerAnnounced} />
                : <MarkdownBody text={item.excerpt} showSpoiler={t.showSpoiler}
                  className="line-clamp-3 text-sm/relaxed [overflow-wrap:anywhere]" /> : null}
            </li>)}</ol> : <p className="text-muted-foreground">{kind === 'posts' ? t.noPosts : t.noComments}</p>}
        {page && (cursor || page.nextCursor) ? <div className="flex justify-between gap-3">
          {cursor ? <Button variant="outline" onClick={() => setCursor(undefined)}>{t.firstPage}</Button>
            : <span />}
          {page.nextCursor ? <Button variant="outline" onClick={() => setCursor(page.nextCursor!)}>
            {t.nextPage}</Button> : null}</div> : null}
      </div>}
    </div>
  </div>;
}
