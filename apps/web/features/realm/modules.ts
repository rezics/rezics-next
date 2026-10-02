import { resourceHref, spaceHref } from '../address/path.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import type {
  RankingMetric as ChartMetric,
  ZoneBanner,
  ZoneModuleData,
  ZoneShelfTab,
  ZoneWork,
} from '@rezics/zone-sdk';
import {
  feedOf,
  placedModule,
  type ModuleSource,
  type PresentationModule,
  type RealmFeed,
  type ZonePresentation,
} from '../zones/presentation.ts';
import type { ModuleState, PlacedModule } from '../zones/zone-home.tsx';
import { zoneContentText } from '../language/untagged.ts';
import { isoMoment } from '../zones/adapt-cards.ts';
import { chipHref } from '../zones/browse-state.ts';
import {
  type AdaptContext,
  bannerImage,
  liveBanners,
  type ModuleCredit,
  workLink,
  zoneDecision,
  zonePeople,
  zoneText,
  zoneWork,
} from './adapt.ts';
import {
  readLatestChapters,
  readNewAdoptions,
  readRankings,
  readRealmWorks,
  readRecentDecisions,
  readRecentlyCompleted,
  readRising,
  readZoneDiscussions,
  readZoneEditorLists,
  readZoneGenres,
  readZoneQuotes,
  readZoneRoute,
} from './read.ts';
import { idOf, realmHref, siteHref } from './route.ts';
import type { Loaded, MainAvatar, MainName, RankingMetric, ZonePresentationRead } from './types.ts';

// Loads each module of a Zone's presentation from Main's Realm module reads.
// A module whose source has no read yet is `unsupported` and stays off the page; it
// is never assembled from other reads in the browser or here.

const failed = { state: 'failed' } as const;
const empty = { state: 'empty' } as const;
const unsupported = { state: 'unsupported' } as const;

export function summaryWork(
  item: {
    id: string;
    title: MainName;
    cover?: MainAvatar;
    inZone?: boolean;
    address?: CanonicalAddress;
  },
  context: AdaptContext,
  mount: string | null = null,
): ZoneWork {
  return zoneWork(
    {
      id: item.id,
      title: item.title,
      address: item.address,
      cover: item.cover ?? { kind: 'fallback', policy: 'zone', key: item.id, resourceType: 'work' },
      types: [],
      tagline: null,
      completionStatus: null,
      chapterCount: null,
      wordCount: null,
      lastUpdatedAt: null,
      inZone: item.inZone,
    },
    context,
    null,
    mount,
  );
}

/** Where a quote or discussion about a Work leads: its discussion in the Zone, or on the canonical page if not in it. */
export const replyHref = (context: AdaptContext, work: { id: string; inZone: boolean }) =>
  workLink(context, work.id, null, 'discussion', work.inZone);

/**
 * The Realm's own cards for its Works, by ID: the Realm's list pairs each
 * Work with the adoption that placed it, and the new-adoptions read also
 * names its authors. Charts, editor lists and quotes read thinner cards; they
 * take the author, hook, kind and "Why here?" from here, so a Work reads the
 * same in every module. Both reads are cached for the request.
 */
async function realmCards(context: AdaptContext): Promise<Map<string, ZoneWork>> {
  const [works, adopted] = await Promise.all([
    readRealmWorks(context.realm, context.locale),
    readNewAdoptions(context.realm, context.locale),
  ]);
  const cards = new Map(
    works.ok
      ? works.data.items.map((item) => [item.id, zoneWork(item, context, item.selection)])
      : [],
  );
  for (const item of adopted.ok ? adopted.data.items : []) {
    const card = zoneWork(item, context, item.evidence);
    cards.set(item.id, { ...card, decision: cards.get(item.id)?.decision ?? card.decision });
  }
  return cards;
}

/** A module's card, completed from the Realm's card for the same Work. */
export function withRealmCard(work: ZoneWork, known: ZoneWork | undefined): ZoneWork {
  if (!known) return work;
  return {
    ...work,
    kind: known.kind,
    author: work.author ?? known.author,
    authorHref: work.author ? work.authorHref : known.authorHref,
    tagline: work.tagline ?? known.tagline,
    status: work.status ?? known.status,
    chapters: work.chapters ?? known.chapters,
    cover: work.cover ?? known.cover,
    decision: work.decision ?? known.decision,
    hub: work.hub ?? known.hub ?? null,
  };
}

