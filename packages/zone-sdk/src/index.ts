import type { ComponentType, ReactNode } from 'react';

/*
 * The contract between the REZICS web app and a Zone's presentation: the
 * theme tokens and module types every Zone uses, the public data modules
 * render, and the named slots through which an official Zone package (reviewed
 * first-party code in `apps/web/zones/official/<slug>/`) enhances the page.
 *
 * A package receives data the platform already fetched and renders into
 * slots; it fetches nothing, reads no cookies, storage or credentials and never hides
 * platform chrome (the account menu, the Zone menu, "Why here?" links, report
 * and age gates stay outside the slots). Every slot also receives `fallback`,
 * the platform's own rendering, which a package may wrap or replace.
 */

/** Presets a Zone starts from; choosing one copies its tokens into the Zone. */
export const zonePresets = ['clean', 'editorial', 'vibrant', 'serial'] as const;
export type ZonePreset = (typeof zonePresets)[number];

/** Presentation tokens (Main's `zone-presentation-v1`). */
export interface ZoneTokens {
  /**
   * The scheme the Zone was designed for. `dark` darkens the Zone for readers
   * whose display mode follows the system; a reader's explicit light or dark
   * choice always wins, and a Zone never forces light on a dark system.
   */
  colorScheme: 'system' | 'light' | 'dark';
  /** `#rrggbb`. Text-bearing tones are derived from it to pass WCAG AA. */
  accent: string;
  density: 'compact' | 'comfortable';
  cardRadius: 'sm' | 'md' | 'lg';
  headingFontScale: 'md' | 'lg';
  surfaceTint: 'none' | 'subtle' | 'accent';
  fontPairing: 'sans' | 'serif' | 'rounded';
  /** `cards` sets modules as panels on a tinted page, `flat` on the page itself. */
  pageSurface: 'flat' | 'cards';
  coverStyle: 'portrait' | 'square' | 'landscape';
}

/** Editorial modules, in Main's vocabulary. */
export const zoneModuleTypes = ['hero-carousel', 'chip-nav', 'announcement', 'shelf', 'ranking',
  'editorial-list', 'quote-stream', 'rising', 'decision-log', 'discussion-list', 'people'] as const;
export type ZoneModuleType = (typeof zoneModuleTypes)[number];

export type RankingInterval = 'day' | 'week' | 'month';
export type RankingMetric = 'reads' | 'finished-chapters';

/** Text in the language Main returned it in. */
export interface ZoneText { value: string; lang: string; dir: 'ltr' | 'rtl' }

/** An image Main serves; `url` is already a path the browser can load. */
export interface ZoneImage { url: string; width: number; height: number }

/** A Work as every module shows it: the cover is the card. */
export interface ZoneWork {
  /** Native IRI. */
  id: string;
  href: string;
  title: ZoneText | null;
  cover: ZoneImage | null;
  /** What kind of object a generated cover imitates. */
  kind: 'book' | 'document' | 'recipe' | 'package';
  author: ZoneText | null;
  /** The one-line hook shown under the cover, separate from the synopsis. */
  tagline: ZoneText | null;
  status: 'ongoing' | 'completed' | 'hiatus' | null;
  chapters: number | null;
  words: number | null;
  /** ISO date-time of the last published chapter or revision. */
  updatedAt: string | null;
  /** The newest chapter, for latest-update modules. */
  latestChapter?: { title: ZoneText | null; href: string; at: string | null } | null;
  /** The public Decision that placed the Work in this Zone ("Why here?"). */
  decision: string | null;
}

export interface ZoneBanner {
  id: string;
  title: ZoneText;
  kicker?: ZoneText | null;
  href: string;
  image: ZoneImage | null;
  /** A banner built from a pick when the Zone has no art-directed banner. */
  work?: ZoneWork | null;
}

export interface ZoneChip { id: string; label: ZoneText; href: string }
export interface ZoneShelfTab { id: string; label: string; items: ZoneWork[] }
export interface ZoneRankedWork { rank: number; work: ZoneWork }
export interface ZoneRankingTab { interval: RankingInterval; items: ZoneRankedWork[] }
export interface ZoneList { id: string; title: ZoneText; blurb: ZoneText | null; href: string | null; items: ZoneWork[] }
export interface ZoneQuote { id: string; body: ZoneText; reader: string; work: ZoneWork; href: string }
export interface ZoneDecision {
  id: string;
  kind: 'adoption' | 'classification' | 'semantic-rule-change';
  outcome: 'accepted' | 'rejected' | null;
  /** The Work it concerns, when Main named one this page could title. */
  work: Pick<ZoneWork, 'id' | 'href' | 'title'> | null;
  href: string;
  /** Position in the public log; newer decisions sort first. */
  sequence: string;
}
export interface ZoneDiscussion { id: string; title: ZoneText; href: string; replies: number | null; work: ZoneWork | null }
export interface ZonePerson { id: string; name: ZoneText; href: string; avatar: ZoneImage | null; note: ZoneText | null }

