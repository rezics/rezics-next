import type { ComponentType } from 'react';
import type { ModuleSlotProps, ZoneBrowseEntry, ZoneCardOptions, ZoneContext, ZoneModule, ZoneModuleData,
  ZoneModuleType, ZonePackage, ZoneWork, ZoneWorkRenderers } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { ZoneBrowseBar } from './browse.tsx';
import { WhyHere, ZoneWorkCard, ZoneWorkRow } from './card.tsx';
import type { ZoneMessages } from './messages.ts';
import { AnnouncementModule, type CardRenderer, ChipModule, DecisionModule, DiscussionModule, EditorialModule,
  HeroModule, type ModuleProps, PeopleModule, QuoteModule, RankingModule, RisingModule, ShelfModule } from './modules.tsx';
import { NextVolume, NextVolumeShelf } from './next-volume.tsx';
import { ModuleFailed, SlotBoundary } from './slot-boundary.tsx';

/**
 * A module's data as the page loaded it. `unsupported` means Main has no read
 * for its source yet: the module is left off the page rather than faked.
 */
export type ModuleState<Type extends ZoneModuleType = ZoneModuleType> =
  | { state: 'ready'; data: ZoneModuleData[Type] }
  | { state: 'empty' } | { state: 'failed' } | { state: 'unsupported' };

export type PlacedModule = { [Type in ZoneModuleType]: { module: ZoneModule<Type>; state: ModuleState<Type> } }[ZoneModuleType];

/** The platform rendering of each module type. */
const moduleRegistry: { [Type in ZoneModuleType]: ComponentType<ModuleProps<Type>> } = {
  'hero-carousel': HeroModule, 'chip-nav': ChipModule, announcement: AnnouncementModule, shelf: ShelfModule,
  ranking: RankingModule, 'editorial-list': EditorialModule, 'quote-stream': QuoteModule, rising: RisingModule,
  'decision-log': DecisionModule, 'discussion-list': DiscussionModule, people: PeopleModule,
};

type Placed<Type extends ZoneModuleType> = Extract<PlacedModule, { module: ZoneModule<Type> }>;

/** Narrows a placed module by its type. */
export function isType<Type extends ZoneModuleType>(placed: PlacedModule, type: Type): placed is Placed<Type> {
  return placed.module.type === type;
}

/** Whether a placed module has anything to show. */
const shows = (placed: PlacedModule) => placed.state.state === 'ready' || placed.state.state === 'failed';

/**
 * Renders Work cards: the platform card, or the package's `workCard` slot
 * wrapped so the "Why here?" stamp always stays with the card. Each card is
 * keyed by its Work, since modules set cards out as lists.
 */
export function cardRenderer(zone: ZoneContext, pkg: ZonePackage | null, locale: UiLocale, messages: ZoneMessages,
  avatarQuery?: string): CardRenderer {
  const Slot = pkg?.slots.workCard;
  const platform = (work: ZoneWork, options: ZoneCardOptions, whyHere: boolean) => options.layout === 'row'
    || options.layout === 'rail'
    ? <ZoneWorkRow key={work.id} work={work} rank={options.rank} compact={options.layout === 'rail'} locale={locale}
      messages={messages} avatarQuery={avatarQuery} whyHere={whyHere} />
    : <ZoneWorkCard key={work.id} work={work} rank={options.rank} slot={options.slot} locale={locale}
      messages={messages} avatarQuery={avatarQuery} whyHere={whyHere} />;
  return (work, options = {}) => {
    if (!Slot) return platform(work, options, true);
    const fallback = platform(work, options, false);
    return <div key={work.id} className="relative">
      <SlotBoundary slot="workCard" fallback={fallback}>
        <Slot zone={zone} work={work} layout={options.layout ?? 'cover'} rank={options.rank} matches={options.matches}
          nextVolume={<NextVolume work={work.id} locale={locale} />} fallback={fallback} Link={LocalizedLink} />
      </SlotBoundary>
      <WhyHere work={work} locale={locale} messages={messages} className="absolute end-1 top-1 bg-card/90 shadow-sm" />
    </div>;
  };
}

/** What a package's hero and module slots set Works out with: the platform card and "Why here?" stamp. */
export function workRenderers(card: CardRenderer, locale: UiLocale, messages: ZoneMessages): ZoneWorkRenderers {
  return { card, whyHere: work => <WhyHere work={work} locale={locale} messages={messages} />,
    nextVolumes: (works, heading) => <NextVolumeShelf works={works} heading={heading} locale={locale} /> };
}

