import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { WorkCover } from '@rezics/ui/work-cover';
import { type HeaderSlotProps, type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps,
  type ZoneLinkProps, type ZoneModRelease, type ZoneSlotProps, type ZoneWork } from '@rezics/zone-sdk';
import { BlocksIcon, DownloadIcon, FlameIcon, Gamepad2Icon, LayersIcon, TrendingUpIcon, UsersIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { strings } from './strings.ts';

// Slots of the official Mods Zone, a game-mod hub. Cards lead with the one
// action a mod page needs, getting it; the platform keeps each card's "Why
// here?" stamp in the card's top corner, which these cards leave free.

type Strings = ReturnType<typeof strings>;
const DAY = 86_400_000;

/** How long ago a Work last changed, in the reader's language, and whether that was this week. */
function freshness(at: string, locale: string, now = Date.now()): { ago: string; thisWeek: boolean } | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const days = Math.max(0, Math.floor((now - time) / DAY));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ago = days < 30 ? format.format(-days, 'day')
    : days < 365 ? format.format(-Math.floor(days / 30), 'month') : format.format(-Math.floor(days / 365), 'year');
  return { ago, thisWeek: days < 7 };
}

/** When a pick last changed: its mod's latest release, or else its last published revision. */
const lastUpdate = (work: ZoneWork) => work.mod?.updatedAt ?? work.updatedAt;

/** The game and its versions a mod runs on, in one line (`Minecraft 1.21.1`). */
const gameLine = (mod: ZoneModRelease) => [mod.game, ...mod.gameVersions].join(' ');

/**
 * What a player checks before installing a pick: the game and versions, the
 * loader, the latest release, whether it is kept up and when it last changed.
 */
function Badges({ work, locale, t }: { work: ZoneWork; locale: string; t: Strings }) {
  const at = lastUpdate(work);
  const fresh = at ? freshness(at, locale) : null;
  const { mod } = work;
  if (!mod && !work.status && !fresh) return null;
  return <ul className="mh-badges">
    {mod ? <li data-game="" translate="no">{gameLine(mod)}</li> : null}
    {mod?.loaders.map(loader => <li key={loader} data-loader="" translate="no">{loader}</li>)}
    {mod?.version ? <li translate="no"><span className="sr-only">{t.release} </span>{t.version(mod.version)}</li>
      : null}
    {work.status ? <li data-status={work.status}>{t.status[work.status]}</li> : null}
    {fresh ? <li data-fresh={fresh.thisWeek ? '' : undefined}><time dateTime={at ?? undefined}>
      {t.updated(fresh.ago)}</time></li> : null}
  </ul>;
}

const updatedThisWeek = (works: readonly ZoneWork[], locale: string) =>
  works.filter(work => {
    const at = lastUpdate(work);
    return at && freshness(at, locale)?.thisWeek;
  }).length;

/** Square tiles, as mod icons are, whatever kind of cover the Work has. */
function Thumb({ work, Link, eager }: { work: ZoneWork; Link: ComponentType<ZoneLinkProps>; eager?: boolean }) {
  return <Link href={work.href} tabIndex={-1} aria-hidden="true" className="mh-thumb">
    <WorkCover {...workCoverProps(work)} kind="package" loading={eager ? 'eager' : 'lazy'} /></Link>;
}

function Get({ work, title, t, Link, large }: {
  work: ZoneWork; title: string; t: Strings; Link: ComponentType<ZoneLinkProps>; large?: boolean;
}) {
  return <Link href={work.href} className="mh-get" data-size={large ? 'large' : undefined}>
    <DownloadIcon aria-hidden="true" /><span className="mh-get-label">{t.get}</span><span className="sr-only"> {title}</span>
  </Link>;
}

