import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react';

/*
 * The contract between the REZICS web app and a Zone's presentation: the
 * theme tokens and module types every Zone uses, the public data modules
 * render, and the named slots through which an official Zone package (reviewed
 * first-party code in `apps/web/zones/official/<slug>/`) enhances the page.
 *
 * A package receives data the platform already fetched and renders into
 * slots; it fetches nothing, reads no cookies, storage or credentials and never hides
 * platform chrome (the account menu, the Zone menu, report and age gates stay
 * outside the slots, and every Work keeps its "Why here?" stamp, which the
 * platform renders). Every slot also receives `fallback`, the platform's own
 * rendering, which a package may wrap or replace.
 */

/** Presets a Zone starts from; choosing one copies its tokens into the Zone. */
export const zonePresets = ['clean', 'editorial', 'vibrant', 'serial'] as const;
export type ZonePreset = (typeof zonePresets)[number];

/**
 * Presentation tokens (Main's `zone-presentation-v1`). Zones share REZICS's visual
 * language: the platform applies their structure (density, panels) and keeps their
 * colour, scheme and type tokens for a Zone that asks for its own look.
 */
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
  kind: 'book' | 'document' | 'recipe' | 'package' | 'game';
  author: ZoneText | null;
  /** Destination for the credited author when Main identifies one. */
  authorHref?: string | null;
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
  /** A published prompt or Skill's card, when the Work is one. */
  hub?: ZoneHubItem | null;
}

/** One release of a Work that met every condition of the release filter, with the facts a card states. */
export interface ZoneMatchedRelease {
  /** Native IRI of the release. */
  id: string;
  /** The language tag the release's matched text is in (`en`, `zh-Hant`). */
  language: string | null;
  platform: string | null;
  completeness: 'complete' | 'partial' | 'trial' | 'unknown';
  /** `official`, or `unofficial` for a fan or community release. */
  origin: 'official' | 'unofficial';
  /** Translators credited on the realization the release carries in `language`; empty when none is recorded. */
  translators: ZoneText[];
}

/**
 * The releases Main named for a Work on a release-filtered browse page (at most eight). A card shows
 * exactly these and never infers a release from a title or a language.
 */
export interface ZoneReleaseMatches {
  releases: ZoneMatchedRelease[];
  /** More releases satisfy the filter than `releases` lists. */
  more: boolean;
}

/** A published prompt or Skill, as its author disclosed it. */
export interface ZoneHubItem {
  kind: 'prompt' | 'skill';
  /** A short excerpt (at most 240 characters): the prompt's opening, or the Skill's description. */
  preview: ZoneText;
  /** Exactly the published text a reader copies: the prompt, or the Skill's instructions. */
  copyText: string;
  /** Models the item was tested with; empty when none are recorded. */
  testedModels: string[];
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
  /** The Realm's native IRI, or null for a site with no community capability. */
  realm: string | null;
  name: ZoneText;
  description: ZoneText | null;
  icon: ZoneImage | null;
  hero: ZoneImage | null;
  tokens: ZoneTokens;
  /** The interface locale (`en`, `zh-Hans`, ...). */
  locale: string;
  links: { home: string; browse: string; works: string; discussions: string; decisions: string; about: string };
}

/** A value the Zone can be filtered by, as a link into its browse page with that one Condition. */
export interface ZoneFilterChip {
  /** The Facet it filters by (`concept`, `status`). */
  facet: string;
  value: string;
  label: ZoneText;
  /** How many of the Zone's newest picks it matches. */
  count: number;
  href: string;
}

/** What a Zone's home leads with: its search and the filters Main measures, grouped by Facet. */
export interface ZoneBrowseEntry {
  /** The browse page; the search form submits its text there as `q`. */
  href: string;
  /** The search field's accessible name and placeholder, in the reader's language. */
  searchLabel: string;
  placeholder: string;
  /** Conditions the home search form keeps while the text changes. */
  kept?: { name: string; value: string }[];
  groups: { facet: string; label: string; chips: ZoneFilterChip[] }[];
}

/** What the platform's link takes: an anchor whose `href` is a path or URL. */
export type ZoneLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string };

