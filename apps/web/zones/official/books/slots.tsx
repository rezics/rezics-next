import { buttonVariants } from '@rezics/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { WorkCover, workCoverRatio } from '@rezics/ui/work-cover';
import { type HeaderSlotProps, type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps,
  workCoverProps, type ZoneSlotProps, type ZoneWork } from '@rezics/zone-sdk';
import { BookOpenIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { ShelfCarousel } from './carousel.tsx';
import { strings } from './strings.ts';

// Slots of the official Books Zone, a literary magazine. They render only
// data the platform passes in, keep its controls (`actions`) and set every
// pick out through the platform card or beside its "Why here?" stamp.

/** The tallest cover in a row, so titles line up under covers of mixed kinds. */
const slotOf = (works: readonly ZoneWork[]) => Math.min(...works.map(work => workCoverRatio[work.kind]));

function facts(work: ZoneWork, locale: string, includeStatus = true) {
  const t = strings(locale);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return [includeStatus && work.status ? t[work.status] : null,
    work.words === null ? null : t.words(number(work.words)),
    work.chapters === null ? null : t.chapters(number(work.chapters))].filter(Boolean);
}

/** Library cards keep the shared cover and add verified length and serial facts. */
export function BooksWorkCard({ zone, work, layout, rank, fallback, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  // A platform row states the serial facts itself; covers and rail lines do not.
  const details = layout === 'row' ? [] : facts(work, zone.locale, layout !== 'cover' || work.status === 'completed');
  return <div className="bz-work-card" data-layout={layout} data-ranked={rank ? '' : undefined}>
    {fallback}
    {details.length ? <p className="bz-facts">{details.join(' · ')}</p> : null}
    {(layout === 'cover' || !work.latestChapter?.title) && work.latestChapter ? <p className="bz-latest">
      {work.latestChapter.title ? `${t.latestChapter}: ` : null}<Link href={work.latestChapter.href}
        lang={work.latestChapter.title?.lang}>
        {work.latestChapter.title?.value ?? t.latestChapter}</Link></p> : null}
  </div>;
}

/** The nameplate: the Zone's name set large between rules, under a dateline with the platform controls. */
export function BooksHeader({ zone, actions, members }: HeaderSlotProps) {
  const t = strings(zone.locale);
  return <header className="bz-nameplate">
    <div className="bz-page">
      <div className="bz-dateline">
        <p className="bz-kicker">{t.official}{members ? <span className="bz-members">{members}</span> : null}</p>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      <h1 lang={zone.name.lang} dir={zone.name.dir} className="bz-wordmark">{zone.name.value}</h1>
      <p lang={zone.description?.lang} className="bz-motto">{zone.description?.value ?? t.tagline}</p>
    </div>
  </header>;
}

/**
 * The cover story: the newest pick set large with its hook as the standfirst,
 * and the rest of the picks as the issue's contents. Art-directed banners
 * keep the platform carousel.
 */
export function BooksHero({ zone, banners, card, whyHere, Link, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  const [lead, ...rest] = picks;
  if (!lead || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  return <section aria-labelledby="bz-cover-story" className="bz-issue">
    <div className="bz-page bz-issue-grid">
      <article className="bz-lead">
        <Link href={lead.href} tabIndex={-1} aria-hidden="true" className="bz-lead-cover">
          <WorkCover {...workCoverProps(lead)} loading="eager" /></Link>
        <div className="bz-lead-copy">
          <h2 id="bz-cover-story" className="bz-kicker">{t.coverStory}</h2>
          <h3 lang={lead.title?.lang} dir={lead.title?.dir} className="bz-lead-title">
            <Link href={lead.href}>{lead.title?.value ?? t.untitled}</Link></h3>
          {lead.author ? <p lang={lead.author.lang || undefined} className="bz-byline">
            {t.byline('\u2063').split('\u2063')[0]}
            {lead.authorHref ? <Link href={lead.authorHref} className="rounded-sm outline-none hover:underline
              focus-visible:ring-2 focus-visible:ring-ring">{lead.author.value}</Link> : lead.author.value}
            {t.byline('\u2063').split('\u2063')[1]}</p> : null}
          {lead.tagline ? <p lang={lead.tagline.lang} dir={lead.tagline.dir} className="bz-dek">
            {lead.tagline.value}</p> : null}
          {facts(lead, zone.locale).length ? <p className="bz-facts">{facts(lead, zone.locale).join(' · ')}</p> : null}
          <div className="bz-lead-actions">
            <Link href={lead.href} className={buttonVariants({ size: 'md', pill: true })}>
              <BookOpenIcon aria-hidden="true" />{t.startReading}</Link>
            <span className="bz-stamp">{whyHere(lead)}</span>
          </div>
        </div>
      </article>
      {rest.length ? <section aria-labelledby="bz-contents" className="bz-contents">
        <h2 id="bz-contents" className="bz-contents-title">{t.inThisIssue}</h2>
        <ol className="bz-contents-list">
          {rest.map(work => <li key={work.id}>{card(work, { layout: 'rail' })}</li>)}
        </ol>
      </section> : null}
    </div>
  </section>;
}

/** Shelves as "Readers also enjoyed" rows: covers first, page marks and a turning button. */
export function BooksShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `bz-shelf-${module.id}`;
  const title = <h2 id={heading} className="bz-section-title">{module.title}</h2>;
  const more = module.more ? <Link href={module.more} className="bz-more">{t.more}</Link> : null;
  const row = (tab: (typeof tabs)[number], head?: ReactNode) =>
    <ShelfCarousel label={tab.label} previous={t.previous} next={t.next} head={head}>
      {tab.items.map(work => <Fragment key={work.id}>{card(work, { slot: slotOf(tab.items) })}</Fragment>)}
    </ShelfCarousel>;
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module bz-shelf">
    {tabs.length === 1 ? row(tabs[0]!, <div className="bz-shelf-title">{title}{more}</div>)
      : <Tabs defaultValue={tabs[0]?.id} className="gap-0">
        <header className="bz-shelf-title">
          {title}
          <TabsList variant="underline" aria-label={module.title} className="bz-tabs">
            {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="grow-0 px-3">{tab.label}</TabsTrigger>)}
          </TabsList>
          {more}
        </header>
        {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>{row(tab)}</TabsContent>)}
      </Tabs>}
  </section>;
}

/** Curated lists lead with covers and preserve each Work's Decision stamp. */
export function BooksColumns({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  const heading = `bz-columns-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="editorial-list" className="zone-module bz-columns">
    <header className="bz-section-head">
      <p className="bz-kicker">{t.column}</p>
      <h2 id={heading} className="bz-section-title">{module.title}</h2>
    </header>
    {data.lists.map((list, index) => <article key={list.id} aria-labelledby={`${heading}-${index}`}
      className="bz-column">
      <h3 id={`${heading}-${index}`} lang={list.title.lang} dir={list.title.dir} className="bz-column-title">
        {list.title.value}</h3>
      {list.blurb ? <p lang={list.blurb.lang} className="bz-standfirst">{list.blurb.value}</p> : null}
      <ol className="bz-column-list">
        {list.items.map(work => <li key={work.id}>{card(work)}</li>)}
      </ol>
      {list.href ? <Link href={list.href} className="bz-more">{t.more}</Link> : null}
    </article>)}
  </section>;
}

/** Period tabs rank by the named Main signal, with facts visible in every row. */
export function BooksRanking({ zone, module, data, card, Link }: ModuleSlotProps<'ranking'>) {
  const t = strings(zone.locale);
  const heading = `bz-ranking-${module.id}`;
  const tabs = data.tabs.filter(tab => tab.items.length);
  return <section aria-labelledby={heading} data-zone-module="ranking" className="zone-module bz-ranking">
    <header className="bz-shelf-title">
      <h2 id={heading} className="bz-section-title">{module.title}</h2>
      {module.more ? <Link href={module.more} className="bz-more">{t.more}</Link> : null}
    </header>
    <p className="bz-facts">{data.metric === 'reads' ? t.reads : t.finishedChapters}</p>
    <Tabs defaultValue={tabs[0]?.interval} className="gap-4">
      <TabsList variant="underline" aria-label={module.title} className="justify-start">
        {tabs.map(tab => <TabsTrigger key={tab.interval} value={tab.interval} className="grow-0 px-3">
          {t[tab.interval]}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.interval} value={tab.interval}>
        <ol className="bz-ranking-list">{tab.items.map(item => <li key={item.work.id}>
          {card(item.work, { layout: 'row', rank: item.rank })}</li>)}</ol>
      </TabsContent>)}
    </Tabs>
  </section>;
}

const initial = (name: string) => [...name.trim()][0] ?? '·';

/** People to follow as an author spotlight: one portrait set large, then the others. */
export function BooksSpotlight({ zone, module, data, Link, fallback }: ModuleSlotProps<'people'>) {
  const [first, ...others] = data.items;
  if (!first) return fallback;
  const t = strings(zone.locale);
  const heading = `bz-spotlight-${module.id}`;
  const portrait = (person: typeof first, className: string) => person.avatar
    ? <img src={person.avatar.url} alt="" width={person.avatar.width} height={person.avatar.height}
      className={className} />
    : <span aria-hidden="true" className={`${className} bz-monogram`}>{initial(person.name.value)}</span>;
  return <section aria-labelledby={heading} data-zone-module="people" className="zone-module bz-spotlight">
    <header className="bz-section-head">
      <p className="bz-kicker">{t.spotlight}</p>
      <h2 id={heading} className="bz-section-title">{module.title}</h2>
    </header>
    <article className="bz-spotlight-lead">
      {portrait(first, 'bz-portrait')}
      <div className="min-w-0">
        <h3 lang={first.name.lang} dir={first.name.dir} className="bz-column-title">{first.name.value}</h3>
        {first.note ? <p lang={first.note.lang} className="bz-standfirst">{first.note.value}</p> : null}
        <Link href={first.href} className="bz-more">{t.readTheirBooks}</Link>
      </div>
    </article>
    {others.length ? <ul className="bz-spotlight-more">
      {others.map(person => <li key={person.id}>
        <Link href={person.href} className="bz-person">{portrait(person, 'bz-portrait-small')}
          <span lang={person.name.lang} className="truncate">{person.name.value}</span></Link>
      </li>)}
    </ul> : null}
  </section>;
}

/** The colophon: what this Zone is and where its decisions are kept. */
export function BooksFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="bz-colophon">
    <div className="bz-page bz-colophon-grid">
      <p className="bz-kicker">{t.colophon}</p>
      <p className="bz-colophon-note">{t.footerNote}</p>
      <nav aria-label={t.colophon}>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <li><Link href={zone.links.works}>{t.works}</Link></li>
          <li><Link href={zone.links.decisions}>{t.decisions}</Link></li>
          <li><Link href={zone.links.about}>{t.about}</Link></li>
        </ul>
      </nav>
    </div>
  </footer>;
}
