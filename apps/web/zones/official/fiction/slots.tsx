import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { WorkCover } from '@rezics/ui/work-cover';
import { type HeaderSlotProps, type HeroSlotProps, type ModuleSlotProps,
  type WorkCardSlotProps, workCoverProps, type ZoneSlotProps, type ZoneWork } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

// Slots render only platform data and retain controls and each public Decision stamp.

/** The shared Zone header puts the publication's name ahead of its lists. */
export function FictionHeader({ zone, actions, members }: HeaderSlotProps) {
  const t = strings(zone.locale);
  return <header className="fz-masthead">
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-4 px-4 py-7 sm:px-6 sm:py-9
      lg:px-10">
      <div className="min-w-0 flex-1 basis-64">
        <p className="fz-kicker">{t.official}</p>
        <h1 lang={zone.name.lang} className="fz-wordmark">{zone.name.value}</h1>
        <p className="fz-tagline">{zone.description?.value ?? t.tagline}</p>
        {members ? <p className="fz-members">{members}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  </header>;
}

/** The shared showcase retains the platform's media and rotation behavior. */
export function FictionHero({ fallback }: HeroSlotProps) {
  return <div className="fz-hero">{fallback}</div>;
}

function facts(work: ZoneWork, locale: string, includeStatus = true) {
  const t = strings(locale);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return [includeStatus && work.status ? t[work.status] : null,
    work.words === null ? null : t.words(number(work.words)),
    work.chapters === null ? null : t.chapters(number(work.chapters))].filter(Boolean);
}

/** The shared cover or row remains the card; these are the serial facts it does not show (a row states its own). */
export function FictionWorkCard({ zone, work, layout, rank, fallback, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  const details = layout === 'row' ? [] : facts(work, zone.locale, layout !== 'cover' || work.status === 'completed');
  return <div className="fz-work-card" data-layout={layout} data-ranked={rank ? '' : undefined}>
    {fallback}
    {details.length ? <p className="fz-facts">{details.join(' · ')}</p> : null}
    {(layout === 'cover' || !work.latestChapter?.title) && work.latestChapter ? <p className="fz-latest">
      {work.latestChapter.title ? <span>{t.latestChapter}: </span> : null}
      <Link href={work.latestChapter.href} lang={work.latestChapter.title?.lang}>
        {work.latestChapter.title?.value ?? t.latestChapter}</Link>
      {work.latestChapter.at ? <time dateTime={work.latestChapter.at}>
        {new Intl.DateTimeFormat(zone.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
          .format(new Date(work.latestChapter.at))} UTC</time> : null}
    </p> : null}
  </div>;
}

/** Chapter updates lead with the chapter and its timestamp, then the story. */
export function FictionShelf({ zone, module, data, card, Link, whyHere, fallback }: ModuleSlotProps<'shelf'>) {
  if (module.id !== 'latest') return fallback;
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `fz-shelf-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module fz-shelf">
    <header className="fz-module-head">
      <h2 id={heading} className="fz-module-title">{module.title}</h2>
      {module.more ? <Link href={module.more} className="fz-more">{t.moreWorks}</Link> : null}
    </header>
    <Tabs defaultValue={tabs[0]?.id} className="gap-4">
      <TabsList variant="underline" aria-label={module.title} className="justify-start">
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="grow-0 px-3">{tab.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>
        {tab.id === 'chapters' ? <ol className="fz-updates">
          {tab.items.map(work => <li key={work.id} className="fz-update">
            <Link href={work.href} tabIndex={-1} aria-hidden="true" className="fz-update-cover">
              <WorkCover {...workCoverProps(work)} loading="lazy" /></Link>
            <div className="fz-update-copy">
              {work.latestChapter ? <p className="fz-update-chapter">
                <Link href={work.latestChapter.href} lang={work.latestChapter.title?.lang}>
                  {work.latestChapter.title?.value ?? t.latestChapter}</Link></p> : null}
              <h3 lang={work.title?.lang} dir={work.title?.dir} className="fz-update-title">
                <Link href={work.href}>{work.title?.value ?? ''}</Link></h3>
              {work.author ? <p lang={work.author.lang} className="fz-update-author">{work.author.value}</p> : null}
              {facts(work, zone.locale).length ? <p className="fz-facts">{facts(work, zone.locale).join(' · ')}</p> : null}
            </div>
            <div className="fz-update-side">
              {work.latestChapter?.at ? <time dateTime={work.latestChapter.at}>
                {new Intl.DateTimeFormat(zone.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
                  .format(new Date(work.latestChapter.at))} UTC</time> : null}
              {whyHere(work)}
            </div>
          </li>)}
        </ol> : <ul className="fz-arrivals">{tab.items.map(work => <li key={work.id}>{card(work)}</li>)}</ul>}
      </TabsContent>)}
    </Tabs>
  </section>;
}

/** Each ranking row exposes the measured signal and comparable serial facts. */
export function FictionRanking({ zone, module, data, card, Link }: ModuleSlotProps<'ranking'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `fz-ranking-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="ranking" className="zone-module fz-ranking">
    <header className="mb-2 flex items-center justify-between gap-3">
      <h2 id={heading} className="fz-module-title">{module.title}</h2>
      {module.more ? <Link href={module.more} className="fz-more">{t.more}</Link> : null}
    </header>
    <p className="fz-ranking-measure">{data.metric === 'reads' ? t.reads : t.finishedChapters}</p>
    <Tabs defaultValue={tabs[0]?.interval} className="gap-4">
      <TabsList variant="underline" aria-label={module.title} className="justify-start">
        {tabs.map(tab => <TabsTrigger key={tab.interval} value={tab.interval} className="grow-0 px-4">
          {t[tab.interval]}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.interval} value={tab.interval} className="grid grid-cols-1 gap-5">
        <ol aria-label={t.podium} className="fz-podium">
          {tab.items.slice(0, 3).map(item => <li key={item.work.id} data-rank={item.rank} className="fz-podium-place">
            {card(item.work, { layout: 'row', rank: item.rank })}</li>)}
        </ol>
        {tab.items.length > 3 ? <ol start={4} className="fz-chart">
          {tab.items.slice(3, 10).map(item => <li key={item.work.id}>
            {card(item.work, { layout: 'row', rank: item.rank })}</li>)}
        </ol> : null}
      </TabsContent>)}
    </Tabs>
  </section>;
}

/** A closing band on dark slate: what this Zone is, and where its decisions are. */
export function FictionFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="fz-footer">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-9 sm:flex-row sm:items-center sm:px-6 lg:px-10">
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