export interface ZoneSlotProps {
  zone: ZoneContext;
  fallback: ReactNode;
  /**
   * The platform's page link. Paths the platform passes (`work.href`,
   * `chip.href`) may lack the interface locale; this link keeps the reader
   * in it and navigates within the app. Use it for every link to a page.
   */
  Link: ComponentType<ZoneLinkProps>;
}
export interface HeaderSlotProps extends ZoneSlotProps {
  /** Platform controls (follow, the Zone menu) the header must show. */
  actions: ReactNode;
  members: string | null;
}
/** A cover tile, a row with a small cover, or a one-line rail row. */
export type ZoneCardLayout = 'cover' | 'row' | 'rail';

/** How a module asks for a card: its layout, chart position and the row's tallest cover proportion. */
export interface ZoneCardOptions {
  layout?: ZoneCardLayout; rank?: number; slot?: number;
  /** Present on a release-filtered browse page: the releases that matched the reader's filter. */
  matches?: ZoneReleaseMatches;
}

export interface WorkCardSlotProps extends ZoneSlotProps {
  work: ZoneWork;
  layout: ZoneCardLayout;
  rank?: number;
  /** The releases that matched the reader's release filter, when the card is a filtered result. */
  matches?: ZoneReleaseMatches;
  /**
   * The signed-in reader's next volume of this Work when it is a series, in the language they chose, as
   * Main reports it; draws nothing signed out or for any other Work. A package places it where it likes.
   */
  nextVolume: ReactNode;
}
/** How a slot that sets out Works shows them, so every pick keeps its author and "Why here?" stamp. */
export interface ZoneWorkRenderers {
  /** Renders a Work with the platform card (and the package's `workCard` slot). */
  card: (work: ZoneWork, options?: ZoneCardOptions) => ReactNode;
  /**
   * The platform's "Why here?" stamp, for a Work the slot sets out itself
   * instead of through `card`; nothing when the Work has no Decision. Show it
   * beside every such Work: a Zone design may restyle a pick but never hide
   * why it is in the Zone.
   */
  whyHere: (work: Pick<ZoneWork, 'title' | 'decision'>) => ReactNode;
  /**
   * "Continue your series" for the Works given: the series the signed-in reader has started, each with
   * its next volume as Main reports it. Draws nothing signed out or when none has been started.
   */
  nextVolumes: (works: readonly Pick<ZoneWork, 'id' | 'href' | 'title'>[], heading: string) => ReactNode;
}
export interface HeroSlotProps extends ZoneSlotProps, ZoneWorkRenderers { banners: ZoneBanner[] }
export interface BrowseBarSlotProps extends ZoneSlotProps { browse: ZoneBrowseEntry }
export interface ModuleSlotProps<Type extends ZoneModuleType> extends ZoneSlotProps, ZoneWorkRenderers {
  module: ZoneModule<Type>;
  data: ZoneModuleData[Type];
}

/** One value a release-filter field offers: `value` is the Main value, `label` the Zone's word for it. */
export interface ZoneReleaseOption { value: string; label: string }

/**
 * One field of the release filter: a facet of Main's registry that sits inside the release group
 * (`releaseLanguage`, `releasePlatform`, `releaseTerritory`, ...). The registry decides whether the facet exists,
 * which values it admits (its pattern; a closed pattern is the closed set) and its label in each locale; the Zone
 * adds its own words and suggestions.
 */
export interface ZoneReleaseField {
  /** The registry facet's name. A facet the registry does not serve as current is not offered. */
  facet: string;
  /** The Zone's name for the field; the registry's label in the reader's language when omitted. */
  label?: string;
  /** The words for "no choice". */
  any: string;
  /**
   * Values the field offers, with the Zone's words for them. For a registry facet with a closed set only members of
   * that set are offered (omitted, the whole set, labelled with the values themselves); for an open one these are
   * suggestions, and an address may carry any value the registry's pattern admits.
   */
  options?: ZoneReleaseOption[];
  /** Values the group applies while the reader chooses nothing (for example the usable statuses). */
  unchosen?: string[];
}

/**
 * The release filter a Zone offers: one release of a Work must meet every chosen condition (Main's `where`
 * group over releases), so a translated title never counts as a playable translation. The platform renders the
 * control from the registry and this spec, sends the group to Main and shows what Main matched.
 */
export interface ZoneReleaseFilterSpec {
  /** The control's accessible name and heading. */
  label: string;
  fields: ZoneReleaseField[];
  apply: string;
  clear: string;
  /** Said under the control while it is applied: what the results are. */
  summary: string;
  /** Said when no release meets the group. */
  noMatch: { title: string; body: string };
  /**
   * Said on a page with no result that Main continues past (it examines a bounded stretch of the library
   * at a time): this stretch had no match, and the next may.
   */
  keepLooking: string;
  /** The cover a card draws for a Work found this way (Main's answer carries no type). */
  coverKind: ZoneWork['kind'];
}

