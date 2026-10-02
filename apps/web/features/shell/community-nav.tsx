'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import { localizedPath, withoutLocale } from '../../i18n/locale.ts';
import { mainRelationships } from '../relationships/api.ts';
import { observeRelationships } from '../relationships/events.ts';
import { relationshipSource } from '../relationships/list.ts';
import { messages } from '../relationships/messages.ts';
import type { RelationshipsApi } from '../relationships/types.ts';
import { type Community, type CommunityNavigation, manageHref, NAV_COMMUNITIES } from './communities.ts';
import { pinnedCommunities, spaceCommunities } from './communities-relationships.ts';
import { CommunityIcon } from './community-icon.tsx';
import { useShell } from './shell-provider.tsx';
import { useSideNav } from './side-nav.tsx';

const row = cn('flex min-h-9 items-center gap-3 rounded-xl px-3 py-1.5 text-muted-foreground text-sm outline-none',
  'transition-colors hover:bg-accent/60 hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
  'aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground');

function Section({ title, collapsed, children }: { title: string; collapsed: boolean; children: React.ReactNode }) {
  return <section aria-label={title} className="min-w-0 border-border/60 border-t pt-3">
    <h2 className={collapsed ? 'sr-only' : 'mb-1 px-3 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.08em]'}>
      {title}</h2>{children}</section>;
}

function CommunityList({ initial, load, collapsed, avatarQuery, onNavigate, title, emptyLabel }: {
  initial: EntityPickerPage<Community> | null; load?: (q: string, cursor: string | null) => Promise<EntityPickerPage<Community>>;
  collapsed: boolean; avatarQuery: string; onNavigate?: () => void; title: string; emptyLabel?: string;
}) {
  const { locale, t } = useShell();
  const copy = messages[locale];
  const pathname = withoutLocale(usePathname());
  const [expanded, setExpanded] = useState(false);
  const [q, setQ] = useState('');
  const source = useMemo(() => {
    let seeded = false;
    return relationshipSource(async query => {
      if (!seeded && initial && !query.q && !query.cursor) { seeded = true; return initial; }
      if (load) return load(query.q, query.cursor);
      if (!initial) throw new Error('Relationship read unavailable');
      return { items: initial.items.filter(item => item.name.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())),
        nextCursor: null, complete: true };
    }, item => item.id, item => item.name);
  }, [initial, load]);
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => {
    const timer = setTimeout(() => void source.search(q), q ? 200 : 0);
    return () => { clearTimeout(timer); source.cancel(); };
  }, [source, q]);
  useEffect(() => observeRelationships(() => void source.search(q)), [source, q]);
  const shown = expanded && !collapsed ? state.items : state.items.slice(0, NAV_COMMUNITIES);
  const hasMore = state.items.length > NAV_COMMUNITIES || !state.complete && Boolean(state.nextCursor);
  return <div className="grid min-w-0 gap-1">
    {expanded && !collapsed ? <label className="grid gap-1 px-3 text-xs">{copy.search}
      <Input type="search" value={q} maxLength={80} onChange={event => setQ(event.target.value)} /></label> : null}
    <ul className={cn('grid min-w-0 gap-0.5', expanded && !collapsed && 'max-h-72 overflow-y-auto')}>
      {shown.map(item => <li key={item.id}>
        <Link href={localizedPath(item.href, locale)} onClick={onNavigate} title={collapsed ? item.name : undefined}
          aria-current={pathname === item.href || pathname.startsWith(item.href + '/') ? 'page' : undefined}
          className={cn(row, collapsed && 'justify-center px-0')}>
          <span className="relative"><CommunityIcon icon={item.icon} name={item.name} person={item.person} avatarQuery={avatarQuery} />
            {item.activity === 'new' && collapsed ? <span aria-hidden="true"
              className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-brand ring-2 ring-sidebar" /> : null}</span>
          <span lang={item.language} dir={item.direction} className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.name}</span>
          {item.activity === 'new' ? <>{collapsed ? null : <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand" />}
            <span className="sr-only">, {t.newActivity}</span></> : null}
        </Link></li>)}
    </ul>
    {state.error ? <div className="grid gap-1 px-3"><p role="status" className="text-muted-foreground text-xs">{copy.unavailable}</p>
      <Button size="xs" variant="ghost" onClick={() => void source.retry()}>{copy.retry}</Button></div> : null}
    {state.loading && !collapsed ? <p role="status" className="px-3 text-muted-foreground text-xs">{copy.loading}</p> : null}
    {!shown.length && state.complete && !state.error && !collapsed
      ? <p className="px-3 text-muted-foreground text-xs">{q ? copy.noResults : emptyLabel ?? copy.empty}</p> : null}
    {!collapsed && (hasMore || expanded) ? <button type="button" aria-expanded={expanded}
      className={cn(row, 'w-full text-xs')} onClick={() => { setExpanded(!expanded); if (expanded) setQ(''); }}>
      <ChevronDownIcon aria-hidden="true" className={cn('size-4', expanded && 'rotate-180')} />
      {expanded ? copy.showFewer : copy.showAll}</button> : null}
    {expanded && !collapsed && !state.complete && state.nextCursor && !state.error ? <Button size="xs" variant="ghost"
      disabled={state.loading} onClick={() => void source.more()}>{copy.more}</Button> : null}
    {collapsed && hasMore ? <Link href={localizedPath('/following', locale)} onClick={onNavigate}
      className={cn(row, 'justify-center px-0')} title={copy.showAll} aria-label={title + ' · ' + copy.showAll}>
      <ChevronDownIcon aria-hidden="true" className="size-4" /></Link> : null}
  </div>;
}

