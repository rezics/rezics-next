import { WorkCover } from '@rezics/ui/work-cover';
import { type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps }
  from '@rezics/zone-sdk';
import { strings } from './strings.ts';

/** A cover, its title and its hook. */
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
          <div className="gz-featured-actions">
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