export interface BrowseHeaderSlotProps extends ZoneSlotProps {
  /** The platform's release filter, already bound to the page's address. */
  filter: ReactNode;
  /** Whether the results below are filtered by a release group. */
  filtered: boolean;
}

/** The sections of a Work's overview (the hub); a Zone may lead with some of them. */
export const zoneHubSections = ['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists'] as const;
export type ZoneHubSection = (typeof zoneHubSections)[number];

/**
 * A page of a mounted resource that is not a Work: a character, place, event or chapter of a wiki. Main named
 * it (`name`) and the platform gave it an address inside the Zone (`href`); `kind` is the type registry's word
 * for what it is, in the reader's language.
 */
export interface ZoneMember { id: string; href: string; name: ZoneText; kind: string | null }

/** A mounted Collection's index page: the Works on this page, set out by the platform as `fallback`. */
export interface IndexSlotProps extends ZoneSlotProps, ZoneWorkRenderers {
  works: ZoneWork[];
}

/** A mounted Collection's index page for its members that are not Works: the page's members, in Main's order. */
export interface MemberIndexSlotProps extends ZoneSlotProps {
  members: ZoneMember[];
  /** The mounted page the reader is on: its route segment (`characters`) and its name in the Zone. */
  mount: { segment: string; name: ZoneText };
  /** Where the reader reads up to, for a Zone whose records appear by position. */
  position: ZonePositionState;
  /** More members follow this page. */
  more: boolean;
}

/**
 * Where a position-aware Zone's reader is reading up to. Main decides what every read returns for it and
 * withholds the rest before delivery; the package only words what the reader is looking at.
 */
export interface ZonePositionState {
  /** `default` is Main's choice for this reader (their own progress, or the start), `chosen` one they picked. */
  mode: 'default' | 'chosen' | 'all';
  /** The position's name when there is one; null at the start, without progress and for `all`. */
  label: ZoneText | null;
  /** The address that shows everything; null when the page already does. */
  showAllHref: string | null;
}

/** One line of a page's infobox: a property Main recorded and its values. */
export interface ZoneFact {
  label: string;
  values: {
    text: ZoneText;
    href: string | null;
    /** The continuities (Works) the claim is recorded for; set only when the property's claims differ by continuity. */
    continuity?: { name: ZoneText; href: string | null }[];
  }[];
}

/** A relationship as a structured row: what it is, and the other participants. */
export interface ZoneRelationship { label: string; others: { name: ZoneText; href: string | null; creditedName?: ZoneText }[] }

/**
 * A passage that supports a claim, with its source. `text` is null when Main withheld the quotation under a rights
 * restriction; the source stays, so a reader can find the passage in their own copy.
 */
export interface ZoneEvidence {
  id: string;
  text: ZoneText | null;
  withheld: boolean;
  /** The claim it supports, in words (`Family: Bennet family`). */
  supports: string;
  /** How the claim is told: `narrated`, `said`, `rumoured` or `hypothetical`. */
  modality: string;
  /** The rights basis Main recorded for quoting it (`public_domain`, `license`, ...). */
  rights: string;
  /** The media type of the edition the passage was read from, and the agent that extracted it. */
  mediaType: string | null;
  agent: string | null;
}

/** A wiki page's data, as the platform read it for the reader's position. */
export interface ZoneEntity {
  id: string;
  /** What it is (`Character`), from the type registry in the reader's language. */
  kind: string | null;
  name: ZoneText;
  /** Other names by language, in the order Main returned them. */
  aliases: ZoneText[];
  facts: ZoneFact[];
  relationships: ZoneRelationship[];
  evidence: ZoneEvidence[];
  /** The first position at which the record appears, when the platform could find it. */
  firstSeen: { name: ZoneText; href: string | null } | null;
  /** The record holds more than this lists (more facts, relationships or passages); the full page continues it. */
  more: boolean;
  /** The platform's own page for the record, at the same position. */
  fullPage: string;
  /** Set when the record is a position in the story (a chapter); null for any other record. */
  chapter: ZoneChapter | null;
}