function renderModule(placed: PlacedModule, zone: ZoneContext, pkg: ZonePackage | null, card: CardRenderer,
  locale: UiLocale, messages: ZoneMessages, avatarQuery?: string): ReactNode {
  const t = materializeData(messages, { locale });
  if (placed.state.state === 'failed') {
    return <ModuleFailed key={placed.module.id} module={placed.module} retry={messages.retry} more={messages.more}
      title={t.failed({ module: placed.module.title })} />;
  }
  if (placed.state.state !== 'ready') return null;
  const Platform = moduleRegistry[placed.module.type] as ComponentType<ModuleProps<ZoneModuleType>>;
  const props = { module: placed.module, data: placed.state.data, card, locale, messages, avatarQuery };
  const fallback = <Platform {...props} />;
  const Slot = pkg?.slots.modules?.[placed.module.type] as ComponentType<ModuleSlotProps<ZoneModuleType>> | undefined;
  if (!Slot) return <div key={placed.module.id} className="contents">{fallback}</div>;
  return <SlotBoundary key={placed.module.id} slot={`module:${placed.module.type}`} fallback={fallback}>
    <Slot zone={zone} module={placed.module} data={placed.state.data} fallback={fallback} Link={LocalizedLink}
      {...workRenderers(card, locale, messages)} />
  </SlotBoundary>;
}

/**
 * A Zone's home: its search and filters first (the browse bar), the hero
 * across the page, then the main column of modules with rail modules beside
 * it on wide screens and after it on phones. Each module renders from the
 * platform registry unless the Zone's approved package fills its slot.
 */
export function ZoneHome({ modules, zone, pkg, locale, messages, avatarQuery, empty, browse }: {
  modules: readonly PlacedModule[]; zone: ZoneContext; pkg: ZonePackage | null;
  locale: UiLocale; messages: ZoneMessages; avatarQuery?: string;
  /** Shown when no module has anything yet. */
  empty: ReactNode;
  /** The search and filters the home leads with; none on a page without a browse page. */
  browse?: ZoneBrowseEntry;
}) {
  const card = cardRenderer(zone, pkg, locale, messages, avatarQuery);
  const visible = modules.filter(shows);
  // Navigation and dismissible notices cannot stand in for the home's actual content.
  const hasContent = visible.some(placed => placed.module.type !== 'announcement' && placed.module.type !== 'chip-nav');
  const hero = visible.find(placed => isType(placed, 'hero-carousel'));
  const main = visible.filter(placed => placed !== hero && !placed.module.rail);
  const rail = visible.filter(placed => placed !== hero && placed.module.rail);
  const HeroSlot = pkg?.slots.hero;
  const heroNode = hero ? renderModule(hero, zone, null, card, locale, messages, avatarQuery) : null;
  const heroSlides = hero && isType(hero, 'hero-carousel') && hero.state.state === 'ready' ? hero.state.data.slides : [];
  const BrowseSlot = pkg?.slots.browseBar;
  const bar = browse ? <ZoneBrowseBar browse={browse} messages={messages} /> : null;
  return <div className="grid grid-cols-1 gap-(--zone-gap) pt-4 pb-10 sm:pt-6">
    {browse && bar ? <PageContainer className="py-0 sm:py-0 lg:py-0">
      {BrowseSlot ? <SlotBoundary slot="browseBar" fallback={bar}>
        <BrowseSlot zone={zone} browse={browse} fallback={bar} Link={LocalizedLink} /></SlotBoundary> : bar}
    </PageContainer> : null}
    {HeroSlot && heroNode ? <SlotBoundary slot="hero" fallback={heroNode}>
      <HeroSlot zone={zone} slides={heroSlides} fallback={heroNode} Link={LocalizedLink}
        {...workRenderers(card, locale, messages)} /></SlotBoundary> : heroNode}
    <PageContainer className="grid grid-cols-1 gap-(--zone-gap) py-0 sm:py-0 lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start
      lg:py-0">
      {hasContent ? null : <div className="lg:col-span-2">{empty}</div>}
      {main.length ? <div className="grid min-w-0 grid-cols-1 gap-(--zone-gap)">
        {main.map(placed => renderModule(placed, zone, pkg, card, locale, messages, avatarQuery))}</div> : null}
      {rail.length ? <div className="grid min-w-0 grid-cols-1 gap-(--zone-gap) lg:sticky lg:top-20">
        {rail.map(placed => renderModule(placed, zone, pkg, card, locale, messages, avatarQuery))}</div> : null}
    </PageContainer>
  </div>;
}
