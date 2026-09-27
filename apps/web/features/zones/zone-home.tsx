import type { ComponentType } from 'react';
import type { ModuleSlotProps, ZoneCardOptions, ZoneContext, ZoneModule, ZoneModuleData, ZoneModuleType, ZonePackage,
  ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import { WhyHere, ZoneWorkCard, ZoneWorkRow } from './card.tsx';
import type { ZoneMessages } from './messages.ts';
import { AnnouncementModule, type CardRenderer, ChipModule, DecisionModule, DiscussionModule, EditorialModule,
  HeroModule, type ModuleProps, PeopleModule, QuoteModule, RankingModule, RisingModule, ShelfModule } from './modules.tsx';
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
 * wrapped so the "Why here?" stamp always stays with the card.
 */
export function cardRenderer(zone: ZoneContext, pkg: ZonePackage | null, locale: UiLocale, messages: ZoneMessages,
  avatarQuery?: string): CardRenderer {
  const Slot = pkg?.slots.workCard;
  const platform = (work: ZoneWork, options: ZoneCardOptions, whyHere: boolean) => options.layout === 'row'
    || options.layout === 'rail'
    ? <ZoneWorkRow work={work} rank={options.rank} compact={options.layout === 'rail'} locale={locale}
      messages={messages} avatarQuery={avatarQuery} whyHere={whyHere} />
    : <ZoneWorkCard work={work} rank={options.rank} slot={options.slot} locale={locale} messages={messages}
      avatarQuery={avatarQuery} whyHere={whyHere} />;
  return (work, options = {}) => {
    if (!Slot) return platform(work, options, true);
    const fallback = platform(work, options, false);
    return <div className="relative">
      <SlotBoundary slot="workCard" fallback={fallback}>
        <Slot zone={zone} work={work} layout={options.layout ?? 'cover'} rank={options.rank} fallback={fallback} />
      </SlotBoundary>
      <WhyHere work={work} locale={locale} messages={messages} className="absolute end-1 top-1 bg-card/90 shadow-sm" />
    </div>;
  };
}

function renderModule(placed: PlacedModule, zone: ZoneContext, pkg: ZonePackage | null, card: CardRenderer,
  locale: UiLocale, messages: ZoneMessages, avatarQuery?: string): ReactNode {
  const t = materializeData(messages, { locale });
  if (placed.state.state === 'failed') {
    return <ModuleFailed key={placed.module.id} module={placed.module} retry={messages.retry}
      title={t.failed({ module: placed.module.title })} />;
  }
  if (placed.state.state !== 'ready') return null;
  const Platform = moduleRegistry[placed.module.type] as ComponentType<ModuleProps<ZoneModuleType>>;
  const props = { module: placed.module, data: placed.state.data, card, locale, messages, avatarQuery };
  const fallback = <Platform {...props} />;
  const Slot = pkg?.slots.modules?.[placed.module.type] as ComponentType<ModuleSlotProps<ZoneModuleType>> | undefined;
  if (!Slot) return <div key={placed.module.id} className="contents">{fallback}</div>;
  return <SlotBoundary key={placed.module.id} slot={`module:${placed.module.type}`} fallback={fallback}>
    <Slot zone={zone} module={placed.module} data={placed.state.data} fallback={fallback} card={card} />
  </SlotBoundary>;
}

/**
 * A Zone's home: the hero across the page, then the main column of modules
 * with rail modules beside it on wide screens and after it on phones. Each
 * module renders from the platform registry unless the Zone's approved
 * package fills its slot.
 */
export function ZoneHome({ modules, zone, pkg, locale, messages, avatarQuery, empty }: {
  modules: readonly PlacedModule[]; zone: ZoneContext; pkg: ZonePackage | null;
  locale: UiLocale; messages: ZoneMessages; avatarQuery?: string;
  /** Shown when no module has anything yet. */
  empty: ReactNode;
}) {
  const card = cardRenderer(zone, pkg, locale, messages, avatarQuery);
  const visible = modules.filter(shows);
  const hero = visible.find(placed => isType(placed, 'hero-carousel'));
  const main = visible.filter(placed => placed !== hero && !placed.module.rail);
  const rail = visible.filter(placed => placed !== hero && placed.module.rail);
  const HeroSlot = pkg?.slots.hero;
  const heroNode = hero ? renderModule(hero, zone, null, card, locale, messages, avatarQuery) : null;
  const heroBanners = hero && isType(hero, 'hero-carousel') && hero.state.state === 'ready' ? hero.state.data.banners : [];
  return <div className="grid grid-cols-1 gap-(--zone-gap) pt-4 pb-10 sm:pt-6">
    {HeroSlot && heroNode ? <SlotBoundary slot="hero" fallback={heroNode}>
      <HeroSlot zone={zone} banners={heroBanners} fallback={heroNode} /></SlotBoundary> : heroNode}
    <PageContainer className="grid grid-cols-1 gap-(--zone-gap) py-0 sm:py-0 lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start
      lg:py-0">
      {visible.length ? null : <div className="lg:col-span-2">{empty}</div>}
      {main.length ? <div className="grid min-w-0 grid-cols-1 gap-(--zone-gap)">
        {main.map(placed => renderModule(placed, zone, pkg, card, locale, messages, avatarQuery))}</div> : null}
      {rail.length ? <div className="grid min-w-0 grid-cols-1 gap-(--zone-gap) lg:sticky lg:top-20">
        {rail.map(placed => renderModule(placed, zone, pkg, card, locale, messages, avatarQuery))}</div> : null}
    </PageContainer>
  </div>;
}