/** What each module type renders. */
export interface ZoneModuleData {
  'hero-carousel': { banners: ZoneBanner[] };
  'chip-nav': { chips: ZoneChip[] };
  announcement: { text: ZoneText; href: string | null };
  shelf: { tabs: ZoneShelfTab[] };
  ranking: { metric: RankingMetric; tabs: ZoneRankingTab[] };
  'editorial-list': { lists: ZoneList[] };
  'quote-stream': { quotes: ZoneQuote[] };
  rising: { items: ZoneWork[] };
  'decision-log': { items: ZoneDecision[] };
  'discussion-list': { items: ZoneDiscussion[] };
  people: { items: ZonePerson[] };
}

/** A module as the Zone's layout places it. */
export interface ZoneModule<Type extends ZoneModuleType = ZoneModuleType> {
  id: string;
  type: Type;
  /** The Zone's own words for it ("Can't-miss picks"). */
  title: string;
  /** Beside the main column on wide screens; inline on phones. */
  rail: boolean;
  layout: 'covers' | 'rows';
  shuffle: boolean;
  /** Where "More" leads. */
  more: string | null;
}

/** What every slot knows about the Zone it renders in. */
export interface ZoneContext {
  /** The official route segment, or null for a community Zone. */
  slug: string | null;
  /** The Realm's native IRI. */
  realm: string;
  name: ZoneText;
  description: ZoneText | null;
  icon: ZoneImage | null;
  hero: ZoneImage | null;
  tokens: ZoneTokens;
  /** The interface locale (`en`, `zh-Hans`, ...). */
  locale: string;
  links: { home: string; works: string; discussions: string; decisions: string; about: string };
}

export interface ZoneSlotProps { zone: ZoneContext; fallback: ReactNode }
export interface HeaderSlotProps extends ZoneSlotProps {
  /** Platform controls (follow, the Zone menu) the header must show. */
  actions: ReactNode;
  members: string | null;
}
export interface HeroSlotProps extends ZoneSlotProps { banners: ZoneBanner[] }
/** A cover tile, a row with a small cover, or a one-line rail row. */
export type ZoneCardLayout = 'cover' | 'row' | 'rail';

/** How a module asks for a card: its layout, chart position and the row's tallest cover proportion. */
export interface ZoneCardOptions { layout?: ZoneCardLayout; rank?: number; slot?: number }

export interface WorkCardSlotProps extends ZoneSlotProps {
  work: ZoneWork;
  layout: ZoneCardLayout;
  rank?: number;
}
export interface ModuleSlotProps<Type extends ZoneModuleType> extends ZoneSlotProps {
  module: ZoneModule<Type>;
  data: ZoneModuleData[Type];
  /** Renders a Work with the platform card (and the package's `workCard` slot). */
  card: (work: ZoneWork, options?: ZoneCardOptions) => ReactNode;
}

/** The slots a package may fill; an empty slot keeps the platform rendering. */
export interface ZoneSlots {
  header?: ComponentType<HeaderSlotProps>;
  hero?: ComponentType<HeroSlotProps>;
  workCard?: ComponentType<WorkCardSlotProps>;
  footer?: ComponentType<ZoneSlotProps>;
  modules?: { [Type in ZoneModuleType]?: ComponentType<ModuleSlotProps<Type>> };
}

export interface ZonePackage {
  /** The official Zone's route segment (`fiction` for `/r/fiction`). */
  slug: string;
  /**
   * The package stylesheet. Write it as `@layer zone { @scope ([data-zone="<slug>"]) { … } }`
   * so it styles only this Zone's content box.
   */
  css: string;
  slots: ZoneSlots;
}

export function defineZonePackage<const Package extends ZonePackage>(pkg: Package): Package {
  return pkg;
}

/** Gzipped size limits per package (docs/plan/frontend.md, "Zones"). */
export const ZONE_PACKAGE_BUDGET = { cssGzipBytes: 40 * 1024, jsGzipBytes: 50 * 1024 } as const;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * The digest an operator approves: SHA-256 over the sorted `path NUL sha256(content)`
 * lines of every file in the package directory. The web runs a package only while
 * Main reports an active approval of exactly this digest; any byte change needs a
 * new approval.
 */
export async function packageDigest(files: Readonly<Record<string, string>>): Promise<string> {
  const encoder = new TextEncoder();
  const lines = await Promise.all(Object.keys(files).sort().map(async path =>
    `${path}\u0000${hex(await crypto.subtle.digest('SHA-256', encoder.encode(files[path])))}\n`));
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', encoder.encode(lines.join(''))))}`;
}
