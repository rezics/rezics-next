import type { SectionId, TargetBase } from '../entity-page/types.ts';

// The Work page's overview as the hub documents it (docs/plan/frontend.md#work-page). Identity and the next
// action lead every page, in the frame; these are the sections below it, in the order the plan lists them.

export const hubSections = ['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists'] as const;
export type HubSection = (typeof hubSections)[number];

/** Stable anchors: "On this page", the primary action and links from other pages point at these. */
export const hubAnchors = {
  about: 'about', availability: 'availability', parts: 'parts', wiki: 'wiki', ratings: 'ratings',
  discussion: 'discussion', lists: 'lists',
} as const satisfies Record<HubSection, string>;

/**
 * The projection's section ids each hub section is drawn from. A hub section appears when the Work's
 * `entity-page-v1` lists any of them, so a type that binds no releases has no availability section and one
 * with no relations has no parts or wiki.
 */
const bindings = {
  about: ['statements'],
  availability: ['releases'],
  parts: ['contents', 'relations'],
  wiki: ['relations'],
  ratings: ['ratings', 'reviews'],
  discussion: ['discussion'],
  // Curated lists are the projection's `lists`; discovery (readers also enjoyed, more by the author) reads on the
  // Work itself, so a Work page always has this section.
  lists: ['lists'],
} as const satisfies Record<HubSection, readonly SectionId[]>;

/**
 * The hub sections a Work's page draws, in the documented order. `null` is a projection Main could not serve:
 * the Work base's sections stand in, each of which still loads and fails on its own.
 */
export function hubPlan(page: { target: { base: TargetBase }; sections: readonly { id: SectionId }[] } | null):
  readonly HubSection[] {
  if (!page) return hubSections;
  const listed = new Set(page.sections.map(section => section.id));
  return hubSections.filter(section => (bindings[section] as readonly SectionId[]).some(id => listed.has(id))
    || (section === 'lists' && page.target.base === 'work'));
}

/** The container the primary action sits in; the sticky bar watches it leave the screen. */
export const ACTION_ID = 'work-primary-action';
/** Marks the one link that is the page's primary action, so the sticky bar can repeat it. */
export const ACTION_ATTRIBUTE = 'data-next-action';

/** The overview's sections by name, for "On this page", in the order they are drawn. */
export const hubLabels = (t: Record<`section${Capitalize<HubSection>}`, string>, plan: readonly HubSection[]) =>
  hubSections.filter(section => plan.includes(section)).map(section => ({ id: hubAnchors[section],
    label: t[`section${section[0]!.toUpperCase()}${section.slice(1)}` as `section${Capitalize<HubSection>}`] }));
