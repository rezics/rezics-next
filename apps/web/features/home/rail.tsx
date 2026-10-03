import { cn } from '@rezics/ui/utils';
import { ShieldCheckIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref, spaceHref } from '../address/path.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import type { SuggestedFollow } from '../feed/types.ts';
import type { FeedPage } from '../feed/types.ts';
import { manageHref, type Moderated } from '../shell/communities.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { FollowButton } from './follow-button.tsx';
import type { HomeMessages } from './messages.ts';
import type { TrendingWork } from './server.ts';
import { browseMessages } from '../discover/browse-messages.ts';

type T = ReturnType<typeof materializeData<HomeMessages>>;

function Module({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <section aria-label={title} className={cn('grid gap-3 rounded-2xl border border-border/60 bg-card p-4',
    className)}>
    <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-[0.08em]">{title}</h2>
    {children}
  </section>;
}

export function membersLabel(count: SuggestedFollow['membership']['count'], t: T): string | null {
  if (count.kind === 'exact') return t.members(count.value);
  if (count.kind === 'estimated') return t.membersAbout(count.value);
  return null;
}

/** Why Main suggests a community: the chosen topic its Works carry, or its activity. */
export function reasonLabel(item: SuggestedFollow, t: T): string {
  return item.reason.kind === 'matching-concept' && item.reason.concept.name
    ? t.reasonConcept({ concept: item.reason.concept.name.value }) : t.reasonPopular;
}

export interface RailData {
  trending: { scope: 'followed' | 'global'; items: TrendingWork[] };
  suggestions: SuggestedFollow[];
  moderated: Moderated[];
  ranking: FeedPage['ranking'] | null;
  /** Official Zones' route segments by Realm, so a suggestion links as `/r/fiction` where it has one. */
  realmSegments?: Readonly<Record<string, string>>;
}

/**
 * The right rail at wide sizes: what is being read in the reader's Realms,
 * Realms to follow with the reason for each, the moderation queue for
 * moderators, and how Home orders posts. Its footer lives here, so infinite
 * scroll never hides one.
 */
export function Rail({ data, signedIn, locale, messages, avatarQuery = '' }: {
  data: RailData; signedIn: boolean; locale: UiLocale; messages: HomeMessages;
  avatarQuery?: string;
}) {
  const t = materializeData(messages, { locale });
  const open = data.moderated.reduce((total, item) => total + item.open, 0);
  return <div className="grid gap-4">
    {data.moderated.length ? <Module title={t.queueTitle}>
      <ul className="grid gap-1.5">
        {data.moderated.map(item => <li key={item.realm} className="flex items-center gap-2 text-sm">
          <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <LocalizedLink href={localizedPath(item.href, locale)} lang={item.language}
            className="min-w-0 flex-1 truncate hover:underline">{item.name}</LocalizedLink>
          <span className="shrink-0 text-muted-foreground">{item.open
            ? t.queueWaiting({ count: `${item.open}${item.more ? '+' : ''}` }) : t.queueClear}</span>
        </li>)}
      </ul>
      <LocalizedLink href={localizedPath(manageHref(data.moderated), locale)} className="font-medium text-primary text-sm
        underline-offset-4 hover:underline">{t.openManage}{open ? ` · ${t.queueWaiting({ count: String(open) })}` : ''}
      </LocalizedLink>
    </Module> : null}
    <Module title={data.trending.scope === 'followed' ? t.trendingFollowed : t.trendingGlobal}>
      {data.trending.items.length ? <ol className="grid gap-3">
        {data.trending.items.map(({ item, realm }, index) => <li key={item.work}
          className="group/trend relative grid grid-cols-[1.25rem_2.5rem_minmax(0,1fr)] items-center gap-3">
          <span className="text-center font-semibold text-muted-foreground text-sm tabular-nums">{index + 1}</span>
          <CatalogueCover work={{ id: item.work, title: item.title, cover: item.cover, kind: coverKindOf(item.types),
            authors: [] }} avatarQuery={avatarQuery} size="xs" />
          <span className="grid min-w-0 gap-0.5">
            <LocalizedLink href={resourceHref('/w/', item.work)} lang={item.title.language}
              className="line-clamp-2 font-medium font-work-title text-sm/snug outline-none after:absolute
                after:inset-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{item.title.value}</LocalizedLink>
            {realm ? <span lang={realm.language} className="truncate text-muted-foreground text-xs">{realm.name}</span>
              : null}
          </span>
        </li>)}
      </ol> : <p className="text-muted-foreground text-sm">{t.trendingEmpty}</p>}
    </Module>
    {data.suggestions.length ? <Module title={signedIn ? t.realmsToFollow : t.popularRealms}>
      <ul className="grid gap-3">
        {data.suggestions.slice(0, 3).map(item => {
          const members = membersLabel(item.membership.count, t);
          return <li key={item.id} className="flex items-center gap-3">
            <CommunityIcon icon={item.icon} name={item.name.value} size="md" avatarQuery={avatarQuery} />
            <span className="grid min-w-0 flex-1">
              <LocalizedLink href={localizedPath(spaceHref(data.realmSegments?.[item.realm] ?? item.realm, 'community'), locale)}
                lang={item.name.language}
                className="truncate font-medium text-sm hover:underline">{item.name.value}</LocalizedLink>
              <span className="truncate text-muted-foreground text-xs">
                {[reasonLabel(item, t), members].filter(Boolean).join(' · ')}</span>
            </span>
            <FollowButton target={item.id} kind={item.kind} realm={item.realm} name={item.name.value}
              label={t.followRealm({ realm: item.name.value })}
              followLabel={t.follow} followedLabel={t.followed} failedLabel={t.followOneFailed} />
          </li>;
        })}
      </ul>
      <LocalizedLink href="/discover?tab=communities" className="font-medium text-primary text-sm underline-offset-4 hover:underline">
        {browseMessages[locale].seeAll}</LocalizedLink>
    </Module> : null}
    {data.ranking ? <details className="group rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground outline-none marker:text-muted-foreground
        focus-visible:ring-2 focus-visible:ring-ring">{t.howHomeWorks}</summary>
      <div className="mt-2 grid gap-2 text-muted-foreground text-xs/relaxed">
        <p>{t.howBest({ hours: String(data.ranking.decayHours) })}</p>
        <p>{t.howCap({ cap: String(data.ranking.realmCap), window: String(data.ranking.diversityWindow) })}</p>
        <p>{t.howNew}</p>
        {signedIn ? <p>{t.howFollowing}</p> : null}
        {signedIn ? <p>{t.howPinned}</p> : null}
      </div>
    </details> : null}
    <p className="px-1 text-muted-foreground text-xs">© REZICS</p>
  </div>;
}
