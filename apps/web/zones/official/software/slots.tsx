import { WorkCover } from '@rezics/ui/work-cover';
import { type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

/** A cover, its title and its hook. */
export function SoftwareCard({ zone, work, layout, rank, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  return <article className="sz-card" data-layout={layout}>
    <Link href={work.href} tabIndex={-1} aria-hidden="true" className="sz-icon">
      <WorkCover {...workCoverProps(work)} loading="lazy" /></Link>
    <div className="sz-card-copy">
      <h3 lang={work.title?.lang} dir={work.title?.dir}><Link href={work.href}>
        {rank ? `${rank}. ` : null}{work.title?.value ?? t.untitled}</Link></h3>
      {layout !== 'rail' && work.tagline ? <p className="sz-pitch" lang={work.tagline.lang} dir={work.tagline.dir}>
        {work.tagline.value}</p> : null}
    </div>
  </article>;
}

/** The shared showcase retains the platform's media and rotation behavior. */
export function SoftwareHero({ fallback }: HeroSlotProps) {
  return <div className="sz-showcase">{fallback}</div>;
}

export function SoftwareShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  if (!tabs.length) return null;
  return <section className="zone-module sz-module" aria-labelledby={`sz-${module.id}`} data-zone-module="shelf">
    <div className="sz-heading"><h2 id={`sz-${module.id}`} className="sz-section-title">{module.title}</h2>
      {module.more ? <Link href={module.more}>{t.more}</Link> : null}</div>
    {tabs.map(tab => <div key={tab.id}>
      {tabs.length > 1 ? <h3 className="sz-tab-title">{tab.label}</h3> : null}
      <ul className="sz-grid">{tab.items.map(work => <li key={work.id}>{card(work)}</li>)}</ul>
    </div>)}
  </section>;
}

export function SoftwareLists({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  return <section className="zone-module sz-module" aria-labelledby={`sz-${module.id}`} data-zone-module="editorial-list">
    <h2 id={`sz-${module.id}`} className="sz-section-title">{module.title}</h2>
    {data.lists.map(list => <div key={list.id} className="sz-list">
      <div className="sz-heading"><h3 lang={list.title.lang} dir={list.title.dir}>{list.title.value}</h3>
        {list.href ? <Link href={list.href}>{t.more}</Link> : null}</div>
      {list.blurb ? <p lang={list.blurb.lang} dir={list.blurb.dir}>{list.blurb.value}</p> : null}
      <ul className="sz-grid">{list.items.map(work => <li key={work.id}>{card(work)}</li>)}</ul>
    </div>)}
  </section>;
}
