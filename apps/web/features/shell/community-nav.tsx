'use client';

import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, CompassIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { localizedPath, withoutLocale } from '../../i18n/locale.ts';
import { type Community, type CommunityNavigation, NAV_COMMUNITIES } from './communities.ts';
import { CommunityIcon } from './community-icon.tsx';
import { useShell } from './shell-provider.tsx';
import { useSideNav } from './side-nav.tsx';

const row = cn('flex h-9 items-center gap-3 rounded-xl px-3 text-muted-foreground text-sm outline-none',
  'transition-colors hover:bg-accent/60 hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
  'aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground');

function Section({ title, collapsed, children }: { title: string; collapsed: boolean; children: React.ReactNode }) {
  return <section aria-label={title} className="min-w-0 border-border/60 border-t pt-3">
    <h2 className={collapsed ? 'sr-only' : 'mb-1 px-3 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.08em]'}>
      {title}</h2>
    {children}
  </section>;
}

function CommunityList({ items, collapsed, avatarQuery, onNavigate }: {
  items: Community[]; collapsed: boolean; avatarQuery: string; onNavigate?: () => void;
}) {
  const { locale, t } = useShell();
  const pathname = withoutLocale(usePathname());
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, NAV_COMMUNITIES);
  return <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
    {shown.map(item => <li key={item.id}>
      <Link href={localizedPath(item.href, locale)} onClick={onNavigate} title={collapsed ? item.name : undefined}
        aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'page' : undefined}
        className={cn(row, collapsed && 'justify-center px-0')}>
        <span className="relative">
          <CommunityIcon icon={item.icon} name={item.name} avatarQuery={avatarQuery} />
          {item.activity === 'new' && collapsed
            ? <span aria-hidden="true" className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-brand ring-2
              ring-sidebar" /> : null}
        </span>
        <span lang={item.language} className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.name}</span>
        {item.activity === 'new' ? <>
          {collapsed ? null : <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand" />}
          <span className="sr-only">, {t.newActivity}</span>
        </> : null}
      </Link>
    </li>)}
    {items.length > NAV_COMMUNITIES && !collapsed ? <li>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        className={cn(row, 'w-full text-xs')}>
        <ChevronDownIcon aria-hidden="true" className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
        {expanded ? t.showFewer : t.showAll({ count: String(items.length) })}
      </button>
    </li> : null}
  </ul>;
}

/**
 * The side navigation below its main items, in Reddit's order: the Zones and
 * Realms the reader follows, with a dot where there is activity they have not
 * seen, the official Zones for everyone, and Manage for moderators.
 */
export function CommunityNav({ data }: { data: CommunityNavigation }) {
  const { locale, t } = useShell();
  const { collapsed, onNavigate } = useSideNav();
  const pathname = withoutLocale(usePathname());
  const open = data.moderated.reduce((total, item) => total + item.open, 0);
  const more = data.moderated.some(item => item.more);
  const followed = data.followed;
  return <div className="grid min-w-0 gap-3">
    {followed && followed.zones.length ? <Section title={t.yourZones} collapsed={collapsed}>
      <CommunityList items={followed.zones} collapsed={collapsed} avatarQuery={data.avatarQuery} onNavigate={onNavigate} />
    </Section> : null}
    {followed && followed.realms.length ? <Section title={t.yourRealms} collapsed={collapsed}>
      <CommunityList items={followed.realms} collapsed={collapsed} avatarQuery={data.avatarQuery} onNavigate={onNavigate} />
    </Section> : null}
    {followed && !followed.zones.length && !followed.realms.length && !collapsed
      ? <Section title={t.yourRealms} collapsed={collapsed}>
        <p className="px-3 text-muted-foreground text-xs">{t.noCommunities}</p>
        <Link href={localizedPath('/discover', locale)} onClick={onNavigate} className={cn(row, 'mt-1')}>
          <CompassIcon aria-hidden="true" className="size-5" />{t.findCommunities}</Link>
      </Section> : null}
    {data.official.length ? <Section title={t.officialZones} collapsed={collapsed}>
      <CommunityList items={data.official} collapsed={collapsed} avatarQuery="" onNavigate={onNavigate} />
    </Section> : null}
    {data.moderated.length ? <Section title={t.moderation} collapsed={collapsed}>
      <Link href={localizedPath('/manage', locale)} onClick={onNavigate} title={collapsed ? t.manage : undefined}
        aria-current={pathname === '/manage' || pathname.startsWith('/manage/') ? 'page' : undefined}
        className={cn(row, collapsed && 'justify-center px-0')}>
        <ShieldCheckIcon aria-hidden="true" className="size-5 shrink-0" />
        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{t.manage}</span>
        {open ? <span className={cn('rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-[11px] text-primary',
          collapsed && 'sr-only')}>{t.queueWaiting({ count: `${open}${more ? '+' : ''}` })}</span> : null}
      </Link>
    </Section> : null}
  </div>;
}
