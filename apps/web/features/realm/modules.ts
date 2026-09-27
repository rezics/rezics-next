import type { ZoneBanner, ZoneModuleData, ZoneShelfTab, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { feedOf, placedModule, type PresentationModule, type RealmFeed, type ZonePresentation }
  from '../zones/presentation.ts';
import type { ModuleState, PlacedModule } from '../zones/zone-home.tsx';
import { type AdaptContext, bannerImage, liveBanners, zoneDecision, zoneWork } from './adapt.ts';
import { readLatestChapters, readNewAdoptions, readRankings, readRealmWorks, readRecentDecisions,
  readRecentlyCompleted, readRising } from './read.ts';
import { idOf, realmHref } from './route.ts';
import type { Loaded, RankingMetric } from './types.ts';

// Loads each module of a Zone's presentation from Main's Realm module reads.
// A module whose source has no read yet (reader quotes, Collections, Context
// chips, shelved or rated charts) is `unsupported` and stays off the page; it
// is never assembled from other reads in the browser or here.

const failed = { state: 'failed' } as const;
const empty = { state: 'empty' } as const;
const unsupported = { state: 'unsupported' } as const;

/** Which adoption placed each Work here: the Realm's own list pairs Works with their selection. */
async function adoptions(context: AdaptContext): Promise<Map<string, string>> {
  const works = await readRealmWorks(context.realm, context.locale);
  return new Map(works.ok ? works.data.items.map(item => [item.id, item.selection]) : []);
}

/** A feed's Works, each with the Decision behind it. */
async function feedWorks(feed: RealmFeed, context: AdaptContext): Promise<Loaded<ZoneWork[]>> {
  const { realm, locale } = context;
  if (feed === 'new-adoptions') {
    const page = await readNewAdoptions(realm, locale);
    return page.ok ? { ok: true, data: page.data.items.map(item => zoneWork(item, context, item.evidence)) } : page;
  }
  if (feed === 'recently-completed') {
    const [page, placed] = await Promise.all([readRecentlyCompleted(realm, locale), adoptions(context)]);
    return page.ok ? { ok: true, data: page.data.items.map(item =>
      zoneWork(item, context, placed.get(item.id) ?? null)) } : page;
  }
  if (feed === 'latest-chapters') {
    const [page, placed] = await Promise.all([readLatestChapters(realm, locale), adoptions(context)]);
    if (!page.ok) return page;
    // One card per Work: the newest chapter stands for its Work.
    const seen = new Set<string>();
    return { ok: true, data: page.data.items.filter(item => !seen.has(item.work.id) && seen.add(item.work.id))
      .map(item => ({ ...zoneWork(item.work, context, placed.get(item.work.id) ?? null),
        latestChapter: { title: null, at: null,
          href: `/w/${idOf(item.work.id)}/read/${idOf(item.chapter)}` } })) };
  }
  return { ok: false, failure: 'invalid' };
}

async function hero(module: PresentationModule, presentation: ZonePresentation, context: AdaptContext):
  Promise<ModuleState<'hero-carousel'>> {
  const banners: ZoneBanner[] = liveBanners(presentation.banners, Date.now()).map(banner => ({ id: banner.id,
    title: { value: banner.title, lang: '', dir: 'ltr' }, href: banner.href, image: bannerImage(banner) }));
  if (banners.length) return { state: 'ready', data: { banners } };
  // Without art-directed banners the hero shows the newest picks, covers first.
  const feed = feedOf(module.source) ?? 'new-adoptions';
  if (feed === 'recent-decisions') return unsupported;
  const works = await feedWorks(feed, context);
  if (!works.ok) return failed;
  const picks = [...works.data].sort((a, b) => Number(Boolean(b.cover)) - Number(Boolean(a.cover)))
    .slice(0, module.options?.limit ?? 5);
  return picks.length ? { state: 'ready', data: { banners: picks.map(work => ({ id: work.id,
    title: work.title ?? { value: '', lang: '', dir: 'ltr' }, href: work.href, image: null, work })) } } : empty;
}

async function shelf(module: PresentationModule, context: AdaptContext): Promise<ModuleState<'shelf'>> {
  const sources = module.tabs ?? [{ id: module.id, label: module.title, source: module.source }];
  const supported = sources.flatMap(tab => {
    const feed = feedOf(tab.source);
    return feed && feed !== 'recent-decisions' ? [{ ...tab, feed }] : [];
  });
  if (!supported.length) return unsupported;
  const loaded = await Promise.all(supported.map(async tab => ({ tab, works: await feedWorks(tab.feed, context) })));
  const tabs: ZoneShelfTab[] = loaded.flatMap(({ tab, works }) => works.ok && works.data.length
    ? [{ id: tab.id, label: tab.label, items: works.data.slice(0, module.options?.limit ?? 14) }] : []);
  if (tabs.length) return { state: 'ready', data: { tabs } };
  return loaded.some(({ works }) => !works.ok) ? failed : empty;
}

/**
 * The chart metric Main computes for a presentation's metric. Main ranks by
 * reads and finished chapters; a chart of shelving or ratings has no read yet.
 */
export function chartMetric(metric: 'views' | 'shelved' | 'rating' = 'views'): RankingMetric | null {
  return metric === 'views' ? 'reads' : null;
}

const intervals = ['day', 'week', 'month'] as const;

async function rankings(module: PresentationModule, context: AdaptContext): Promise<ModuleState<'ranking'>> {
  const metric = chartMetric(module.options?.metric);
  if (!metric) return unsupported;
  const [placed, ...pages] = await Promise.all([adoptions(context),
    ...intervals.map(interval => readRankings(context.realm, context.locale, interval, metric))]);
  if (pages.every(page => !page.ok)) return failed;
  const tabs = intervals.flatMap((interval, index) => {
    const page = pages[index]!;
    return page.ok && page.data.items.length ? [{ interval, items: page.data.items.map((item, rank) => ({
      rank: rank + 1, work: zoneWork(item, context, placed.get(item.id) ?? null) })) }] : [];
  });
  return tabs.length ? { state: 'ready', data: { metric: module.options?.metric ?? 'views', tabs } } : empty;
}

async function rising(module: PresentationModule, context: AdaptContext): Promise<ModuleState<'rising'>> {
  const [page, placed] = await Promise.all([readRising(context.realm, context.locale), adoptions(context)]);
  if (!page.ok) return failed;
  const items = page.data.items.slice(0, module.options?.limit ?? 6)
    .map(item => zoneWork(item, context, placed.get(item.id) ?? null));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

async function decisions(module: PresentationModule, context: AdaptContext): Promise<ModuleState<'decision-log'>> {
  const [page, works] = await Promise.all([readRecentDecisions(context.realm), readRealmWorks(context.realm,
    context.locale)]);
  if (!page.ok) return failed;
  const titled = new Map((works.ok ? works.data.items : []).map(item => [item.id, zoneWork(item, context, null)]));
  const items = page.data.items.slice(0, module.options?.limit ?? 6).map(item => zoneDecision(item, context, titled));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

async function load(module: PresentationModule, presentation: ZonePresentation, context: AdaptContext):
  Promise<ModuleState> {
  switch (module.type) {
    case 'hero-carousel': return hero(module, presentation, context);
    case 'shelf': return shelf(module, context);
    case 'decision-log': return decisions(module, context);
    case 'ranking': return rankings(module, context);
    case 'rising': return rising(module, context);
    case 'announcement': return { state: 'ready',
      data: { text: { value: module.title, lang: '', dir: 'ltr' }, href: null } satisfies ZoneModuleData['announcement'] };
    default: return unsupported;
  }
}

/** Where a module's "More" leads, when the Realm has a view for it. */
function moreOf(module: PresentationModule, locale: UiLocale, ref: string): string | null {
  if (module.type === 'decision-log') return realmHref(locale, ref, 'decisions');
  if (module.type === 'shelf') return realmHref(locale, ref, 'works');
  return null;
}

export async function loadModules(presentation: ZonePresentation, context: AdaptContext): Promise<PlacedModule[]> {
  return Promise.all(presentation.modules.map(async module => ({
    module: placedModule(module, moreOf(module, context.locale, context.ref)),
    state: await load(module, presentation, context),
  }) as PlacedModule));
}
