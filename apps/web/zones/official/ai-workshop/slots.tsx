import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { WorkCover } from '@rezics/ui/work-cover';
import { type HeaderSlotProps, type HeroSlotProps, type ModuleSlotProps, type WorkCardSlotProps, workCoverProps,
  type ZoneHubItem, type ZoneLinkProps, type ZoneSlotProps, type ZoneWork } from '@rezics/zone-sdk';
import { ArrowRightIcon, CornerDownLeftIcon, FolderOpenIcon, SparklesIcon, SquareTerminalIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { CopyButton } from './copy-button.tsx';
import { strings } from './strings.ts';

// Slots of the official AI Workshop Zone, a gallery of prompts and skills.
// Every card leads with copying the pick and trying it; the platform keeps
// each card's "Why here?" stamp in the card's top corner, which these cards
// leave free.

type Strings = ReturnType<typeof strings>;

function Thumb({ work, Link }: { work: ZoneWork; Link: ComponentType<ZoneLinkProps> }) {
  return <Link href={work.href} tabIndex={-1} aria-hidden="true" className="aw-thumb">
    <WorkCover {...workCoverProps(work)} /></Link>;
}

/**
 * Copy first, then try: the two things a reader does with a prompt. A
 * published prompt or Skill copies its own text; any other pick its address.
 */
function Actions({ work, title, t, Link, compact }: {
  work: ZoneWork; title: string; t: Strings; Link: ComponentType<ZoneLinkProps>; compact?: boolean;
}) {
  const { hub } = work;
  const words = t.copy[hub?.kind ?? 'link'];
  return <div className="aw-actions">
    <CopyButton text={hub?.copyText ?? null} href={work.href} title={title} label={words.label}
      copied={words.copied} failed={words.failed} compact={compact} />
    <Link href={work.href} className="aw-try" data-compact={compact ? '' : undefined}>
      <span className={compact ? 'sr-only' : undefined}>{t.tryIt}</span><span className="sr-only"> {title}</span>
      <ArrowRightIcon aria-hidden="true" /></Link>
  </div>;
}

/** The kind of pick and who made it: "Prompt · by Aria". */
function Byline({ work, t }: { work: ZoneWork; t: Strings }) {
  if (!work.hub && !work.author) return null;
  return <p className="aw-by">
    {work.hub ? <span className="aw-kind">{t.kind[work.hub.kind]}</span> : null}
    {work.hub && work.author ? ' · ' : null}
    {work.author ? <span lang={work.author.lang || undefined}>{t.by(work.author.value)}</span> : null}
  </p>;
}

/**
 * What the author disclosed of the prompt or Skill, as it will be copied,
 * and the models they tested it with. A prompt's excerpt that stops short
 * of its text ends with an ellipsis.
 */
function Disclosed({ hub, t }: { hub: ZoneHubItem; t: Strings }) {
  const cut = hub.kind === 'prompt' && hub.copyText.length > hub.preview.value.length;
  return <>
    <p lang={hub.preview.lang || undefined} dir={hub.preview.dir} translate="no" className="aw-preview">
      <span className="aw-preview-text"><span className="sr-only">{t.preview}: </span>{hub.preview.value}
        {cut ? '…' : null}</span></p>
    {hub.testedModels.length ? <div className="aw-models">
      <span>{t.testedWith}</span>
      <ul aria-label={t.testedWith}>{hub.testedModels.map(model => <li key={model} translate="no">{model}</li>)}</ul>
    </div> : null}
  </>;
}

/** A copy-first card: a gallery card in grids, a row in lists and a one-line entry in the rail. */
export function WorkshopCard({ zone, work, layout, Link }: WorkCardSlotProps) {
  const t = strings(zone.locale);
  const title = work.title?.value ?? t.untitled;
  const full = layout !== 'rail';
  return <article className="aw-card" data-layout={layout}>
    <div className="aw-card-head">
      <Thumb work={work} Link={Link} />
      <div className="min-w-0">
        <h3 lang={work.title?.lang} dir={work.title?.dir} className="aw-card-title">
          <Link href={work.href}>{title}</Link></h3>
        <Byline work={work} t={t} />
      </div>
    </div>
    {full && (work.tagline || work.hub) ? <div className="aw-card-text">
      {work.tagline ? <p lang={work.tagline.lang} dir={work.tagline.dir} className="aw-hook">
        {work.tagline.value}</p> : null}
      {work.hub ? <Disclosed hub={work.hub} t={t} /> : null}
    </div> : null}
    <Actions work={work} title={title} t={t} Link={Link} compact={layout !== 'cover'} />
  </article>;
}

/** The workshop's masthead on a dot grid, with a way into everything it holds. */
export function WorkshopHeader({ zone, actions, members, Link }: HeaderSlotProps) {
  const t = strings(zone.locale);
  return <header className="aw-masthead">
    <div className="aw-page aw-masthead-inner">
      <div className="aw-masthead-copy">
        <p className="aw-eyebrow">{t.official}</p>
        <h1 lang={zone.name.lang} dir={zone.name.dir} className="aw-wordmark">
          <span aria-hidden="true" className="aw-caret">›_</span>{zone.name.value}</h1>
        <p lang={zone.description?.lang} className="aw-tagline">{zone.description?.value ?? t.tagline}</p>
        <Link href={zone.links.works} className="aw-command">
          <SquareTerminalIcon aria-hidden="true" /><span>{t.browse}</span>
          <CornerDownLeftIcon aria-hidden="true" className="aw-enter" /></Link>
      </div>
      <div className="aw-masthead-side">
        {members ? <p className="aw-members">{members}</p> : null}
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  </header>;
}

/** The featured pick as a large card with its actions, and the other picks stacked beside it. */
export function WorkshopHero({ zone, banners, card, whyHere, Link, fallback }: HeroSlotProps) {
  const picks = banners.flatMap(banner => banner.work && !banner.image ? [banner.work] : []);
  const [lead, ...rest] = picks;
  if (!lead || picks.length !== banners.length) return fallback;
  const t = strings(zone.locale);
  const title = lead.title?.value ?? t.untitled;
  return <section aria-labelledby="aw-featured" className="aw-featured">
    <div className="aw-page">
      <h2 id="aw-featured" className="aw-eyebrow aw-featured-title"><SparklesIcon aria-hidden="true" />{t.featured}</h2>
      <div className="aw-featured-grid">
        <article className="aw-spotlight">
          <div className="aw-card-head">
            <Thumb work={lead} Link={Link} />
            <div className="min-w-0">
              <h3 lang={lead.title?.lang} dir={lead.title?.dir} className="aw-spotlight-title">
                <Link href={lead.href}>{title}</Link></h3>
              <Byline work={lead} t={t} />
            </div>
          </div>
          {lead.tagline ? <p lang={lead.tagline.lang} dir={lead.tagline.dir} className="aw-spotlight-hook">
            {lead.tagline.value}</p> : null}
          {lead.hub ? <Disclosed hub={lead.hub} t={t} /> : null}
          <div className="aw-spotlight-foot">
            <Actions work={lead} title={title} t={t} Link={Link} />
            <span className="aw-stamp">{whyHere(lead)}</span>
          </div>
        </article>
        {rest.length ? <ol className="aw-stack">
          {rest.map(work => <li key={work.id}>{card(work, { layout: 'row' })}</li>)}
        </ol> : null}
      </div>
    </div>
  </section>;
}

function SectionHead({ id, title, more, t, Link }: {
  id: string; title: string; more: string | null; t: Strings; Link: ComponentType<ZoneLinkProps>;
}) {
  return <header className="aw-section-head">
    <h2 id={id} className="aw-section-title">{title}</h2>
    {more ? <Link href={more} className="aw-more">{t.more}</Link> : null}
  </header>;
}

/** Shelves as a gallery: every pick a card you can copy or try at once. */
export function WorkshopShelf({ zone, module, data, card, Link }: ModuleSlotProps<'shelf'>) {
  const t = strings(zone.locale);
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `aw-shelf-${module.id}`;
  const grid = (items: readonly ZoneWork[]) => <ul className="aw-grid">
    {items.map(work => <li key={work.id}>{card(work, { layout: 'cover' })}</li>)}</ul>;
  return <section aria-labelledby={heading} data-zone-module="shelf" className="zone-module aw-section">
    <SectionHead id={heading} title={module.title} more={module.more} t={t} Link={Link} />
    {tabs.length === 1 ? grid(tabs[0]!.items) : <Tabs defaultValue={tabs[0]?.id} className="gap-3">
      <TabsList aria-label={module.title}>
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="px-3">{tab.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>{grid(tab.items)}</TabsContent>)}
    </Tabs>}
  </section>;
}

