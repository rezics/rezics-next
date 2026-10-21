import { readShowcaseImages, readShowcaseWorks, readWorkShowcase } from '../api/showcase.ts';
import { slideImageUrls } from '../showcase/stage.ts';
import { readRankingModuleAnswer } from './ranking-read.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { RealmReadClient } from './read.ts';
import { resourceHref, spaceHref } from '../address/path.ts';
import { loadPublishedHomeModules, type PublishedHomeContext } from '../zone-editor/home-modules.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import type {
  RankingMetric as ChartMetric,
  ZoneShowcaseSlide,
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
  presentationSlide,
  liveSlides,
  workShowcaseArt,
  type ModuleCredit,
  workLink,
  zoneDecision,
  zonePeople,
  zoneText,
  zoneWork,
} from './adapt.ts';
// Loaded when a module actually reads Main. Importing this file must stay usable in a browser story:
// `read.ts` reaches the server request store, and a slide with no Works never calls these.
type RealmRead = typeof import('./read.ts');
function realmReads(): Promise<RealmRead> {
  return import('./read.ts');
}
const readLatestChapters: RealmRead['readLatestChapters'] = (...args) =>
  realmReads().then(reads => reads.readLatestChapters(...args));
const readNewAdoptions: RealmRead['readNewAdoptions'] = (...args) =>
  realmReads().then(reads => reads.readNewAdoptions(...args));
const readRankings: RealmRead['readRankings'] = (...args) =>
  realmReads().then(reads => reads.readRankings(...args));
const readRealmWorks: RealmRead['readRealmWorks'] = (...args) =>
  realmReads().then(reads => reads.readRealmWorks(...args));
const readRecentDecisions: RealmRead['readRecentDecisions'] = (...args) =>
  realmReads().then(reads => reads.readRecentDecisions(...args));
const readRecentlyCompleted: RealmRead['readRecentlyCompleted'] = (...args) =>
  realmReads().then(reads => reads.readRecentlyCompleted(...args));
const readRising: RealmRead['readRising'] = (...args) =>
  realmReads().then(reads => reads.readRising(...args));
const readZoneDiscussions: RealmRead['readZoneDiscussions'] = (...args) =>
  realmReads().then(reads => reads.readZoneDiscussions(...args));
const readZoneEditorLists: RealmRead['readZoneEditorLists'] = (...args) =>
  realmReads().then(reads => reads.readZoneEditorLists(...args));
const readZoneGenres: RealmRead['readZoneGenres'] = (...args) =>
  realmReads().then(reads => reads.readZoneGenres(...args));
const readZoneQuotes: RealmRead['readZoneQuotes'] = (...args) =>
  realmReads().then(reads => reads.readZoneQuotes(...args));
const readZoneRoute: RealmRead['readZoneRoute'] = (...args) =>
  realmReads().then(reads => reads.readZoneRoute(...args));
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
): Pick<ZoneWork, 'id' | 'href' | 'title'> {
  // A named reference can link to a Work; it has no semantic kind or cover to render as a card.
  return { id: item.id, title: zoneText(item.title),
    href: workLink(context, item.id, mount, undefined, item.inZone, item.address) };
}

/** Where a quote or discussion about a Work leads: its discussion in the Zone, or on the canonical page if not in it. */
export const replyHref = (context: AdaptContext, work: { id: string; inZone: boolean }) =>
  workLink(context, work.id, null, 'discussion', work.inZone);

/**
 * Decorate the displayed Works with their Realm adoption and author credits.
 * Exact target batches stay within the card reader's 20-Work hydration bound.
 */
async function realmCards(context: AdaptContext, works: readonly string[],
  client?: RealmReadClient): Promise<Map<string, ZoneWork>> {
  const targets = [...new Set(works)];
  const cards = new Map<string, ZoneWork>();
  for (let offset = 0; offset < targets.length; offset += 20) {
    const batch = targets.slice(offset, offset + 20);
    const adopted = await readNewAdoptions(context.realm, context.locale, client, batch);
    if (!adopted.ok || adopted.data.nextCursor) continue;
    for (const item of adopted.data.items) {
      cards.set(item.id, zoneWork(item, context, item.evidence));
    }
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
    authors: work.authors ?? known.authors,
    tagline: work.tagline ?? known.tagline,
    factObligations: work.factObligations ?? known.factObligations,
    status: work.status ?? known.status,
    chapters: work.chapters ?? known.chapters,
    words: work.words ?? known.words,
    updatedAt: work.updatedAt ?? known.updatedAt,
    cover: work.cover ?? known.cover,
    decision: work.decision ?? known.decision,
    hub: work.hub ?? known.hub ?? null,
    showcaseArt: work.showcaseArt ?? known.showcaseArt ?? null,
  };
}

