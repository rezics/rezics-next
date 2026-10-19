import type { ZoneShelfTab, ZoneWork } from '@rezics/zone-sdk';
import type { readShowcaseWorks, ShowcaseWork } from '../api/showcase.ts';
import { resourceHref } from '../address/path.ts';
import { liveSlides, presentationSlide, type AdaptContext, type zoneWork } from '../realm/adapt.ts';
import type { enrichShowcaseModules, loadModules, moduleMoreHref, readHeroImages, showcaseContext } from '../realm/modules.ts';
import { siteHref } from '../realm/route.ts';
import { zoneContentText } from '../language/untagged.ts';
import { placedModule, type ModuleSource, type PresentationModule, type ZonePresentation } from '../zones/presentation.ts';
import type { ModuleState, PlacedModule } from '../zones/zone-home.tsx';
import type { ZoneAuthoringPreview } from './read.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { moduleTitle } from '../zones/presentation.ts';
import type { ZoneHomePage } from './home-document.tsx';

type SavedSource = NonNullable<ZoneAuthoringPreview['page']>['showcases'][number]['sources'][number];
type SavedModule = { id: string; sources: SavedSource[] };
type WorkRead = { ok: true; works: ZoneWork[] } | { ok: false };
const failed = { state: 'failed' } as const;
const empty = { state: 'empty' } as const;

export interface PreviewModuleReaders {
  publicModules: typeof loadModules;
  summaries: typeof readShowcaseWorks;
  work: typeof zoneWork;
  context: typeof showcaseContext;
  more: typeof moduleMoreHref;
  enrich: typeof enrichShowcaseModules;
  images: typeof readHeroImages;
}

export type HomeSourceSelection = Pick<ZonePresentationRead, 'moduleData' | 'slideMedia'>;
export interface PublishedHomeContext extends AdaptContext {
  /** Resolved membership from the same public response as the home's layout. */
  publishedHome?: HomeSourceSelection;
}

/** Public and saved reads retain their own resolved sources through the same adapter. */
export function loadPublishedHomeModules(selection: HomeSourceSelection, presentation: ZonePresentation,
  context: AdaptContext, read: PreviewModuleReaders) {
  return loadPreviewHomeModules(selection, presentation, context, read);
}

/** A default Showcase has slides even when no presentation module was authored. */
export async function loadDocumentHomeModules(page: ZoneHomePage | null, selection: HomeSourceSelection,
  presentation: ZonePresentation, context: AdaptContext, read: PreviewModuleReaders, defaultTitle: string) {
  const loaded = await loadPreviewHomeModules(selection, presentation, context, read);
  const representedShowcases = (page?.showcases ?? []).flatMap(showcase => showcase.module
    && loaded.modules.some(item => item.module.id === showcase.module!.id && item.state.state === 'ready') ? [showcase.id] : []);
  const defaultShowcase = page?.showcases?.find(showcase => showcase.id === '$default' && showcase.module === null);
  if (!defaultShowcase || !page?.showcaseData) return { ...loaded, representedShowcases };
  const source = { kind: 'query-block' as const, block: 'document-default' };
  const module: PresentationModule = { id: '$default', type: 'hero-carousel', title: defaultTitle, source };
  const resolved = await loadPreviewHomeModules({
    moduleData: [{ id: module.id, sources: [{ source, state: 'complete', members: [] }] }],
    slideMedia: defaultShowcase.slideMedia ?? page.showcaseData.slideMedia,
  }, { ...presentation, modules: [module], slides: defaultShowcase.slides ?? page.showcaseData.slides }, context, read);
  const hero = resolved.modules[0];
  if (!hero || hero.state.state !== 'ready') return {
    ...loaded, modules: hero?.state.state === 'failed' ? [hero, ...loaded.modules] : loaded.modules,
    images: { ...loaded.images, ...resolved.images }, representedShowcases,
  };
  const heroData = hero.state.state === 'ready' ? JSON.stringify(hero.state.data) : null;
  const duplicate = heroData !== null && loaded.modules.some(item => item.module.type === 'hero-carousel'
    && item.state.state === 'ready' && JSON.stringify(item.state.data) === heroData);
  return { modules: duplicate ? loaded.modules : [hero, ...loaded.modules],
    images: { ...loaded.images, ...resolved.images }, representedShowcases: [...representedShowcases, defaultShowcase.id] };
}

