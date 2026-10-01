import type { ModuleSlotProps, WorkCardSlotProps, WorkDetailSlotProps, ZoneSlotProps } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

// Slots of the official Light Novels Zone. They render only what the platform passes in: the platform
// card, the signed-in reader's next volume as Main reports it, and the regions of a series' page.

/** A series card: the platform card, then the reader's next volume (nothing signed out or for a single Work). */
export function LightNovelCard({ layout, fallback, nextVolume }: WorkCardSlotProps) {
  if (layout === 'rail') return fallback;
  return <div className="ln-card">
    {fallback}
    <div className="ln-next">{nextVolume}</div>
  </div>;
}

/** The home shelf: "Continue your series" first when the reader has started one, then the Zone's own shelf. */
export function LightNovelShelf({ zone, module, data, card, nextVolumes, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `ln-shelf-${module.id}`;
  const works = tabs.flatMap(tab => tab.items);
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module ln-shelf">
    {nextVolumes(works, t.continueTitle)}
    <header className="ln-shelf-head">
      <h2 id={heading} className="ln-shelf-title">{module.title}</h2>
      {module.more ? <Link href={module.more} className="ln-more">{t.more}</Link> : null}
    </header>
    {tabs.map(tab => <div key={tab.id} className="ln-shelf-tab">
      {tabs.length > 1 ? <h3 className="ln-shelf-tab-title">{tab.label}</h3> : null}
      <ul className="ln-grid">{tab.items.map(work => <li key={work.id} className="min-w-0">
        {card(work, { layout: 'cover' })}</li>)}</ul>
    </div>)}
  </section>;
}

/** A series' page leads with the reader's place in it and its volumes, then the description and editions. */
export function LightNovelDetail({ zone, regions }: WorkDetailSlotProps) {
  const t = strings(zone.locale);
  return <div className="ln-detail">
    <section aria-labelledby="ln-progress" className="ln-progress">
      <h2 id="ln-progress" className="sr-only">{t.progress}</h2>
      {regions.progress}
    </section>
    <section aria-labelledby="ln-volumes" className="ln-volumes">
      <h2 id="ln-volumes" className="sr-only">{t.volumes}</h2>
      {regions.volumes}
    </section>
    <section aria-labelledby="ln-about" className="ln-about">
      <h2 id="ln-about" className="sr-only">{t.about}</h2>
      {regions.about}
    </section>
    <section aria-labelledby="ln-availability" className="ln-availability">
      <h2 id="ln-availability" className="sr-only">{t.availability}</h2>
      {regions.availability}
    </section>
  </div>;
}

/** What this Zone does not cover, the data's source and the sibling Zone over the same library. */
export function LightNovelFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="ln-footer">
    <div className="ln-footer-grid">
      <section aria-labelledby="ln-coverage">
        <h2 id="ln-coverage" className="ln-footer-title">{t.coverageTitle}</h2>
        <p>{t.coverageBody}</p>
        <p className="ln-source">{t.attribution}</p>
      </section>
      <section aria-labelledby="ln-sibling">
        <h2 id="ln-sibling" className="ln-footer-title">{t.siblingTitle}</h2>
        <p>{t.siblingBody}</p>
        <p><Link href="/r/visual-novels">{t.siblingLink}</Link></p>
      </section>
    </div>
  </footer>;
}
