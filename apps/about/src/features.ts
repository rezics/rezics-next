import type { PageId } from './pages.ts';

/**
 * The site describes REZICS at launch, after GOAL.md's M4–M8. Only capabilities
 * beyond launch get a label. Principles have no delivery stage and no label;
 * milestones exist solely to show progress on the roadmap.
 */
export const horizons = ['now', 'next', 'later'] as const;
export type Horizon = (typeof horizons)[number];

/** GOAL.md's milestones, in delivery order. */
export const milestones = ['M4', 'M5', 'M6', 'M7', 'M8'] as const;
export type Milestone = (typeof milestones)[number];

/**
 * Where each milestone sits: M4 (meaning, authority, preservation) is being built;
 * M5 (shared capabilities and safety) and M6 (the four scenarios) follow it; M7
 * (contribution, knowledge, agents, distribution) and M8 (launch) come after.
 */
export const milestoneHorizon: Record<Milestone, Horizon> = {
  M4: 'now',
  M5: 'next',
  M6: 'next',
  M7: 'later',
  M8: 'later',
};

type Delivery = Milestone | 'principle' | { later: string };

/** The page and launch stage, principle, or sourced post-launch decision. */
const plan = {
  // Home: why REZICS
  'native-multilingual': ['home', 'M4'],
  'portable-data': ['home', 'M5'],
  'sourced-knowledge': ['home', 'M7'],
  'api-agent-first': ['home', 'M5'],
  'open-source': ['home', 'principle'],
  // Home: every language, the whole community, fans together, every kind
  'names-every-script': ['home', 'M6'],
  'shared-tags': ['home', 'M7'],
  'reviewed-translations': ['home', 'M7'],
  'saved-lists': ['home', 'M7'],
  'one-identity': ['home', 'M7'],
  'works-across-platforms': ['home', 'M6'],
  'every-kind': ['home', 'M6'],
  // Reading and the portable library
  'portable-library': ['reading', 'M6'],
  'reading-sessions': ['reading', 'M6'],
  'library-import': ['reading', 'M6'],
  'library-export': ['reading', 'M5'],
  'copies-loans': ['reading', 'M6'],
  'review-targets': ['reading', 'M7'],
  'reading-notes': ['reading', 'M7'],
  // Light novels
  'series-tracking': ['light-novels', 'M6'],
  'edition-coverage': ['light-novels', 'M4'],
  'translation-availability': ['light-novels', 'M6'],
  'release-alerts': ['light-novels', 'M6'],
  'translation-provenance': ['light-novels', 'M6'],
  'light-novels-zone': ['light-novels', 'M6'],
  // Serial fiction
  'serial-writing': ['serial-fiction', 'M5'],
  'serial-scheduling': ['serial-fiction', 'M6'],
  'serial-reading': ['serial-fiction', 'M6'],
  'chapter-discussion': ['serial-fiction', 'M6'],
  collaborators: ['serial-fiction', 'M6'],
  'author-backup': ['serial-fiction', 'M5'],
  // Visual novels, anime and manga
  'vn-releases': ['acgn', 'M6'],
  'release-provenance': ['acgn', 'M6'],
  'anime-episodes': ['acgn', 'M6'],
  'one-list': ['acgn', 'M6'],
  'spoiler-position': ['acgn', 'M5'],
  'acgn-zone': ['acgn', 'M6'],
  // Wikis and worldbuilding
  'realm-wikis': ['wikis', 'M7'],
  'chapter-citations': ['wikis', 'M7'],
  'spoiler-safe-wiki': ['wikis', 'M7'],
  'wiki-builder': ['wikis', 'M7'],
  'world-bible': ['wikis', 'M7'],
  // Decision 28: private World maps, relationships and fictional chronologies.
  'world-visuals': ['wikis', 'M7'],
  'wiki-history': ['wikis', 'M7'],
  // Agents
  'contribution-protocol': ['agents', 'M7'],
  'spam-review': ['agents', 'M7'],
  'auto-tagging': ['agents', 'M7'],
  'relation-maintenance': ['agents', 'M7'],
  normalisation: ['agents', 'M7'],
  'migration-assistant': ['agents', 'M7'],
  'bring-your-own-agent': ['agents', 'M7'],
  'agent-disclosure': ['agents', 'principle'],
  // Communities
  realms: ['communities', 'M7'],
  'follow-join': ['communities', 'M7'],
  'community-rules': ['communities', 'M7'],
  'newcomer-trust': ['communities', 'M7'],
  'moderation-cases': ['communities', 'M5'],
  recognition: ['communities', 'M8'],
  // Distribution
  'sell-books-games': ['distribution', 'M7'],
  'drm-free': ['distribution', 'principle'],
  'clear-statements': ['distribution', 'M7'],
  'edition-storefront': ['distribution', 'M7'],
  'rights-declarations': ['distribution', 'M6'],
  'connected-store': ['distribution', 'M7'],
  // Developers
  'open-api': ['developers', 'M5'],
  'scoped-credentials': ['developers', 'M4'],
  'actionable-errors': ['developers', 'M4'],
  'event-stream': ['developers', 'M7'],
  'typescript-sdk': ['developers', 'M7'],
  'developer-portal': ['developers', 'M7'],
  // Trust
  'suitability-gates': ['trust', 'M4'],
  'ai-disclosure': ['trust', 'principle'],
  'no-training': ['trust', 'principle'],
  'no-trackers': ['trust', 'principle'],
  'reporting-appeals': ['trust', 'M5'],
  'safety-response': ['trust', 'M5'],
} as const satisfies Record<string, readonly [PageId, Delivery]>;

export type FeatureId = keyof typeof plan;
export const featureIds = Object.keys(plan) as FeatureId[];

export type Feature = {
  line: PageId;
} & (
  | { status: 'launch'; milestone: Milestone | undefined; source?: never }
  | { status: 'later'; milestone: undefined; source: string }
);

function feature([line, delivery]: readonly [PageId, Delivery]): Feature {
  if (typeof delivery === 'object')
    return { line, status: 'later', milestone: undefined, source: delivery.later };
  return { line, status: 'launch', milestone: delivery === 'principle' ? undefined : delivery };
}

export const features = Object.fromEntries(
  featureIds.map((id) => [id, feature(plan[id])]),
) as Record<FeatureId, Feature>;

export function featuresOf(line: PageId): FeatureId[] {
  return featureIds.filter((id) => features[id].line === line);
}
