import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { WorkCover } from '@rezics/ui/work-cover';
import { type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps, type ZoneLinkProps,
  type ZoneModRelease, type ZoneWork } from '@rezics/zone-sdk';
import { HistoryIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { strings } from './strings.ts';

// Slots of the official Mods Zone, laid out as Modrinth lists projects: a
// row per mod with its icon, name and author, one-line summary and what it
// runs on (environment, loaders, game versions), and when it last changed at
// the end. The Zone keeps REZICS's colours and type; only the layout is its
// own. REZICS counts no downloads, so no row shows one. The platform keeps
// each card's "Why here?" stamp in its top corner, which these rows leave free.

type Strings = ReturnType<typeof strings>;
const DAY = 86_400_000;

/** How long ago a Work last changed, in the reader's language. */
function ago(at: string, locale: string, now = Date.now()): string | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const days = Math.max(0, Math.floor((now - time) / DAY));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return days < 30 ? format.format(-days, 'day')
    : days < 365 ? format.format(-Math.floor(days / 30), 'month') : format.format(-Math.floor(days / 365), 'year');
}

/** When a pick last changed: its mod's newest release, or else its last published revision. */
const lastUpdate = (work: ZoneWork) => work.mod?.updatedAt ?? work.updatedAt;

/** What a player checks before installing: where it runs, its loaders and its game versions. */
function Compatibility({ mod, t, limit = 3 }: { mod: ZoneModRelease; t: Strings; limit?: number }) {
  const versions = mod.gameVersions;
  return <ul className="mh-tags" aria-label={t.compatibility}>
    {mod.environment ? <li>{t.environments[mod.environment]}</li> : null}
    {mod.loaders.map(loader => <li key={loader} translate="no">{loader}</li>)}
    {versions.slice(0, limit).map(version => <li key={version} translate="no">{version}</li>)}
    {versions.length > limit ? <li>+{versions.length - limit}</li> : null}
  </ul>;
}

function Byline({ work, t, Link }: { work: ZoneWork; t: Strings; Link: ComponentType<ZoneLinkProps> }) {
  if (!work.author) return null;
  const [before, after] = t.by('⁣').split('⁣');
  return <span lang={work.author.lang || undefined} className="mh-by">{before}
    {work.authorHref ? <Link href={work.authorHref}>{work.author.value}</Link> : work.author.value}{after}</span>;
}

/** A Modrinth-style result row; covers and rails keep the platform's own card. */
export function ModsCard({ zone, work, layout, rank, Link, fallback }: WorkCardSlotProps) {
  if (layout === 'cover') return fallback;
  const t = strings(zone.locale);
  const title = work.title?.value ?? t.untitled;
  const at = lastUpdate(work);
  const when = at ? ago(at, zone.locale) : null;
  return <article className="mh-row" data-layout={layout}>
    {rank ? <span className="mh-rank"><span className="sr-only">{t.rank(rank)}</span>
      <span aria-hidden="true">{rank}</span></span> : null}
    <Link href={work.href} tabIndex={-1} aria-hidden="true" className="mh-icon">
      <WorkCover {...workCoverProps(work)} loading="lazy" /></Link>
    <div className="mh-body">
      <h3 className="mh-title">
        <Link href={work.href} lang={work.title?.lang} dir={work.title?.dir}>{title}</Link>
        {layout === 'row' ? <Byline work={work} t={t} Link={Link} /> : null}
      </h3>
      {work.tagline && layout === 'row' ? <p lang={work.tagline.lang} dir={work.tagline.dir} className="mh-summary">
        {work.tagline.value}</p> : null}
      {work.mod ? <Compatibility mod={work.mod} t={t} limit={layout === 'rail' ? 1 : 3} /> : null}
    </div>
    {when && layout === 'row' ? <p className="mh-updated"><HistoryIcon aria-hidden="true" />
      <time dateTime={at ?? undefined}>{t.updated(when)}</time></p> : null}
  </article>;
}

function SectionHead({ id, title, more, t, Link }: {
  id: string; title: string; more: string | null; t: Strings; Link: ComponentType<ZoneLinkProps>;
}) {
  return <header className="mh-head">
    <h2 id={id}>{title}</h2>
    {more ? <Link href={more} className="mh-more">{t.more}</Link> : null}
  </header>;
}

const rows = (items: readonly ReactNode[]) => <ul className="mh-list">
  {items.map((item, index) => <li key={index}>{item}</li>)}</ul>;

/** Featured picks as result rows in two columns; an art-directed banner keeps the platform hero. */
export function ModsHero({ zone, banners, card, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  if (!picks.length || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  return <section aria-labelledby="mh-featured" className="mh-page mh-section">
    <header className="mh-head"><h2 id="mh-featured">{t.featured}</h2></header>
    <ul className="mh-grid">{picks.map(work => <li key={work.id}>{card(work, { layout: 'row' })}</li>)}</ul>
  </section>;
}

/** Rankings as numbered rows: today, this week and this month. */
export function ModsTrending({ zone, module, data, card, Link }: ModuleSlotProps<'ranking'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `mh-trending-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="ranking" className="zone-module mh-section">
    <SectionHead id={heading} title={module.title} more={module.more} t={t} Link={Link} />
    <Tabs defaultValue={tabs[0]?.interval} className="gap-3">
      <TabsList aria-label={module.title}>
        {tabs.map(tab => <TabsTrigger key={tab.interval} value={tab.interval} className="px-3">
          {t.intervals[tab.interval]}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.interval} value={tab.interval}>
        {rows(tab.items.slice(0, 10).map(item => card(item.work, { layout: 'row', rank: item.rank })))}
      </TabsContent>)}
    </Tabs>
  </section>;
}

/** Shelves as result lists, newest first, one tab per source. */
export function ModsShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `mh-shelf-${module.id}`;
  const list = (items: readonly ZoneWork[]) => rows(items.slice(0, 8).map(work => card(work, { layout: 'row' })));
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module mh-section">
    <SectionHead id={heading} title={module.title} more={module.more} t={t} Link={Link} />
    {tabs.length === 1 ? list(tabs[0]!.items) : <Tabs defaultValue={tabs[0]?.id} className="gap-3">
      <TabsList aria-label={module.title}>
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="px-3">{tab.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>{list(tab.items)}</TabsContent>)}
    </Tabs>}
  </section>;
}

/** Editors' lists as named collections of rows. */
export function ModsCollections({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  const heading = `mh-collections-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="editorial-list" className="zone-module mh-section">
    <SectionHead id={heading} title={module.title} more={null} t={t} Link={Link} />
    {data.lists.map((list, index) => <article key={list.id} aria-labelledby={`${heading}-${index}`}
      className="mh-collection">
      <header className="mh-head">
        <h3 id={`${heading}-${index}`} lang={list.title.lang} dir={list.title.dir}>{list.title.value}
          <span className="mh-count"> · {t.count(list.items.length)}</span></h3>
        {list.href ? <Link href={list.href} className="mh-more">{t.more}</Link> : null}
      </header>
      {rows(list.items.map(work => card(work, { layout: 'row' })))}
    </article>)}
  </section>;
}