/** A feed's Works, each with the Decision behind it. */
async function feedWorks(feed: RealmFeed, context: AdaptContext): Promise<Loaded<ZoneWork[]>> {
  const { realm, locale } = context;
  if (feed === 'new-adoptions') {
    const page = await readNewAdoptions(realm, locale);
    return page.ok
      ? { ok: true, data: page.data.items.map((item) => zoneWork(item, context, item.evidence)) }
      : page;
  }
  if (feed === 'recently-completed') {
    const [page, cards] = await Promise.all([
      readRecentlyCompleted(realm, locale),
      realmCards(context),
    ]);
    return page.ok
      ? {
          ok: true,
          data: page.data.items.map((item) =>
            withRealmCard(zoneWork(item, context, null), cards.get(item.id)),
          ),
        }
      : page;
  }
  if (feed === 'latest-chapters') {
    const [page, cards] = await Promise.all([
      readLatestChapters(realm, locale),
      realmCards(context),
    ]);
    if (!page.ok) return page;
    // One card per Work: the newest chapter stands for its Work.
    const seen = new Set<string>();
    return {
      ok: true,
      data: page.data.items
        .filter((item) => !seen.has(item.work.id) && seen.add(item.work.id))
        .map((item) => ({
          ...withRealmCard(zoneWork(item.work, context, null), cards.get(item.work.id)),
          latestChapter: {
            title: zoneText(item.chapterTitle),
            at: isoMoment(item.chapterUpdatedAt),
            href: `${resourceHref('/w/', item.work.id)}/read/${idOf(item.chapter)}`,
          },
        })),
    };
  }
  return { ok: false, failure: 'invalid' };
}

async function hero(
  module: PresentationModule,
  presentation: ZonePresentation,
  context: AdaptContext,
  bannerMedia: ZonePresentationRead['bannerMedia'],
): Promise<ModuleState<'hero-carousel'>> {
  const banners: ZoneBanner[] = liveBanners(presentation.banners, Date.now()).map((banner) => ({
    id: banner.id,
    title: zoneContentText(banner.title),
    href: banner.href,
    image: bannerImage(banner, bannerMedia),
  }));
  if (banners.length) return { state: 'ready', data: { banners } };
  // Without art-directed banners the hero shows the newest picks, covers first.
  const feed = feedOf(module.source) ?? 'new-adoptions';
  if (feed === 'recent-decisions') return unsupported;
  const works = await feedWorks(feed, context);
  if (!works.ok) return failed;
  const picks = [...works.data]
    .sort((a, b) => Number(Boolean(b.cover)) - Number(Boolean(a.cover)))
    .slice(0, module.options?.limit ?? 5);
  return picks.length
    ? {
        state: 'ready',
        data: {
          banners: picks.map((work) => ({
            id: work.id,
            title: work.title ?? zoneContentText(''),
            href: work.href,
            image: null,
            work,
          })),
        },
      }
    : empty;
}

/** A mounted Collection shelf uses the same public, visibility-filtered index read as its full catalogue. */
async function shelfWorks(
  source: ModuleSource,
  context: AdaptContext,
): Promise<Loaded<ZoneWork[]>> {
  if (source.kind !== 'collection') {
    const feed = feedOf(source);
    return feed ? feedWorks(feed, context) : { ok: false, failure: 'invalid' };
  }
  const mount = context.mounts?.get(source.collection);
  if (!context.zone || !mount) return { ok: false, failure: 'missing' };
  const page = await readZoneRoute(context.zone, `/${mount}`);
  if (!page.ok) return page;
  if (page.data.kind !== 'index' || page.data.collection !== source.collection) {
    return { ok: false, failure: 'unavailable' };
  }
  return {
    ok: true,
    data: page.data.items.flatMap((item) =>
      'title' in item ? [zoneWork(item, context, null, mount)] : [],
    ),
  };
}

