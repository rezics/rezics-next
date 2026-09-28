import { WorkCover } from '@rezics/ui/work-cover';
import { type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps,
  type ZoneSoftwareFacts, type ZoneWork } from '@rezics/zone-sdk';
import { ArrowUpRightIcon, CodeXmlIcon } from 'lucide-react';
import { strings } from './strings.ts';

function AppFacts({ software, locale }: { software: ZoneSoftwareFacts | null | undefined; locale: string }) {
  const t = strings(locale);
  if (!software) return <p className="sz-unknown">{t.versionUnknown}</p>;
  const platforms = [...new Set(software.releases.map(release => release.platform))];
  const versions = [...new Set(software.releases.map(release => release.version).filter(Boolean))];
  return <div className="sz-facts">
    {platforms.length ? <p>{t.platforms}: {platforms.join(' · ')}</p> : null}
    <p>{software.license ?? t.licenseUnknown} · {versions.length === 1 ? versions[0] : t.versionUnknown}</p>
  </div>;
}

/** Compact app card: enough provenance to decide whether to inspect it. */
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
      {layout !== 'rail' ? <AppFacts software={work.software} locale={zone.locale} /> : null}
      {layout !== 'rail' && work.software ? <div className="sz-links">
        <a href={work.software.project} target="_blank" rel="noopener noreferrer">
          {t.project}<ArrowUpRightIcon aria-hidden="true" /></a>
        <a href={work.software.source} target="_blank" rel="noopener noreferrer">
          <CodeXmlIcon aria-hidden="true" />{t.source}</a>
      </div> : null}
    </div>
  </article>;
}

function Lead({ work, locale, Link, whyHere }: {
  work: ZoneWork; locale: string; Link: HeroSlotProps['Link']; whyHere: HeroSlotProps['whyHere'];
}) {
  const t = strings(locale);
  return <div className="sz-lead">
    <Link href={work.href} tabIndex={-1} aria-hidden="true" className="sz-lead-icon">
      <WorkCover {...workCoverProps(work)} loading="eager" /></Link>
    <div className="sz-lead-copy">
      <h3 lang={work.title?.lang} dir={work.title?.dir}><Link href={work.href}>
        {work.title?.value ?? t.untitled}</Link></h3>
      {work.tagline ? <p lang={work.tagline.lang} dir={work.tagline.dir}>{work.tagline.value}</p> : null}
      <AppFacts software={work.software} locale={locale} />
      <div className="sz-lead-actions">
        {work.software ? <a href={work.software.project} target="_blank" rel="noopener noreferrer"
          className="sz-project">{t.project}<ArrowUpRightIcon aria-hidden="true" /></a> : null}
        {whyHere(work)}
      </div>
    </div>
  </div>;
}

export function SoftwareHero({ zone, banners, card, whyHere, Link, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  const [lead, ...others] = picks;
  if (!lead || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  return <section className="sz-hero" aria-labelledby="sz-featured"><div className="sz-page">
    <h2 id="sz-featured" className="sz-section-title">{t.featured}</h2>
    <div className="sz-hero-grid"><Lead work={lead} locale={zone.locale} Link={Link} whyHere={whyHere} />
      {others.length ? <ul className="sz-hero-others">{others.map(work =>
        <li key={work.id}>{card(work, { layout: 'row' })}</li>)}</ul> : null}</div>
  </div></section>;
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