/** Saved membership comes only from Main's authorized producer. Public reads
 * supply public Work cards and sources Main explicitly delegates to them. */
export async function loadPreviewHomeModules(preview: Pick<ZoneAuthoringPreview, 'moduleData' | 'slideMedia'>, presentation: ZonePresentation,
  context: AdaptContext, read: PreviewModuleReaders) {
  const data = preview.moduleData.filter(isSavedModule);
  const summaries = async (targets: string[]) => {
    const wanted = [...new Set(targets)];
    const batches = [];
    for (let offset = 0; offset < wanted.length; offset += 64) {
      batches.push(read.summaries(wanted.slice(offset, offset + 64), read.context(context)));
    }
    return new Map((await Promise.all(batches)).flatMap(batch => [...batch]));
  };
  const sourceOf = (module: PresentationModule, source: ModuleSource) =>
    data.find(item => item.id === module.id)?.sources.find(item => sameSource(item.source, source));
  const publicModule = async (module: PresentationModule): Promise<ModuleState> =>
    (await read.publicModules({ ...presentation, modules: [module] }, context, preview.slideMedia))[0]?.state ?? failed;
  const summaryCard = (item: ShowcaseWork, mount: string | null = null): ZoneWork => {
    const address = item.address;
    const work = read.work(item, context, null, mount);
    // A public summary supplies no site membership; a selected Collection
    // and its mount are the only route witness in this saved source contract.
    return mount ? work : { ...work, href: resourceHref('/w/', address) };
  };

  const cache = new Map<SavedSource, Promise<WorkRead>>();
  const worksOf = (module: PresentationModule, source: ModuleSource): Promise<WorkRead> => {
    const saved = sourceOf(module, source);
    if (!saved) return Promise.resolve({ ok: false });
    const previous = cache.get(saved);
    if (previous) return previous;
    const pending = (async (): Promise<WorkRead> => {
      if (saved.state === 'public-read') {
        const loaded = await publicModule({ ...module, type: 'shelf', source, tabs: undefined });
        if (loaded.state === 'empty') return { ok: true, works: [] };
        if (loaded.state !== 'ready' || !('tabs' in loaded.data)) return { ok: false };
        return { ok: true, works: (loaded.data.tabs as ZoneShelfTab[]).flatMap(tab => tab.items) };
      }
      // Partial/skipped/unavailable data has no continuation contract. Keep a
      // visible failed region rather than present a partial cut as complete.
      if (saved.state !== 'complete') return { ok: false };
      const limit = module.type === 'hero-carousel' ? Math.min(5, module.options?.limit ?? 5)
        : module.options?.limit ?? (module.type === 'rising' ? 6 : 14);
      const targets = saved.members.slice(0, limit).map(item => item.work);
      const cards = await summaries(targets);
      if (targets.some(target => !cards.has(target))) return { ok: false };
      const mount = source.kind === 'collection' ? context.mounts?.get(source.collection) ?? null : null;
      return { ok: true, works: targets.map(target => summaryCard(cards.get(target)!, mount)) };
    })();
    cache.set(saved, pending);
    return pending;
  };

  const load = async (module: PresentationModule): Promise<ModuleState> => {
    if (module.type === 'announcement') {
      return { state: 'ready', data: { text: zoneContentText(module.title), href: null } };
    }
    if (module.type === 'hero-carousel') {
      const scheduled = liveSlides(presentation.slides, Date.now()).slice(0, 5);
      if (scheduled.length) {
        const targets = scheduled.flatMap(slide => 'work' in slide ? [slide.work] : []);
        const cards = await summaries(targets);
        if (targets.some(target => !cards.has(target))) return failed;
        const slides = scheduled.flatMap(slide => {
          const item = 'work' in slide ? cards.get(slide.work) : null;
          const work = item ? summaryCard(item) : null;
          const adapted = presentationSlide(slide, work, context, preview.slideMedia);
          return adapted ? [adapted] : [];
        });
        return slides.length ? { state: 'ready', data: { slides } } : empty;
      }
      const source = sourceOf(module, module.source);
      if (source?.state === 'public-read') return publicModule(module);
      const works = await worksOf(module, module.source);
      if (!works.ok) return failed;
      const slides = works.works.slice(0, Math.min(5, module.options?.limit ?? 5)).map(work => ({
        id: work.id, title: work.title ?? zoneContentText(''), href: work.href, work, tagline: work.tagline,
      }));
      return slides.length ? { state: 'ready', data: { slides } } : empty;
    }
    if (module.type === 'shelf') {
      const selected = module.tabs ?? [{ id: module.id, label: module.title, source: module.source }];
      const loaded = await Promise.all(selected.map(async tab => ({ tab, read: await worksOf(module, tab.source) })));
      if (loaded.some(item => !item.read.ok)) return failed;
      const tabs = loaded.flatMap(({ tab, read: result }) => result.ok && result.works.length
        ? [{ id: tab.id, label: tab.label, items: result.works.slice(0, module.options?.limit ?? 14) }] : []);
      return tabs.length ? { state: 'ready', data: { tabs } } : empty;
    }
    if (module.type === 'editorial-list') {
      const selected = module.tabs ?? [{ id: module.id, label: module.title, source: module.source }];
      const loaded = await Promise.all(selected.map(async tab => ({ tab, read: await worksOf(module, tab.source) })));
      if (loaded.some(item => !item.read.ok)) return failed;
      const lists = loaded.flatMap(({ tab, read: result }) => {
        if (!result.ok || !result.works.length) return [];
        const mount = tab.source.kind === 'collection' ? context.mounts?.get(tab.source.collection) : null;
        return [{ id: tab.id, title: zoneContentText(tab.label), blurb: null,
          href: mount ? siteHref(context.locale, context.ref, [mount]) : null,
          items: result.works.slice(0, module.options?.limit ?? 14) }];
      });
      return lists.length ? { state: 'ready', data: { lists } } : empty;
    }
    const source = sourceOf(module, module.source);
    if (source?.state === 'public-read' || source?.state === 'reference' && module.source.kind === 'context') return publicModule(module);
    if (module.type === 'rising') {
      const works = await worksOf(module, module.source);
      if (!works.ok) return failed;
      const items = works.works.slice(0, module.options?.limit ?? 6);
      return items.length ? { state: 'ready', data: { items } } : empty;
    }
    return failed;
  };

  const loaded = await Promise.all(presentation.modules.map(async module => {
    return { module: placedModule(module, read.more(module, context)),
      state: await load(module) } as PlacedModule;
  }));
  const modules = await read.enrich(loaded, context);
  return { modules, images: await read.images(modules, context.locale) };
}