async function shelf(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'shelf'>> {
  const sources = module.tabs ?? [{ id: module.id, label: module.title, source: module.source }];
  const supported = sources.filter((tab) => {
    const feed = feedOf(tab.source);
    return tab.source.kind === 'collection' || (feed && feed !== 'recent-decisions');
  });
  if (!supported.length) return unsupported;
  const loaded = await Promise.all(
    supported.map(async (tab) => ({ tab, works: await shelfWorks(tab.source, context) })),
  );
  const tabs: ZoneShelfTab[] = loaded.flatMap(({ tab, works }) =>
    works.ok && works.data.length
      ? [{ id: tab.id, label: tab.label, items: works.data.slice(0, module.options?.limit ?? 14) }]
      : [],
  );
  if (tabs.length) return { state: 'ready', data: { tabs } };
  return loaded.some(({ works }) => !works.ok) ? failed : empty;
}

/**
 * The metric a Zone chart ranks by, in the presentation's vocabulary. Main
 * ranks by more metrics than a Zone chart may name (reviews rank Work pages,
 * not Zones); the intersection type keeps every chart metric one Main reads.
 */
export function chartMetric(metric: ChartMetric = 'reads'): ChartMetric & RankingMetric {
  return metric;
}

const intervals = ['day', 'week', 'month'] as const;

async function rankings(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'ranking'>> {
  const metric = chartMetric(module.options?.metric);
  const [cards, ...pages] = await Promise.all([
    realmCards(context),
    ...intervals.map((interval) => readRankings(context.realm, context.locale, interval, metric)),
  ]);
  if (pages.every((page) => !page.ok)) return failed;
  const tabs = intervals.flatMap((interval, index) => {
    const page = pages[index]!;
    return page.ok && page.data.items.length
      ? [
          {
            interval,
            items: page.data.items.map((item, rank) => ({
              rank: rank + 1,
              work: withRealmCard(zoneWork(item, context, null), cards.get(item.id)),
            })),
          },
        ]
      : [];
  });
  return tabs.length ? { state: 'ready', data: { metric, tabs } } : empty;
}

async function rising(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'rising'>> {
  const [page, cards] = await Promise.all([
    readRising(context.realm, context.locale),
    realmCards(context),
  ]);
  if (!page.ok) return failed;
  const items = page.data.items
    .slice(0, module.options?.limit ?? 6)
    .map((item) => withRealmCard(zoneWork(item, context, null), cards.get(item.id)));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

/** A feed's Works with their credited authors, as Main's module reads return them. */
async function creditedWorks(
  feed: RealmFeed,
  context: AdaptContext,
): Promise<Loaded<{ title: MainName; primaryCredits: readonly ModuleCredit[] }[]>> {
  const { realm, locale } = context;
  if (feed === 'new-adoptions' || feed === 'recently-completed') {
    const page = await (feed === 'new-adoptions' ? readNewAdoptions : readRecentlyCompleted)(
      realm,
      locale,
    );
    return page.ok ? { ok: true, data: page.data.items } : page;
  }
  if (feed === 'latest-chapters') {
    const page = await readLatestChapters(realm, locale);
    return page.ok ? { ok: true, data: page.data.items.map((item) => item.work) } : page;
  }
  return { ok: false, failure: 'invalid' };
}

/** People to follow: the authors of the Works a feed brings to this Realm (Books' "Authors to follow"). */
async function people(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'people'>> {
  const feed = feedOf(module.source);
  if (!feed || feed === 'recent-decisions') return unsupported;
  const works = await creditedWorks(feed, context);
  if (!works.ok) return failed;
  const items = zonePeople(works.data, module.options?.limit ?? 6);
  return items.length ? { state: 'ready', data: { items } } : empty;
}

async function decisions(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'decision-log'>> {
  const [page, works] = await Promise.all([
    readRecentDecisions(context.realm),
    readRealmWorks(context.realm, context.locale),
  ]);
  if (!page.ok) return failed;
  const titled = new Map(
    (works.ok ? works.data.items : []).map((item) => [item.id, zoneWork(item, context, null)]),
  );
  const items = page.data.items
    .slice(0, module.options?.limit ?? 6)
    .map((item) => zoneDecision(item, context, titled));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

async function quotes(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'quote-stream'>> {
  if (module.source.kind !== 'query-block' || module.source.block !== 'reader-quotes')
    return unsupported;
  const [page, cards] = await Promise.all([
    readZoneQuotes(context.realm, context.locale),
    realmCards(context),
  ]);
  if (!page.ok) return failed;
  const items = page.data.items.slice(0, module.options?.limit ?? 6).map((item) => ({
    id: item.id,
    body: zoneContentText(item.excerpt),
    reader: item.authorName,
    work: withRealmCard(summaryWork(item.work, context), cards.get(item.work.id)),
    href: replyHref(context, item.work),
  }));
  return items.length ? { state: 'ready', data: { quotes: items } } : empty;
}

async function discussions(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'discussion-list'>> {
  if (module.source.kind !== 'query-block' || module.source.block !== 'discussions')
    return unsupported;
  const [page, cards] = await Promise.all([
    readZoneDiscussions(context.realm, context.locale),
    realmCards(context),
  ]);
  if (!page.ok) return failed;
  const items = page.data.items.slice(0, module.options?.limit ?? 8).map((item) => ({
    id: item.id,
    title: zoneContentText(item.excerpt),
    href: replyHref(context, item.work),
    replies: null,
    work: withRealmCard(summaryWork(item.work, context), cards.get(item.work.id)),
  }));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

async function editorLists(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'editorial-list'>> {
  const collections = [module.source, ...(module.tabs ?? []).map((tab) => tab.source)].flatMap(
    (source) => (source.kind === 'collection' ? [source.collection] : []),
  );
  if (!collections.length) return unsupported;
  const [read, cards] = await Promise.all([
    readZoneEditorLists(context.realm, context.locale),
    realmCards(context),
  ]);
  if (!read.ok) return failed;
  // A list whose Works are all private has nothing to show yet, like an empty module.
  const lists = read.data.lists
    .filter((list) => collections.includes(list.collection) && list.items.length)
    .slice(0, module.options?.limit ?? 2)
    .map((list) => {
      // A Collection the Zone mounts opens as its own page, and its members open under that mount.
      const mount = context.mounts?.get(list.collection) ?? null;
      return {
        id: list.collection,
        title: zoneText(list.name),
        blurb: null,
        href: mount && !context.unrouted ? spaceHref(context.ref, 'site', [mount]) : null,
        items: list.items.map((item) =>
          withRealmCard(summaryWork(item, context, mount), cards.get(item.id)),
        ),
      };
    });
  return lists.length ? { state: 'ready', data: { lists } } : empty;
}

async function genres(
  module: PresentationModule,
  context: AdaptContext,
): Promise<ModuleState<'chip-nav'>> {
  if (module.source.kind !== 'context') return unsupported;
  const contextId = idOf(module.source.context);
  if (!contextId) return unsupported;
  const read = await readZoneGenres(context.realm, contextId, context.locale);
  if (!read.ok) return failed;
  // Each chip opens the Zone's own browse page filtered by its Concept (the `concept` Facet).
  const chips = read.data.items
    .map((item) => ({
      id: item.id,
      label: zoneText(item.name),
      href: chipHref(realmHref(context.locale, context.ref, 'browse'), 'concept', item.concept),
    }))
    .slice(0, module.options?.limit ?? 12);
  return chips.length ? { state: 'ready', data: { chips } } : empty;
}

async function load(
  module: PresentationModule,
  presentation: ZonePresentation,
  context: AdaptContext,
  bannerMedia: ZonePresentationRead['bannerMedia'],
): Promise<ModuleState> {
  switch (module.type) {
    case 'hero-carousel':
      return hero(module, presentation, context, bannerMedia);
    case 'shelf':
      return shelf(module, context);
    case 'decision-log':
      return decisions(module, context);
    case 'quote-stream':
      return quotes(module, context);
    case 'discussion-list':
      return discussions(module, context);
    case 'editorial-list':
      return editorLists(module, context);
    case 'chip-nav':
      return genres(module, context);
    case 'ranking':
      return rankings(module, context);
    case 'rising':
      return rising(module, context);
    case 'people':
      return people(module, context);
    case 'announcement':
      return {
        state: 'ready',
        data: {
          text: zoneContentText(module.title),
          href: null,
        } satisfies ZoneModuleData['announcement'],
      };
    default:
      return unsupported;
  }
}

/** Where a module's "More" leads, when the Realm has a view for it. */
function moreOf(module: PresentationModule, context: AdaptContext): string | null {
  const { locale, ref } = context;
  if (module.type === 'shelf' && module.source.kind === 'collection') {
    const mount = context.mounts?.get(module.source.collection);
    return mount ? siteHref(locale, ref, [mount]) : null;
  }
  if (module.type === 'decision-log') return realmHref(locale, ref, 'decisions');
  if (module.type === 'shelf') return realmHref(locale, ref, 'browse');
  return null;
}

export async function loadModules(
  presentation: ZonePresentation,
  context: AdaptContext,
  bannerMedia: ZonePresentationRead['bannerMedia'] = [],
): Promise<PlacedModule[]> {
  return Promise.all(
    presentation.modules.map(
      async (module) =>
        ({
          module: placedModule(module, moreOf(module, context)),
          state: await load(module, presentation, context, bannerMedia),
        }) as PlacedModule,
    ),
  );
}
