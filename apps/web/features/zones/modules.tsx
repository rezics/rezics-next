import { initials } from '@rezics/ui/avatar-initials';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ZoneBanner, ZoneCardOptions, ZoneDecision, ZoneModule, ZoneModuleData, ZoneModuleType, ZoneWork }
  from '@rezics/zone-sdk';
import { BookOpenIcon, CookingPotIcon, DownloadIcon, MessageCircleIcon, PlusIcon, ScaleIcon, TagIcon, XIcon }
  from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { CopyTextButton } from '../catalogue/copy-button.tsx';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { slotRatio } from '../catalogue/work.ts';
import { CoverLink } from '../catalogue/work-tile.tsx';
import { catalogueWork, WhyHere, workTitle } from './card.tsx';
import { HeroCarousel } from './carousel.tsx';
import { Announcement, ModuleTabs, ShuffleModule } from './islands.tsx';
import type { ZoneMessages } from './messages.ts';
import { ModuleFrame } from './module-frame.tsx';
import { ScrollRow } from './scroll-row.tsx';

/** Renders one Work card; the renderer supplies the package's `workCard` slot when one runs. */
export type CardRenderer = (work: ZoneWork, options?: ZoneCardOptions) => ReactNode;

export interface ModuleProps<Type extends ZoneModuleType> {
  module: ZoneModule<Type>;
  data: ZoneModuleData[Type];
  card: CardRenderer;
  locale: UiLocale;
  messages: ZoneMessages;
  /** The reader's Agent on Main media reads, when signed in. */
  avatarQuery?: string;
}

/**
 * A pick's one action, in its kind's verb: copy a published prompt, install
 * a package or Skill, open a recipe, or start reading anything else.
 */
function PrimaryAction({ work, locale, messages }: { work: ZoneWork; locale: UiLocale; messages: ZoneMessages }) {
  const t = catalogueMessages[locale];
  if (work.hub?.kind === 'prompt') {
    return <CopyTextButton text={work.hub.copyText} label={t.copyPrompt} copied={t.promptCopied} failed={t.copyFailed} />;
  }
  const [Icon, label] = work.hub?.kind === 'skill' || work.mod || work.kind === 'package' ? [DownloadIcon, t.install]
    : work.kind === 'recipe' ? [CookingPotIcon, t.openRecipe] : [BookOpenIcon, messages.read];
  return <LocalizedLink href={work.href} className={buttonVariants({ size: 'sm', pill: true })}>
    <Icon aria-hidden="true" />{label}</LocalizedLink>;
}

