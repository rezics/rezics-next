import type { RankingInterval, RankingMetric, ZoneModule, ZoneModuleType, ZonePreset, ZoneTokens }
  from '@rezics/zone-sdk';

// A Zone's presentation as the web renders it: the shape of Main's
// `zone-presentation-v1` document (services/main/src/modules/zone/presentation-format.ts).
// The Realm adapter assigns Main's typed read to these types, so a contract
// change breaks the build there.

/** Main's presets (`ZONE_PRESETS`); a test keeps them identical. Choosing a preset copies its tokens. */
export const presetTokens: Record<ZonePreset, ZoneTokens> = {
  clean: { colorScheme: 'system', accent: '#2563eb', density: 'comfortable', cardRadius: 'md',
    headingFontScale: 'md', surfaceTint: 'none', fontPairing: 'sans', pageSurface: 'flat', coverStyle: 'portrait' },
  editorial: { colorScheme: 'light', accent: '#a16207', density: 'comfortable', cardRadius: 'sm',
    headingFontScale: 'lg', surfaceTint: 'subtle', fontPairing: 'serif', pageSurface: 'cards', coverStyle: 'portrait' },
  vibrant: { colorScheme: 'dark', accent: '#7c3aed', density: 'comfortable', cardRadius: 'lg',
    headingFontScale: 'lg', surfaceTint: 'accent', fontPairing: 'rounded', pageSurface: 'cards', coverStyle: 'square' },
  serial: { colorScheme: 'light', accent: '#ff8674', density: 'compact', cardRadius: 'sm',
    headingFontScale: 'lg', surfaceTint: 'subtle', fontPairing: 'sans', pageSurface: 'cards', coverStyle: 'portrait' },
};

/** Where a module's items come from. */
export type ModuleSource =
  | { kind: 'query-block'; block: string }
  | { kind: 'collection'; collection: string }
  | { kind: 'context'; context: string };

export interface PresentationModule {
  id: string;
  type: ZoneModuleType;
  title: string;
  source: ModuleSource;
  tabs?: { id: string; label: string; source: ModuleSource }[];
  options?: { layout?: 'covers' | 'rows'; shuffle?: boolean; rail?: boolean; limit?: number;
    metric?: RankingMetric; interval?: RankingInterval };
}

export interface PresentationBanner {
  id: string; title: string; alt: string;
  /** A media resource's native IRI. */
  image: string;
  href: string; startsAt?: string; endsAt?: string;
}

export interface ZonePresentation {
  profile: 'zone-presentation-v1';
  preset: ZonePreset;
  tokens: ZoneTokens;
  navigation: { label: string; href: string }[];
  banners: PresentationBanner[];
  modules: PresentationModule[];
}

/**
 * Why an official package does not run for this view. Main reports the
 * approval states; the web adds what only it can know about its own build.
 */
export type FallbackReason =
  | 'safe-mode' | 'viewer-opt-out' | 'none-approved' | 'global-disabled' | 'revoked' | 'expired'
  /** Main approved different bytes than this build carries. */
  | 'digest-mismatch'
  /** This build has no package for the approved Zone. */
  | 'not-installed'
  | 'load-failed';

/** Main's report on a Zone's official package, as the Realm adapter reads it. */
export interface MainExecution {
  /** The digest of the package bytes with an active approval for this Zone, or null. */
  approved: { digest: string } | null;
  /** Main's reason when nothing is approved. */
  reason: FallbackReason;
}

/**
 * Sources Main serves as Realm module reads (`/v1/realms/{realm}/modules/*`).
 * A presentation names them as query-block sources; any other source waits
 * for its read and leaves its module off the page.
 */
export const realmFeeds = ['new-adoptions', 'latest-chapters', 'recently-completed', 'recent-decisions'] as const;
export type RealmFeed = (typeof realmFeeds)[number];

export function feedOf(source: ModuleSource): RealmFeed | null {
  return source.kind === 'query-block' && (realmFeeds as readonly string[]).includes(source.block)
    ? source.block as RealmFeed : null;
}

const feed = (block: RealmFeed): ModuleSource => ({ kind: 'query-block', block });

/** The default layout's module titles, in the reader's language. */
export interface DefaultTitles {
  picks: string; latest: string; newChapters: string; newlyAdded: string; recentlyCompleted: string;
  rankings: string; quotes: string; rising: string; decisions: string;
}

/**
 * The layout a Zone gets until its moderators choose one, and every Realm
 * without a Zone: picks up top, what is new, what readers read and what the
 * Realm decided. Charts and rising read Main's rankings by module type; reader
 * quotes have no read yet and stay off the page.
 */
export function defaultPresentation(titles: DefaultTitles, preset: ZonePreset = 'clean'): ZonePresentation {
  return {
    profile: 'zone-presentation-v1', preset, tokens: presetTokens[preset], navigation: [], banners: [],
    modules: [
      { id: 'picks', type: 'hero-carousel', title: titles.picks, source: feed('new-adoptions') },
      { id: 'latest', type: 'shelf', title: titles.latest, source: feed('latest-chapters'),
        tabs: [{ id: 'chapters', label: titles.newChapters, source: feed('latest-chapters') },
          { id: 'adopted', label: titles.newlyAdded, source: feed('new-adoptions') },
          { id: 'completed', label: titles.recentlyCompleted, source: feed('recently-completed') }] },
      { id: 'rankings', type: 'ranking', title: titles.rankings, source: { kind: 'query-block', block: 'rankings' },
        options: { metric: 'reads', interval: 'week' } },
      { id: 'quotes', type: 'quote-stream', title: titles.quotes,
        source: { kind: 'query-block', block: 'reader-quotes' } },
      { id: 'rising', type: 'rising', title: titles.rising, source: { kind: 'query-block', block: 'rising' },
        options: { rail: true } },
      { id: 'decisions', type: 'decision-log', title: titles.decisions, source: feed('recent-decisions'),
        options: { rail: true } },
    ],
  };
}

/** A stored module as the renderer places it. */
export function placedModule(module: PresentationModule, more: string | null): ZoneModule {
  return { id: module.id, type: module.type, title: module.title, rail: module.options?.rail ?? false,
    layout: module.options?.layout ?? 'covers', shuffle: module.options?.shuffle ?? false, more };
}