type HomeWindow<T> = Loaded<T[]> & { nextCursor?: string | null };

/** A bounded module may stop at its display limit, never at an unfinished shorter page. */
function underfilled(read: { nextCursor?: string | null }, count: number, limit: number) {
  return Boolean(read.nextCursor) && count < limit;
}

/** A feed's Works, each with the Decision behind it and its continuation. */
export async function loadFeedWorks(feed: RealmFeed, context: AdaptContext,
  read = { adoptions: readNewAdoptions, completed: readRecentlyCompleted, chapters: readLatestChapters, cards: realmCards },
): Promise<HomeWindow<ZoneWork>> {
  const { realm, locale } = context;
  if (feed === 'new-adoptions') {
    const page = await read.adoptions(realm, locale);
    return page.ok
      ? { ok: true, data: page.data.items.map((item) => zoneWork(item, context, item.evidence)), nextCursor: page.data.nextCursor }
      : page;
  }
  if (feed === 'recently-completed') {
    const page = await read.completed(realm, locale);
    if (!page.ok) return page;
    const cards = await read.cards(context, page.data.items.map(item => item.id));
    return {
      ok: true,
      data: page.data.items.map((item) =>
        withRealmCard(zoneWork(item, context, null), cards.get(item.id)),
      ),
      nextCursor: page.data.nextCursor,
    };
  }
  if (feed === 'latest-chapters') {
    const page = await read.chapters(realm, locale);
    if (!page.ok) return page;
    const cards = await read.cards(context, page.data.items.map(item => item.work.id));
    // One card per Work: the newest chapter stands for its Work.
    const seen = new Set<string>();
    return {
      ok: true,
      nextCursor: page.data.nextCursor,
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

export const showcaseContext = (context: AdaptContext) =>
  !context.realm || context.realm.startsWith('https://rezics.com/id/') ? context.realm : 'https://rezics.com/id/' + context.realm;

/** A thin reference only becomes a card after a complete authorized read, even outside the Realm. */
async function completeModuleCards(context: AdaptContext, targets: readonly string[],
  known: ReadonlyMap<string, ZoneWork>, read = readShowcaseWorks): Promise<ReadonlyMap<string, ZoneWork> | null> {
  const missing = [...new Set(targets)].filter(target => !known.has(target));
  const cards = new Map(known);
  for (let offset = 0; offset < missing.length; offset += 64) {
    const works = await read(missing.slice(offset, offset + 64), showcaseContext(context));
    for (const [target, work] of works) cards.set(target, zoneWork(work, context, null));
  }
  return targets.every(target => cards.has(target)) ? cards : null;
}

export async function loadHeroModule(
  module: PresentationModule, presentation: ZonePresentation, context: AdaptContext,
  slideMedia: ZonePresentationRead['slideMedia'],
  read = loadFeedWorks,
  cards = realmCards,
  readWorks = readShowcaseWorks,
): Promise<ModuleState<'hero-carousel'>> {
  const scheduled = liveSlides(presentation.slides, Date.now()).slice(0, 5);
  if (scheduled.length) {
    const targets = scheduled.flatMap(slide => 'work' in slide ? [slide.work] : []);
    const [summaries, known] = await Promise.all([
      readWorks(targets, showcaseContext(context)),
      cards(context, targets),
    ]);
    if (targets.some(target => !summaries.has(target) && !known.has(target))) return failed;
    const slides: ZoneShowcaseSlide[] = scheduled.flatMap(slide => {
      const summary = 'work' in slide ? summaries.get(slide.work) : null;
      const realmCard = 'work' in slide ? known.get(slide.work) : undefined;
      const complete = summary ? zoneWork(summary, context, null) : null;
      // A complete Work owns even its empty fields. An older Realm card may
      // supply placement context, but must not restore a cleared cover or credit.
      const work = complete && summary ? { ...complete,
        decision: realmCard?.decision ?? complete.decision,
        hub: complete.hub ?? realmCard?.hub ?? null,
        showcaseArt: complete.showcaseArt ?? realmCard?.showcaseArt ?? null,
        href: realmCard?.href ?? resourceHref('/w/', summary.address) } : realmCard ?? null;
      const adapted = presentationSlide(slide, work, context, slideMedia);
      return adapted ? [adapted] : [];
    });
    return slides.length ? { state: 'ready', data: { slides } } : empty;
  }
  // Without a scheduled campaign the newest picks still have their own art and trailer.
  const feed = feedOf(module.source) ?? 'new-adoptions';
  if (feed === 'recent-decisions') return unsupported;
  const works = await read(feed, context);
  if (!works.ok) return failed;
  const limit = Math.min(5, module.options?.limit ?? 5);
  const picks = [...works.data].sort((a, b) => Number(Boolean(b.cover)) - Number(Boolean(a.cover)))
    .slice(0, limit);
  if (underfilled(works, picks.length, limit)) return failed;
  return picks.length ? { state: 'ready', data: { slides: picks.map(work => ({ id: work.id,
    title: work.title ?? zoneContentText(''), href: work.href, tagline: work.tagline, work })) } } : empty;
}

/** The whole home makes one art batch, rather than one round trip for each slide or module. */
export async function enrichShowcaseModules(modules: PlacedModule[], context: AdaptContext,
  read = readWorkShowcase): Promise<PlacedModule[]> {
  const heroes = modules.filter((placed): placed is Extract<PlacedModule, { module: { type: 'hero-carousel' } }> =>
    placed.module.type === 'hero-carousel');
  const targets = [...new Set(heroes.flatMap(hero => hero.state.state === 'ready'
    ? hero.state.data.slides.flatMap(slide => slide.work ? [slide.work.id] : []) : []))];
  if (!targets.length) return modules;
  const art = await read(targets, showcaseContext(context));
  if (!art.size) return modules;
  const replacements = new Map<PlacedModule, PlacedModule>();
  for (const hero of heroes) {
    if (hero.state.state !== 'ready') continue;
    const slides = hero.state.data.slides.map(slide => {
      const own = slide.work && art.get(slide.work.id);
      return own ? { ...slide, work: { ...slide.work!, showcaseArt: workShowcaseArt(own) },
        trailer: own.trailer ? { href: own.trailer.url } : slide.trailer } : slide;
    });
    replacements.set(hero, { ...hero, state: { state: 'ready', data: { slides } } });
  }
  return modules.map(module => replacements.get(module) ?? module);
}

/** A mounted Collection shelf uses the same public, visibility-filtered index read as its full catalogue. */
export async function shelfWorks(
  source: ModuleSource,
  context: AdaptContext,
  read = readZoneRoute,
): Promise<HomeWindow<ZoneWork>> {
  if (source.kind !== 'collection') {
    const feed = feedOf(source);
    return feed ? loadFeedWorks(feed, context) : { ok: false, failure: 'invalid' };
  }
  const mount = context.mounts?.get(source.collection);
  if (!context.zone || !mount) return { ok: false, failure: 'missing' };
  const page = await read(context.zone, `/${mount}`);
  if (!page.ok) return page;
  if (page.data.kind !== 'index' || page.data.collection !== source.collection) {
    return { ok: false, failure: 'unavailable' };
  }
  return {
    ok: true,
    nextCursor: page.data.nextCursor,
    data: page.data.items.flatMap((item) =>
      'title' in item ? [zoneWork(item, context, null, mount)] : [],
    ),
  };
}

export async function loadShelfModule(
  module: PresentationModule,
  context: AdaptContext,
  read = shelfWorks,
): Promise<ModuleState<'shelf'>> {
  const sources = module.tabs ?? [{ id: module.id, label: module.title, source: module.source }];
  const supported = sources.filter((tab) => {
    const feed = feedOf(tab.source);
    return tab.source.kind === 'collection' || (feed && feed !== 'recent-decisions');
  });
  if (!supported.length) return unsupported;
  const loaded = await Promise.all(
    supported.map(async (tab) => ({ tab, works: await read(tab.source, context) })),
  );
  const limit = module.options?.limit ?? 14;
  if (loaded.some(({ works }) => !works.ok || underfilled(works, works.data.length, limit))) return failed;
  const tabs: ZoneShelfTab[] = loaded.flatMap(({ tab, works }) =>
    works.ok && works.data.length
      ? [{ id: tab.id, label: tab.label, items: works.data.slice(0, limit) }]
      : [],
  );
  if (tabs.length) return { state: 'ready', data: { tabs } };
  return empty;
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

/** Supplied transports use the same card enrichment and chart reads as the host. */
export function rankingModuleReads(client: RealmReadClient) {
  return {
    cards: (context: AdaptContext, works: readonly string[]) => realmCards(context, works, client),
    rankings: (realm: string, _locale: UiLocale, interval: 'day' | 'week' | 'month', metric: RankingMetric) =>
      readRankingModuleAnswer(client.main, realm, interval, metric),
  };
}

export async function loadRankingsModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { cards: realmCards, rankings: readRankings },
): Promise<ModuleState<'ranking'>> {
  const metric = chartMetric(module.options?.metric);
  const pages = await Promise.all(intervals.map((interval) =>
    read.rankings(context.realm, context.locale, interval, metric)));
  if (pages.some((page) => !page.ok || underfilled(page.data, page.data.items.length, 10))) return failed;
  const cards = await read.cards(context, pages.flatMap(page => page.ok ? page.data.items.map(item => item.id) : []));
  const tabs = intervals.flatMap((interval, index) => {
    const page = pages[index]!;
    return page.ok && page.data.items.length
      ? [
          {
            interval,
            items: page.data.items.map((item, rank) => {
              const known = cards.get(item.id);
              const work = withRealmCard(zoneWork(item, context, null), known);
              // The thin ranking card has no canonical address or in-Zone decision.
              // Keep the destination of the independently read Work card with its credit.
              return { rank: rank + 1, work: { ...work, href: known?.href ?? work.href } };
            }),
          },
        ]
      : [];
  });
  return tabs.length ? { state: 'ready', data: { metric, tabs } } : empty;
}

export async function loadRisingModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { rising: readRising, cards: realmCards },
): Promise<ModuleState<'rising'>> {
  const page = await read.rising(context.realm, context.locale);
  if (!page.ok) return failed;
  const limit = module.options?.limit ?? 6;
  if (underfilled(page.data, page.data.items.length, limit)) return failed;
  const visible = page.data.items.slice(0, limit);
  const cards = await read.cards(context, visible.map(item => item.id));
  const items = visible
    .map((item) => withRealmCard(zoneWork(item, context, null), cards.get(item.id)));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

/** A feed's Works with their credited authors, as Main's module reads return them. */
async function creditedWorks(
  feed: RealmFeed,
  context: AdaptContext,
): Promise<HomeWindow<{ title: MainName; primaryCredits: readonly ModuleCredit[] }>> {
  const { realm, locale } = context;
  if (feed === 'new-adoptions' || feed === 'recently-completed') {
    const page = await (feed === 'new-adoptions' ? readNewAdoptions : readRecentlyCompleted)(
      realm,
      locale,
    );
    return page.ok ? { ok: true, data: page.data.items, nextCursor: page.data.nextCursor } : page;
  }
  if (feed === 'latest-chapters') {
    const page = await readLatestChapters(realm, locale);
    return page.ok ? { ok: true, data: page.data.items.map((item) => item.work), nextCursor: page.data.nextCursor } : page;
  }
  return { ok: false, failure: 'invalid' };
}

/** People to follow: the authors of the Works a feed brings to this Realm (Books' "Authors to follow"). */
export async function loadPeopleModule(
  module: PresentationModule,
  context: AdaptContext,
  read = creditedWorks,
): Promise<ModuleState<'people'>> {
  const feed = feedOf(module.source);
  if (!feed || feed === 'recent-decisions') return unsupported;
  const works = await read(feed, context);
  if (!works.ok) return failed;
  const limit = module.options?.limit ?? 6;
  const items = zonePeople(works.data, limit);
  if (underfilled(works, items.length, limit)) return failed;
  return items.length ? { state: 'ready', data: { items } } : empty;
}

export async function loadDecisionModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { decisions: readRecentDecisions, works: readRealmWorks },
): Promise<ModuleState<'decision-log'>> {
  const [page, works] = await Promise.all([
    read.decisions(context.realm),
    read.works(context.realm, context.locale),
  ]);
  if (!page.ok) return failed;
  const limit = module.options?.limit ?? 6;
  if (underfilled(page.data, page.data.items.length, limit)) return failed;
  const titled = new Map(
    (works.ok ? works.data.items : []).map((item) => [item.id, zoneWork(item, context, null)]),
  );
  const items = page.data.items
    .slice(0, limit)
    .map((item) => zoneDecision(item, context, titled));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

export async function loadQuoteModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { quotes: readZoneQuotes, cards: realmCards },
  works = readShowcaseWorks,
): Promise<ModuleState<'quote-stream'>> {
  if (module.source.kind !== 'query-block' || module.source.block !== 'reader-quotes')
    return unsupported;
  const page = await read.quotes(context.realm, context.locale);
  if (!page.ok) return failed;
  const limit = module.options?.limit ?? 6;
  if (underfilled(page.data, page.data.items.length, limit)) return failed;
  const visible = page.data.items.slice(0, limit);
  const cards = await completeModuleCards(context, visible.map(item => item.work.id), await read.cards(context, visible.map(item => item.work.id)), works);
  if (!cards) return failed;
  const items = visible.map((item) => ({
    id: item.id,
    body: zoneContentText(item.excerpt),
    reader: item.authorName,
    work: { ...cards.get(item.work.id)!, href: summaryWork(item.work, context).href },
    href: replyHref(context, item.work),
  }));
  return items.length ? { state: 'ready', data: { quotes: items } } : empty;
}

export async function loadDiscussionModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { discussions: readZoneDiscussions, cards: realmCards },
  works = readShowcaseWorks,
): Promise<ModuleState<'discussion-list'>> {
  if (module.source.kind !== 'query-block' || module.source.block !== 'discussions')
    return unsupported;
  const page = await read.discussions(context.realm, context.locale);
  if (!page.ok) return failed;
  const limit = module.options?.limit ?? 8;
  if (underfilled(page.data, page.data.items.length, limit)) return failed;
  const visible = page.data.items.slice(0, limit);
  const cards = await completeModuleCards(context, visible.map(item => item.work.id), await read.cards(context, visible.map(item => item.work.id)), works);
  if (!cards) return failed;
  const items = visible.map((item) => ({
    id: item.id,
    title: zoneContentText(item.excerpt),
    href: replyHref(context, item.work),
    replies: null,
    work: { ...cards.get(item.work.id)!, href: summaryWork(item.work, context).href },
  }));
  return items.length ? { state: 'ready', data: { items } } : empty;
}

export async function loadEditorListsModule(
  module: PresentationModule,
  context: AdaptContext,
  read = { lists: readZoneEditorLists, cards: realmCards, works: readShowcaseWorks },
): Promise<ModuleState<'editorial-list'>> {
  const collections = [module.source, ...(module.tabs ?? []).map((tab) => tab.source)].flatMap(
    (source) => (source.kind === 'collection' ? [source.collection] : []),
  );
  if (!collections.length) return unsupported;
  const page = await read.lists(context.realm, context.locale);
  if (!page.ok) return failed;
  if (page.data.lists.some(list => collections.includes(list.collection) && list.state !== 'complete')) return failed;
  // A list whose Works are all private has nothing to show yet, like an empty module.
  const visible = page.data.lists
    .filter((list) => collections.includes(list.collection) && list.items.length)
    .slice(0, module.options?.limit ?? 2);
  const targets = visible.flatMap(list => list.items.map(item => item.id));
  const cards = await completeModuleCards(context, targets, await read.cards(context, targets), read.works);
  if (!cards) return failed;
  const lists = visible.map((list) => {
    // A Collection the Zone mounts opens as its own page, and its members open under that mount.
    const mount = context.mounts?.get(list.collection) ?? null;
    return {
      id: list.collection,
      title: zoneText(list.name),
      blurb: null,
      href: mount && !context.unrouted ? spaceHref(context.ref, 'site', [mount]) : null,
      items: list.items.map((item) =>
        ({ ...cards.get(item.id)!, href: summaryWork(item, context, mount).href }),
      ),
    };
  });
  return lists.length ? { state: 'ready', data: { lists } } : empty;
}

export async function loadGenreModule(
  module: PresentationModule,
  context: AdaptContext,
  readPage = readZoneGenres,
): Promise<ModuleState<'chip-nav'>> {
  if (module.source.kind !== 'context') return unsupported;
  const contextId = idOf(module.source.context);
  if (!contextId) return unsupported;
  const read = await readPage(context.realm, contextId, context.locale);
  if (!read.ok) return failed;
  const limit = module.options?.limit ?? 12;
  if (underfilled(read.data, read.data.items.length, limit)) return failed;
  // Each chip opens the Zone's own browse page filtered by its Concept (the `concept` Facet).
  const chips = read.data.items
    .map((item) => ({
      id: item.id,
      label: zoneText(item.name),
      href: chipHref(realmHref(context.locale, context.ref, 'browse'), 'concept', item.concept),
    }))
    .slice(0, limit);
  return chips.length ? { state: 'ready', data: { chips } } : empty;
}

async function load(
  module: PresentationModule,
  presentation: ZonePresentation,
  context: AdaptContext,
  slideMedia: ZonePresentationRead['slideMedia'],
): Promise<ModuleState> {
  switch (module.type) {
    case 'hero-carousel':
      return loadHeroModule(module, presentation, context, slideMedia);
    case 'shelf':
      return loadShelfModule(module, context);
    case 'decision-log':
      return loadDecisionModule(module, context);
    case 'quote-stream':
      return loadQuoteModule(module, context);
    case 'discussion-list':
      return loadDiscussionModule(module, context);
    case 'editorial-list':
      return loadEditorListsModule(module, context);
    case 'chip-nav':
      return loadGenreModule(module, context);
    case 'ranking':
      return loadRankingsModule(module, context);
    case 'rising':
      return loadRisingModule(module, context);
    case 'people':
      return loadPeopleModule(module, context);
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
export function moduleMoreHref(module: PresentationModule, context: AdaptContext): string | null {
  const { locale, ref } = context;
  if (module.type === 'shelf' && module.source.kind === 'collection') {
    const mount = context.mounts?.get(module.source.collection);
    return mount ? siteHref(locale, ref, [mount]) : null;
  }
  if (module.type === 'decision-log') return realmHref(locale, ref, 'decisions');
  if (module.type === 'shelf') return realmHref(locale, ref, 'browse');
  return null;
}

/** The metadata of the images the heroes draw, first slide first, read before the page renders (see `readShowcaseImages`). */
export function readHeroImages(modules: readonly PlacedModule[], locale: string, read = readShowcaseImages) {
  const heroes = modules.filter((placed): placed is Extract<PlacedModule, { module: { type: 'hero-carousel' } }> =>
    placed.module.type === 'hero-carousel');
  return read(heroes.flatMap(hero => hero.state.state === 'ready'
    ? hero.state.data.slides.slice(0, 5).flatMap(slide => slideImageUrls(slide, locale)) : []));
}

/** A Zone home's modules and their hero images' metadata, so its first slide is in the server's HTML. */
export async function loadHomeModules(
  presentation: ZonePresentation,
  context: PublishedHomeContext,
  slideMedia: ZonePresentationRead['slideMedia'] = [],
) {
  if (context.publishedHome) return loadPublishedHomeModules(context.publishedHome, presentation, context, {
    publicModules: loadModules, summaries: readShowcaseWorks, work: zoneWork, context: showcaseContext,
    more: moduleMoreHref, enrich: enrichShowcaseModules, images: readHeroImages,
  });
  const modules = await loadModules(presentation, context, slideMedia);
  return { modules, images: await readHeroImages(modules, context.locale) };
}

export async function loadModules(
  presentation: ZonePresentation,
  context: AdaptContext,
  slideMedia: ZonePresentationRead['slideMedia'] = [],
): Promise<PlacedModule[]> {
  const loaded = await Promise.all(
    presentation.modules.map(
      async (module) =>
        ({
          module: placedModule(module, moduleMoreHref(module, context)),
          state: await load(module, presentation, context, slideMedia),
        }) as PlacedModule,
    ),
  );
  return enrichShowcaseModules(loaded, context);
}