function PickSlide({ banner, work, locale, messages, avatarQuery }: {
  banner: ZoneBanner; work: ZoneWork; locale: UiLocale; messages: ZoneMessages; avatarQuery?: string;
}) {
  const title = workTitle(work, messages);
  return <article className="relative isolate flex h-full overflow-hidden rounded-(--zone-radius-card) bg-card
    ring-1 ring-border/50">
    {work.cover ? <img aria-hidden="true" alt="" src={work.cover.url} className="absolute inset-0 -z-20 size-full
      scale-125 object-cover opacity-60 blur-2xl" />
      : <span aria-hidden="true" className="absolute inset-0 -z-20 bg-[radial-gradient(120%_90%_at_0%_0%,var(--zone-accent),transparent_60%)]
        opacity-25" />}
    <span aria-hidden="true" className="absolute inset-0 -z-10 bg-linear-to-r from-card via-card/88 to-card/55" />
    <div className="flex w-full gap-4 p-4 sm:gap-6 sm:p-6">
      <CoverLink work={catalogueWork(work)} avatarQuery={avatarQuery} className="w-26 shrink-0 self-center sm:w-36" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
        <p className="font-semibold text-primary text-xs tracking-wide">{banner.kicker?.value ?? messages.heroLabel}</p>
        <h2 lang={work.title?.lang} dir={work.title?.dir} className="line-clamp-2 text-balance font-semibold
          font-work-title text-xl/tight sm:text-2xl/tight">
          <LocalizedLink href={work.href} className="outline-none hover:text-primary focus-visible:underline">
            {title}</LocalizedLink></h2>
        {work.author ? <p lang={work.author.lang} className="text-muted-foreground text-sm">{work.author.value}</p> : null}
        {work.tagline ? <p lang={work.tagline.lang} className="line-clamp-3 text-pretty text-sm/relaxed">
          {work.tagline.value}</p> : null}
        <div className="mt-auto flex items-center gap-2 pt-2">
          <PrimaryAction work={work} locale={locale} messages={messages} />
          <WhyHere work={work} locale={locale} messages={messages} className="size-8" />
        </div>
      </div>
    </div>
  </article>;
}

function BannerSlide({ banner }: { banner: ZoneBanner }) {
  return <LocalizedLink href={banner.href} className="group relative block aspect-[1.9] h-full w-full overflow-hidden
    rounded-(--zone-radius-card) bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {banner.image ? <img src={banner.image.url} alt="" width={banner.image.width} height={banner.image.height}
      className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]
        motion-reduce:transition-none" /> : null}
    <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 via-black/35 to-transparent px-4 pt-10
      pb-3 sm:px-5">
      {banner.kicker ? <span className="block font-medium text-white/85 text-xs">{banner.kicker.value}</span> : null}
      <span lang={banner.title.lang} className="line-clamp-2 font-semibold text-lg text-white sm:text-xl">
        {banner.title.value}</span>
    </span>
  </LocalizedLink>;
}

export function HeroModule({ module, data, locale, messages, avatarQuery }: ModuleProps<'hero-carousel'>) {
  const t = materializeData(messages, { locale });
  const count = String(data.banners.length);
  return <HeroCarousel label={module.title} previous={messages.previous} next={messages.next}
    slideLabels={data.banners.map((_, index) => t.slide({ index: String(index + 1), count }))}>
    {data.banners.map(banner => banner.image || !banner.work ? <BannerSlide key={banner.id} banner={banner} />
      : <PickSlide key={banner.id} banner={banner} work={banner.work} locale={locale} messages={messages}
        avatarQuery={avatarQuery} />)}
  </HeroCarousel>;
}

export function ChipModule({ module, data }: ModuleProps<'chip-nav'>) {
  return <nav aria-label={module.title} data-zone-module="chip-nav" className="-mx-4 overflow-x-auto px-4
    [scrollbar-width:none] sm:mx-0 sm:px-0">
    <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
      {data.chips.map(chip => <li key={chip.id}>
        <LocalizedLink href={chip.href} lang={chip.label.lang} className="inline-flex h-9 items-center rounded-full
          border border-border/70 bg-(--zone-panel) px-3.5 text-sm outline-none transition-colors hover:border-primary/60
          hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">{chip.label.value}</LocalizedLink>
      </li>)}
    </ul>
  </nav>;
}

export function AnnouncementModule({ module, data, messages }: ModuleProps<'announcement'>) {
  const text = <span lang={data.text.lang}>{data.text.value}</span>;
  return <Announcement label={module.title || messages.announcement} dismiss={messages.dismiss}>
    {data.href ? <LocalizedLink href={data.href} className="hover:text-primary hover:underline">{text}</LocalizedLink>
      : text}
  </Announcement>;
}

function CoverRow({ items, label, messages }: { items: readonly ReactNode[]; label: string; messages: ZoneMessages }) {
  return <ScrollRow label={label} previous={messages.previous} next={messages.next}>{items}</ScrollRow>;
}

function RowGrid({ items }: { items: readonly ReactNode[] }) {
  return <ul className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
    {items.map((item, index) => <li key={index} className="min-w-0">{item}</li>)}
  </ul>;
}

export function ShelfModule({ module, data, card, messages }: ModuleProps<'shelf'>) {
  const rows = module.layout === 'rows' || module.rail;
  const tabs = data.tabs.filter(tab => tab.items.length);
  if (tabs.length === 1 && module.shuffle && !rows) {
    const slot = slotRatio(tabs[0]!.items);
    return <ShuffleModule module={module} more={messages.more} shuffleLabel={messages.shuffle} size={6} render="row"
      previous={messages.previous} next={messages.next}
      items={tabs[0]!.items.map(work => card(work, { slot }))} />;
  }
  return <ModuleFrame module={module} more={messages.more}>
    <ModuleTabs label={module.title} tabs={tabs.map(tab => ({ id: tab.id, label: tab.label,
      content: rows ? <RowGrid items={tab.items.map(work => card(work, { layout: 'row' }))} />
        : <CoverRow label={tab.label} messages={messages}
          items={tab.items.map(work => card(work, { slot: slotRatio(tab.items) }))} /> }))} />
  </ModuleFrame>;
}

export function RankingModule({ module, data, card, locale, messages }: ModuleProps<'ranking'>) {
  const t = materializeData(messages, { locale });
  const compact = module.rail || module.layout === 'rows';
  return <ModuleFrame module={module} more={messages.more}>
    <ModuleTabs label={module.title} tabs={data.tabs.filter(tab => tab.items.length).map(tab => ({
      id: tab.interval, label: t[tab.interval],
      content: compact ? <ol className="grid grid-cols-1 gap-3">
        {tab.items.map(item => <li key={item.work.id}>{card(item.work, { layout: 'row', rank: item.rank })}</li>)}
      </ol> : <CoverRow label={`${module.title} · ${t[tab.interval]}`} messages={messages}
        items={tab.items.map(item => card(item.work, { rank: item.rank,
          slot: slotRatio(tab.items.map(entry => entry.work)) }))} />,
    }))} />
  </ModuleFrame>;
}

export function EditorialModule({ module, data, card, messages }: ModuleProps<'editorial-list'>) {
  return <ModuleFrame module={module} more={messages.more}>
    <div className="grid grid-cols-1 gap-6">
      {data.lists.map((list, index) => <section key={list.id} aria-labelledby={`${module.id}-${list.id}`}
        className={cn('grid grid-cols-1 gap-3', index > 0 && 'border-border/60 border-t pt-5')}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 id={`${module.id}-${list.id}`} lang={list.title.lang} className="font-medium text-base">
              {list.title.value}</h3>
            {list.blurb ? <p lang={list.blurb.lang} className="text-pretty text-muted-foreground text-sm">
              {list.blurb.value}</p> : null}
          </div>
          {list.href ? <LocalizedLink href={list.href} className="shrink-0 font-medium text-primary text-sm
            hover:underline">{messages.more}</LocalizedLink> : null}
        </header>
        <RowGrid items={list.items.map(work => card(work, { layout: 'row' }))} />
      </section>)}
    </div>
  </ModuleFrame>;
}

export function QuoteModule({ module, data, locale, messages }: ModuleProps<'quote-stream'>) {
  const t = materializeData(messages, { locale });
  return <ModuleFrame module={module} more={messages.more}>
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {data.quotes.map(quote => <li key={quote.id} className="flex min-w-0 flex-col gap-2">
        <figure className="flex flex-1 flex-col gap-2">
          <figcaption className="flex items-center gap-2 text-muted-foreground text-xs">
            <span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-accent font-semibold
              text-accent-foreground">{initials(quote.reader)}</span>
            <span className="truncate">{t.quoteBy({ reader: quote.reader })}</span>
          </figcaption>
          <blockquote lang={quote.body.lang} dir={quote.body.dir} className="relative flex-1 rounded-2xl
            rounded-ss-sm bg-muted/70 px-3.5 py-2.5 text-sm/relaxed">
            <p className="line-clamp-4">{quote.body.value}</p></blockquote>
        </figure>
        <LocalizedLink href={quote.href} className="flex items-center justify-between gap-2 rounded-lg px-1 text-sm
          outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
          <span lang={quote.work.title?.lang} className="truncate font-medium">{workTitle(quote.work, messages)}</span>
          <span className="shrink-0 text-primary text-xs">{messages.readWork}</span>
        </LocalizedLink>
      </li>)}
    </ul>
  </ModuleFrame>;
}

export function RisingModule({ module, data, card, messages }: ModuleProps<'rising'>) {
  return <ModuleFrame module={module} more={messages.more}>
    <ol className="grid grid-cols-1 gap-3.5">
      {data.items.map(work => <li key={work.id}>{card(work, { layout: 'rail' })}</li>)}
    </ol>
  </ModuleFrame>;
}

const decisionIcons = { adoption: PlusIcon, classification: TagIcon, 'semantic-rule-change': ScaleIcon } as const;

/** A Decision in words: what the community did, to which Work. */
export function decisionText(decision: ZoneDecision, locale: UiLocale, messages: ZoneMessages): string {
  const t = materializeData(messages, { locale });
  const title = decision.work?.title?.value;
  if (decision.kind === 'semantic-rule-change') return t.ruleChanged;
  if (decision.kind === 'adoption') return title ? t.adopted({ title }) : t.adoptedUnknown;
  if (decision.outcome === 'rejected') {
    return title ? t.classificationRejected({ title }) : t.classificationRejectedUnknown;
  }
  return title ? t.classified({ title }) : t.classifiedUnknown;
}

export function DecisionModule({ module, data, locale, messages }: ModuleProps<'decision-log'>) {
  return <ModuleFrame module={module} more={messages.more}>
    <ol className="grid grid-cols-1 gap-0.5">
      {data.items.map(decision => {
        const Icon = decision.kind === 'classification' && decision.outcome === 'rejected'
          ? XIcon : decisionIcons[decision.kind];
        return <li key={decision.id}>
          <LocalizedLink href={decision.href} className="flex items-start gap-2.5 rounded-lg p-1.5 text-sm outline-none
            hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
            <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent
              text-accent-foreground"><Icon className="size-3" /></span>
            <span className="line-clamp-2 min-w-0">{decisionText(decision, locale, messages)}</span>
          </LocalizedLink>
        </li>;
      })}
    </ol>
  </ModuleFrame>;
}

export function DiscussionModule({ module, data, locale, messages }: ModuleProps<'discussion-list'>) {
  const t = materializeData(messages, { locale });
  return <ModuleFrame module={module} more={messages.more}>
    <ul className="grid grid-cols-1 divide-y divide-border/60">
      {data.items.map(item => <li key={item.id}>
        <LocalizedLink href={item.href} className="flex items-center gap-3 py-2.5 text-sm outline-none hover:text-primary
          focus-visible:ring-2 focus-visible:ring-ring">
          <MessageCircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span lang={item.title.lang} className="line-clamp-1 flex-1 font-medium">{item.title.value}</span>
          {item.replies !== null ? <span className="shrink-0 text-muted-foreground text-xs">
            {t.replies(item.replies)}</span> : null}
        </LocalizedLink>
      </li>)}
    </ul>
  </ModuleFrame>;
}

export function PeopleModule({ module, data, messages }: ModuleProps<'people'>) {
  return <ModuleFrame module={module} more={messages.more}>
    <ul className="grid grid-cols-1 gap-2">
      {data.items.map(person => <li key={person.id}>
        <LocalizedLink href={person.href} className="flex items-center gap-3 rounded-lg p-1.5 outline-none
          hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
          {person.avatar ? <img src={person.avatar.url} alt="" className="size-9 rounded-full object-cover" />
            : <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-accent font-semibold
              text-accent-foreground">{initials(person.name.value)}</span>}
          <span className="min-w-0">
            <span lang={person.name.lang} className="block truncate font-medium text-sm">{person.name.value}</span>
            {person.note ? <span lang={person.note.lang} className="block truncate text-muted-foreground text-xs">
              {person.note.value}</span> : null}
          </span>
        </LocalizedLink>
      </li>)}
    </ul>
  </ModuleFrame>;
}
