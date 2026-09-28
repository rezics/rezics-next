import { WorkCover } from '@rezics/ui/work-cover';
import { type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps,
  type ZoneGameFacts, type ZoneLinkProps, type ZoneWork } from '@rezics/zone-sdk';
import { ArrowUpRightIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { strings } from './strings.ts';

function Review({ game, locale }: { game: ZoneGameFacts | null | undefined; locale: string }) {
  const t = strings(locale);
  if (!game?.review) return <span className="gz-unknown">{t.reviewsUnknown}</span>;
  return <span className="gz-review">{game.review.label} · {new Intl.NumberFormat(locale).format(game.review.count)}
    {' '}{t.reviews} ({game.review.period})</span>;
}

function Details({ work, locale, Link, officialLink = true }: { work: ZoneWork; locale: string;
  Link: ComponentType<ZoneLinkProps>; officialLink?: boolean }) {
  const game = work.game;
  if (!game) return <p className="gz-meta"><Review game={null} locale={locale} /></p>;
  const t = strings(locale);
  return <div className="gz-details">
    <p className="gz-meta"><span>{t[game.status]}</span><Review game={game} locale={locale} /></p>
    {game.tags.length ? <ul className="gz-tags" aria-label={t.tags}>
      {game.tags.slice(0, 3).map(tag => <li key={tag}>{tag}</li>)}</ul> : null}
    {game.platforms.length ? <p className="gz-platforms">{t.platforms}: {game.platforms.join(', ')}</p> : null}
    {game.languages.length ? <p className="gz-platforms">{t.languages}: {game.languages.join(', ')}</p> : null}
    {officialLink ? <Link href={game.source} target="_blank" rel="noopener noreferrer" className="gz-official">
      {t.officialPage}<ArrowUpRightIcon aria-hidden="true" /></Link> : null}
    {game.modsZone ? <Link href="/r/mods" className="gz-mods">{t.mods}</Link> : null}
  </div>;
}

/** Covers lead; review population appears only when Main supplied it. */
export function GamesCard({ zone, work, layout, rank, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  return <article className="gz-card" data-layout={layout}>
    {rank ? <span className="gz-rank">{rank}</span> : null}
    <Link href={work.href} tabIndex={-1} aria-hidden="true" className="gz-cover">
      <WorkCover {...workCoverProps(work)} loading="lazy" /></Link>
    <div className="gz-card-copy">
      <h3 lang={work.title?.lang} dir={work.title?.dir}><Link href={work.href}>
        {work.title?.value ?? t.untitled}</Link></h3>
      {layout !== 'rail' && work.tagline ? <p className="gz-pitch" lang={work.tagline.lang} dir={work.tagline.dir}>
        {work.tagline.value}</p> : null}
      {layout !== 'rail' ? <Details work={work} locale={zone.locale} Link={Link} /> : null}
    </div>
  </article>;
}

/** A lead capsule followed by a horizontally browsable rail of other picks. */
export function GamesHero({ zone, banners, card, whyHere, Link, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  const [lead, ...others] = picks;
  if (!lead || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  return <section className="gz-hero" aria-labelledby="gz-featured">
    <div className="gz-page">
      <h2 id="gz-featured" className="gz-section-title">{t.featured}</h2>
      <div className="gz-featured">
        <Link href={lead.href} tabIndex={-1} aria-hidden="true" className="gz-featured-art">
          <WorkCover {...workCoverProps(lead)} loading="eager" /></Link>
        <div className="gz-featured-copy">
          <h3 lang={lead.title?.lang} dir={lead.title?.dir}>
            <Link href={lead.href}>{lead.title?.value ?? t.untitled}</Link></h3>
          {lead.tagline ? <p lang={lead.tagline.lang} dir={lead.tagline.dir}>{lead.tagline.value}</p> : null}
          <Details work={lead} locale={zone.locale} Link={Link} officialLink={false} />
          <div className="gz-featured-actions">
            {lead.game ? <Link href={lead.game.source} target="_blank" rel="noopener noreferrer" className="gz-action">
              {t.officialPage}<ArrowUpRightIcon aria-hidden="true" /></Link> : null}
            <Link href={lead.href}>{t.details}</Link>{whyHere(lead)}</div>
        </div>
      </div>
      {others.length ? <ul className="gz-featured-rail">{others.map(work =>
        <li key={work.id}>{card(work, { layout: 'cover' })}</li>)}</ul> : null}
    </div>
  </section>;
}

export function GamesShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  if (!tabs.length) return null;
  return <section className="zone-module gz-module" aria-labelledby={`gz-${module.id}`} data-zone-module="shelf">
    <header className="gz-heading"><h2 id={`gz-${module.id}`} className="gz-section-title">{module.title}</h2>
      {module.more ? <Link href={module.more}>{t.more}</Link> : null}</header>
    {tabs.map(tab => <div key={tab.id}>
      {tabs.length > 1 ? <h3 className="gz-tab-title">{tab.label}</h3> : null}
      <ul className="gz-shelf">{tab.items.map(work => <li key={work.id}>{card(work)}</li>)}</ul>
    </div>)}
  </section>;
}

export function GamesLists({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  return <section className="zone-module gz-module" aria-labelledby={`gz-${module.id}`} data-zone-module="editorial-list">
    <h2 id={`gz-${module.id}`} className="gz-section-title">{module.title}</h2>
    {data.lists.map(list => <div key={list.id} className="gz-list">
      <div className="gz-heading"><h3 lang={list.title.lang} dir={list.title.dir}>{list.title.value}</h3>
        {list.href ? <Link href={list.href}>{t.more}</Link> : null}</div>
      {list.blurb ? <p lang={list.blurb.lang} dir={list.blurb.dir}>{list.blurb.value}</p> : null}
      <ul className="gz-shelf">{list.items.map(work => <li key={work.id}>{card(work)}</li>)}</ul>
    </div>)}
  </section>;
}