export function localizedHomePresentation(presentation: ZonePresentationRead['presentation'], locale: UiLocale): ZonePresentation {
  return { ...presentation, modules: presentation.modules.map(({ titles, tabs, ...module }) => ({
    ...module, title: moduleTitle({ title: module.title, titles }, locale),
    ...(tabs ? { tabs: tabs.map(({ labels, ...tab }) => ({ ...tab, label: labels?.[locale] ?? tab.label })) } : {}),
  })) };
}

function isSavedModule(value: unknown): value is SavedModule {
  if (!record(value) || typeof value.id !== 'string' || !Array.isArray(value.sources)) return false;
  return value.sources.every((item: unknown) => {
    if (!record(item) || !record(item.source) || typeof item.state !== 'string' || !Array.isArray(item.members)) return false;
    const source = item.source;
    if (!(source.kind === 'collection' && typeof source.collection === 'string')
      && !(source.kind === 'query-block' && typeof source.block === 'string')
      && !(source.kind === 'context' && typeof source.context === 'string')) return false;
    return item.members.every((member: unknown) => record(member)
      && typeof member.work === 'string' && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(member.work));
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameSource(left: ModuleSource, right: ModuleSource) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'collection' && right.kind === 'collection') return left.collection === right.collection;
  if (left.kind === 'query-block' && right.kind === 'query-block') return left.block === right.block;
  return left.kind === 'context' && right.kind === 'context' && left.context === right.context;
}