/** One relationship inventory serves both the desktop rail and phone navigation sheet. */
export function CommunityNav({ data, api: supplied }: { data: CommunityNavigation; api?: RelationshipsApi }) {
  const { locale, t } = useShell();
  const copy = messages[locale];
  const { collapsed, onNavigate } = useSideNav();
  const pathname = withoutLocale(usePathname());
  const actor = data.relationships?.actingSubject;
  const api = useMemo(() => supplied ?? (actor ? mainRelationships(actor) : null), [supplied, actor]);
  const loadPins = useMemo(() => api ? (q: string, cursor: string | null) => pinnedCommunities(api, q, cursor) : undefined, [api]);
  const loadSpaces = useMemo(() => api ? (q: string, cursor: string | null) => spaceCommunities(api, q, cursor) : undefined, [api]);
  const legacy = useMemo(() => data.followed ? { items: [...data.followed.realms, ...data.followed.zones],
    nextCursor: null, complete: true } : null, [data.followed]);
  const emptyPins = useMemo(() => ({ items: [], complete: true, nextCursor: null }), []);
  const official = useMemo(() => ({ items: data.official, complete: true, nextCursor: null }), [data.official]);
  const [hasFollows, setHasFollows] = useState<boolean | null>(data.relationships ? data.relationships.hasFollows
    : data.signedIn ? legacy ? legacy.items.length > 0 : null : false);
  useEffect(() => {
    setHasFollows(data.relationships ? data.relationships.hasFollows : data.signedIn ? legacy ? legacy.items.length > 0 : null : false);
    if (!api) return;
    return observeRelationships(() => {
      void api.follows().then(page => setHasFollows(page.items.length > 0 || !page.complete)).catch(() => setHasFollows(null));
    });
  }, [api, data.relationships?.hasFollows, data.signedIn, legacy]);
  const open = data.moderated.reduce((total, item) => total + item.open, 0);
  const more = data.moderated.some(item => item.more);
  return <div className="grid min-w-0 gap-3">
    {data.signedIn ? <>
      <Section title={copy.pinned} collapsed={collapsed}>
        <CommunityList title={copy.pinned} emptyLabel={copy.emptyPins} initial={data.relationships ? data.relationships.pinned : emptyPins}
          load={loadPins} collapsed={collapsed} avatarQuery={data.avatarQuery} onNavigate={onNavigate} />
      </Section>
      <Section title={copy.communities} collapsed={collapsed}>
        <CommunityList title={copy.communities} emptyLabel={copy.emptySpaces} initial={data.relationships ? data.relationships.spaces : legacy}
          load={loadSpaces} collapsed={collapsed} avatarQuery={data.avatarQuery} onNavigate={onNavigate} />
        <Link href={localizedPath('/following', locale)} onClick={onNavigate} title={collapsed ? copy.manage : undefined}
          aria-current={pathname === '/following' ? 'page' : undefined} className={cn(row, collapsed && 'justify-center px-0')}>
          <span className={collapsed ? 'sr-only' : undefined}>{copy.manage}</span>
          {collapsed ? <ChevronDownIcon aria-hidden="true" className="size-4" /> : null}</Link>
      </Section>
    </> : null}
    {data.moderated.length ? <Section title={t.moderation} collapsed={collapsed}>
      <Link href={localizedPath(manageHref(data.moderated), locale)} onClick={onNavigate} title={collapsed ? t.manage : undefined}
        aria-current={pathname === '/manage' || pathname.startsWith('/manage/') ? 'page' : undefined}
        className={cn(row, collapsed && 'justify-center px-0')}>
        <ShieldCheckIcon aria-hidden="true" className="size-5 shrink-0" />
        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{t.manage}</span>
        {open ? <span className={cn('rounded-full bg-primary px-2 py-0.5 font-semibold text-[11px] text-primary-foreground',
          collapsed && 'sr-only')}>{t.queueWaiting({ count: String(open) + (more ? '+' : '') })}</span> : null}
      </Link>
    </Section> : null}
    {hasFollows === false && data.official.length ? <Section title={t.officialZones} collapsed={collapsed}>
      <CommunityList title={t.officialZones} initial={official} collapsed={collapsed} avatarQuery="" onNavigate={onNavigate} />
    </Section> : null}
  </div>;
}