/** A download-first card: a row in lists, a tile in collections and a one-line entry in the rail. */
export function ModsCard({ zone, work, layout, rank, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  const title = work.title?.value ?? t.untitled;
  return <article className="mh-card" data-layout={layout}>
    {rank && layout !== 'cover' ? <span className="mh-rank" data-top={rank <= 3 ? '' : undefined}>{rank}</span> : null}
    <Thumb work={work} Link={Link} />
    <div className="mh-card-body">
      <h3 lang={work.title?.lang} dir={work.title?.dir} className="mh-card-title">
        <Link href={work.href}>{title}</Link></h3>
      {work.author ? <p lang={work.author.lang || undefined} className="mh-by">{t.by(work.author.value)}</p> : null}
      {work.mod && layout === 'rail' ? <p className="mh-by" translate="no">
        {[gameLine(work.mod), ...work.mod.loaders].join(' · ')}</p> : null}
      {work.tagline && layout !== 'rail' ? <p lang={work.tagline.lang} dir={work.tagline.dir} className="mh-hook">
        {work.tagline.value}</p> : null}
      {layout !== 'rail' ? <Badges work={work} locale={zone.locale} t={t} /> : null}
    </div>
    <Get work={work} title={title} t={t} Link={Link} />
  </article>;
}

/** The hub's header: its mark on a block grid, the Zone's name and the platform controls. */
export function ModsHeader({ zone, actions, members }: HeaderSlotProps) {
  const t = strings(zone.locale);
  return <header className="mh-hub">
    <div className="mh-page mh-hub-inner">
      <span aria-hidden="true" className="mh-hub-icon"><BlocksIcon /></span>
      <div className="mh-hub-copy">
        <p className="mh-eyebrow">{t.official}</p>
        <h1 lang={zone.name.lang} dir={zone.name.dir} className="mh-wordmark">{zone.name.value}</h1>
        <p lang={zone.description?.lang} className="mh-tagline">{zone.description?.value ?? t.tagline}</p>
      </div>
      <div className="mh-hub-side">
        {members ? <p className="mh-stat"><UsersIcon aria-hidden="true" />{members}</p> : null}
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  </header>;
}

/** The featured pick as a spotlight with its Get button, and the other picks beside it. */
export function ModsHero({ zone, banners, card, whyHere, Link, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  const [lead, ...rest] = picks;
  if (!lead || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  const title = lead.title?.value ?? t.untitled;
  return <section aria-labelledby="mh-featured" className="mh-featured">
    <div className="mh-page mh-featured-grid">
      <article className="mh-spotlight">
        <Thumb work={lead} Link={Link} eager />
        <div className="mh-spotlight-copy">
          <h2 id="mh-featured" className="mh-eyebrow"><FlameIcon aria-hidden="true" />{t.featured}</h2>
          <h3 lang={lead.title?.lang} dir={lead.title?.dir} className="mh-spotlight-title">
            <Link href={lead.href}>{title}</Link></h3>
          {lead.author ? <p lang={lead.author.lang || undefined} className="mh-by">{t.by(lead.author.value)}</p> : null}
          {lead.tagline ? <p lang={lead.tagline.lang} dir={lead.tagline.dir} className="mh-hook">
            {lead.tagline.value}</p> : null}
          <Badges work={lead} locale={zone.locale} t={t} />
          <div className="mh-actions">
            <Get work={lead} title={title} t={t} Link={Link} large />
            <span className="mh-stamp">{whyHere(lead)}</span>
          </div>
        </div>
      </article>
      {rest.length ? <section aria-labelledby="mh-also" className="mh-also">
        <h2 id="mh-also" className="mh-eyebrow">{t.alsoFeatured}</h2>
        <ol className="mh-stack">{rest.map(work => <li key={work.id}>{card(work, { layout: 'rail' })}</li>)}</ol>
      </section> : null}
    </div>
  </section>;
}

/** Entry points up front: the Zone's games and loaders as a filter bar. */
export function ModsFilters({ module, data, Link }: ModuleSlotProps<'chip-nav'>) {
  const heading = `mh-filters-${module.id}`;
  return <nav aria-labelledby={heading} data-zone-module="chip-nav" className="mh-filters">
    <h2 id={heading} className="mh-filters-label">{module.title}</h2>
    <ul className="mh-chips">
      {data.chips.map(chip => <li key={chip.id}>
        <Link href={chip.href} lang={chip.label.lang} className="mh-chip">
          <Gamepad2Icon aria-hidden="true" />{chip.label.value}</Link>
      </li>)}
    </ul>
  </nav>;
}

function SectionHead({ id, title, icon, note, more, t, Link }: {
  id: string; title: string; icon?: ReactNode; note?: ReactNode; more: string | null; t: Strings;
  Link: ComponentType<ZoneLinkProps>;
}) {
  return <header className="mh-section-head">
    <h2 id={id} className="mh-section-title">{icon}{title}</h2>
    {note}
    {more ? <Link href={more} className="mh-more">{t.more}</Link> : null}
  </header>;
}

/** Rankings as a trending board: today, this week and this month, numbered rows with Get. */
export function ModsTrending({ zone, module, data, card, Link }: ModuleSlotProps<'ranking'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `mh-trending-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="ranking" className="zone-module mh-board">
    <SectionHead id={heading} title={module.title} icon={<TrendingUpIcon aria-hidden="true" />} more={module.more}
      t={t} Link={Link} />
    <Tabs defaultValue={tabs[0]?.interval} className="gap-3">
      <TabsList aria-label={module.title}>
        {tabs.map(tab => <TabsTrigger key={tab.interval} value={tab.interval} className="px-3">
          {t.intervals[tab.interval]}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.interval} value={tab.interval}>
        <ol className="mh-list">
          {tab.items.slice(0, 10).map(item => <li key={item.work.id}>
            {card(item.work, { layout: 'row', rank: item.rank })}</li>)}
        </ol>
      </TabsContent>)}
    </Tabs>
  </section>;
}

/** Shelves as the hub's lists: the first rows of each, every one leading with Get, and how many changed this week. */
export function ModsShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `mh-shelf-${module.id}`;
  const fresh = updatedThisWeek([...new Map(tabs.flatMap(tab => tab.items).map(work => [work.id, work])).values()],
    zone.locale);
  const list = (items: readonly ZoneWork[]) => <ul className="mh-list">
    {items.slice(0, 6).map(work => <li key={work.id}>{card(work, { layout: 'row' })}</li>)}</ul>;
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module mh-board">
    <SectionHead id={heading} title={module.title} more={module.more} t={t} Link={Link}
      note={fresh ? <p className="mh-pulse"><span aria-hidden="true" />{t.updatedThisWeek(fresh)}</p> : null} />
    {tabs.length === 1 ? list(tabs[0]!.items) : <Tabs defaultValue={tabs[0]?.id} className="gap-3">
      <TabsList aria-label={module.title}>
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="px-3">{tab.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>{list(tab.items)}</TabsContent>)}
    </Tabs>}
  </section>;
}

/** Editors' lists as collections: a named set of tiles, each one Get away. */
export function ModsCollections({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  const heading = `mh-collections-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="editorial-list" className="zone-module mh-board">
    <SectionHead id={heading} title={module.title} more={null} t={t} Link={Link} />
    {data.lists.map((list, index) => <article key={list.id} aria-labelledby={`${heading}-${index}`}
      className="mh-collection">
      <header className="mh-collection-head">
        <span aria-hidden="true" className="mh-collection-icon"><LayersIcon /></span>
        <div className="min-w-0 flex-1">
          <p className="mh-eyebrow">{t.collection} · {t.count(list.items.length)}</p>
          <h3 id={`${heading}-${index}`} lang={list.title.lang} dir={list.title.dir} className="mh-collection-title">
            {list.title.value}</h3>
          {list.blurb ? <p lang={list.blurb.lang} className="mh-hook">{list.blurb.value}</p> : null}
        </div>
        {list.href ? <Link href={list.href} className="mh-more">{t.more}</Link> : null}
      </header>
      <ul className="mh-tiles">
        {list.items.map(work => <li key={work.id}>{card(work, { layout: 'cover' })}</li>)}
      </ul>
    </article>)}
  </section>;
}

/** A closing band: what the hub is and where its decisions are. */
export function ModsFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="mh-footer">
    <div className="mh-page mh-footer-inner">
      <span aria-hidden="true" className="mh-hub-icon mh-hub-icon-small"><BlocksIcon /></span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{t.footerTitle}</p>
        <p className="max-w-xl text-pretty text-sm opacity-80">{t.footerNote}</p>
      </div>
      <nav aria-label={t.footerTitle}>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <li><Link href={zone.links.works}>{t.works}</Link></li>
          <li><Link href={zone.links.decisions}>{t.decisions}</Link></li>
          <li><Link href={zone.links.about}>{t.about}</Link></li>
        </ul>
      </nav>
    </div>
  </footer>;
}