/** Editors' lists as collections by task, each a folder of picks. */
export function WorkshopCollections({ zone, module, data, card, Link }: ModuleSlotProps<'editorial-list'>) {
  const t = strings(zone.locale);
  const heading = `aw-collections-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="editorial-list" className="zone-module aw-section">
    <SectionHead id={heading} title={module.title} more={null} t={t} Link={Link} />
    <div className="aw-collections">
      {data.lists.map((list, index) => <article key={list.id} aria-labelledby={`${heading}-${index}`}
        className="aw-collection">
        <header className="aw-collection-head">
          <span aria-hidden="true" className="aw-folder"><FolderOpenIcon /></span>
          <div className="min-w-0 flex-1">
            <p className="aw-count">{t.collection} · {t.count(list.items.length)}</p>
            <h3 id={`${heading}-${index}`} lang={list.title.lang} dir={list.title.dir} className="aw-collection-title">
              {list.title.value}</h3>
            {list.blurb ? <p lang={list.blurb.lang} className="aw-hook">{list.blurb.value}</p> : null}
          </div>
          {list.href ? <Link href={list.href} className="aw-more">{t.more}</Link> : null}
        </header>
        <ul className="aw-rows">
          {list.items.map(work => <li key={work.id}>{card(work, { layout: 'row' })}</li>)}
        </ul>
      </article>)}
    </div>
  </section>;
}

/** A closing band: what the workshop is and where its decisions are. */
export function WorkshopFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="aw-footer">
    <div className="aw-page aw-footer-inner">
      <span aria-hidden="true" className="aw-caret aw-caret-large">›_</span>
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