/** A chapter's place in the story, and what it adds to the wiki. */
export interface ZoneChapter {
  /** The reader's position is at or past this chapter. Before it, nothing is listed: Main has not revealed it. */
  reached: boolean;
  /**
   * The members of each mounted list that appear at this chapter and not at the one before. `complete` is false
   * when the comparison stopped at its bound, so a list may be shorter than the truth.
   */
  reveals: { segment: string; name: ZoneText; members: ZoneMember[]; complete: boolean }[];
  previous: ZoneNeighbour | null;
  next: ZoneNeighbour | null;
}

/** The position before or after a chapter, when the Zone has a page for it. */
export interface ZoneNeighbour { name: ZoneText; href: string }

/** A mounted resource's page inside the Zone: a character, a place, an event or a chapter. */
export interface EntitySlotProps extends ZoneSlotProps {
  entity: ZoneEntity;
  position: ZonePositionState;
  /** The mounted page it belongs to, for the way back. */
  mount: { segment: string; name: ZoneText; href: string } | null;
  /** The platform's own rendering of everything else the page holds (discussion, ratings), placed after the slot. */
  rest: ReactNode;
}

/** One mounted list of a wiki's home, with the first of its members. */
export interface ZoneHomeSection {
  segment: string;
  name: ZoneText;
  href: string;
  works: ZoneWork[];
  members: ZoneMember[];
  more: boolean;
}

/** The Zone's home: what each mounted page holds at the reader's position. */
export interface HomeSlotProps extends ZoneSlotProps, ZoneWorkRenderers {
  sections: ZoneHomeSection[];
  position: ZonePositionState;
}

/** The slots a package may fill; an empty slot keeps the platform rendering. */
export interface ZoneSlots {
  /** The index page of a mounted Collection (`/r/light-novels/catalogue`). */
  index?: ComponentType<IndexSlotProps>;
  /** The index page of a mounted Collection's members that are not Works (`/r/franchise-wiki/characters`). */
  memberIndex?: ComponentType<MemberIndexSlotProps>;
  /** The page of a mounted resource that is not a Work (`/r/franchise-wiki/characters/{id}`). */
  entity?: ComponentType<EntitySlotProps>;
  /** The Zone's home, in place of its modules, for a Zone whose pages are its mounted lists. */
  home?: ComponentType<HomeSlotProps>;
  /** Above the Zone's browse results: the release filter and the words around it. */
  browseHeader?: ComponentType<BrowseHeaderSlotProps>;
  header?: ComponentType<HeaderSlotProps>;
  /** The search and filters the home leads with; the platform's is a search field and chip rows. */
  browseBar?: ComponentType<BrowseBarSlotProps>;
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
   * so it styles only this Zone's content box. A package lays information out; it keeps
   * REZICS's colours and type, so it names colours and fonts only through the platform's
   * custom properties (`var(--primary)`, `var(--font-interface)`), never as literals.
   */
  css: string;
  slots: ZoneSlots;
  /** Offers the release filter on the browse page, in the reader's language (`locale` is the interface locale). */
  releaseFilter?: (locale: string) => ZoneReleaseFilterSpec;
  /**
   * The hub sections a Work's page in this Zone leads with, in this order; the others follow in the hub's own
   * order. The platform draws every section the Work's page binds whatever this says, so it reorders and never
   * hides (a visual novel leads with `availability`, a series with `parts`).
   */
  hubOrder?: readonly ZoneHubSection[];
  /**
   * Asks the platform to read this Zone at each reader's position in a story (a wiki that reveals records as
   * chapters are read). `mount` is the route segment of the mounted list whose first Work the positions are in
   * (`franchise`). The platform adds a position control to the Zone's frame and sends the position with every
   * read; Main withholds what is revealed later, so a package never filters.
   */
  positions?: { mount: string };
}

export function defineZonePackage<const Package extends ZonePackage>(pkg: Package): Package {
  return pkg;
}

/**
 * The props `WorkCover` (`@rezics/ui/work-cover`) takes for a Work: exactly
 * what the platform's cards pass, so a Work wears one cover in a Zone and on
 * every other surface. Its image when it has one, otherwise the cover
 * generated from its kind, id, title and author. Spread it last but for
 * `size`, `loading`, `alt` and `className`; a Zone may tint covers through
 * `--work-cover-tint` in its stylesheet, never change their kind or design.
 */
export function workCoverProps(work: ZoneWork) {
  return { title: work.title?.value ?? '', lang: work.title?.lang, dir: work.title?.dir,
    authors: work.author ? [work.author.value] : [], kind: work.kind, id: work.id,
    image: work.cover ? { src: work.cover.url, width: work.cover.width, height: work.cover.height } : null };
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
