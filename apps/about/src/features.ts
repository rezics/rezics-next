import type { PageId } from './pages.ts';

/**
 * What a feature statement may claim. Every sentence that describes a REZICS
 * capability on the site is one entry here and renders its status beside it, so
 * the site can sell the direction without claiming what does not exist yet.
 *
 * - `available`: works today for anyone the site reaches.
 * - `in-development`: being built now; it appears in the roadmap's Now column.
 * - `planned`: decided but not started; `horizon` says whether it is Next or Later.
 */
export const availabilities = ['available', 'in-development', 'planned'] as const;
export type Availability = (typeof availabilities)[number];
export const horizons = ['now', 'next', 'later'] as const;
export type Horizon = (typeof horizons)[number];

export type FeatureStatus =
  | { status: 'available' }
  | { status: 'in-development' }
  | { status: 'planned'; horizon: 'next' | 'later' };

/** The page whose statement it is, and its status. Text lives in `messages/features.ts`. */
export type FeatureEntry = FeatureStatus & { line: PageId };

const dev = { status: 'in-development' } as const;
const next = { status: 'planned', horizon: 'next' } as const;
const later = { status: 'planned', horizon: 'later' } as const;

export const features = {
  // Home: why REZICS
  'native-multilingual': { line: 'home', ...dev },
  'portable-data': { line: 'home', ...dev },
  'open-source': { line: 'home', ...next },
  'api-agent-first': { line: 'home', ...dev },
  // Reading and the portable library
  'portable-library': { line: 'reading', ...next },
  'reading-sessions': { line: 'reading', ...next },
  'library-exchange': { line: 'reading', ...next },
  // Light novels
  'series-tracking': { line: 'light-novels', ...next },
  'edition-coverage': { line: 'light-novels', ...dev },
  'translation-availability': { line: 'light-novels', ...next },
  // Serial fiction
  'serial-writing': { line: 'serial-fiction', ...next },
  'serial-scheduling': { line: 'serial-fiction', ...next },
  'serial-reading': { line: 'serial-fiction', ...next },
  // ACGN
  'vn-releases': { line: 'acgn', ...next },
  'release-provenance': { line: 'acgn', ...dev },
  'anime-episodes': { line: 'acgn', ...next },
  // Wikis and worldbuilding
  'realm-wikis': { line: 'wikis', ...later },
  'wiki-history': { line: 'wikis', ...later },
  'agent-wikis': { line: 'wikis', ...later },
  // Communities
  realms: { line: 'communities', ...dev },
  'community-rules': { line: 'communities', ...next },
  'newcomer-trust': { line: 'communities', ...later },
  // Distribution
  'publish-books': { line: 'distribution', ...later },
  'sell-books-games': { line: 'distribution', ...later },
  'rights-declarations': { line: 'distribution', ...next },
  // Developers
  'open-api': { line: 'developers', ...dev },
  'scoped-credentials': { line: 'developers', ...dev },
  'typescript-sdk': { line: 'developers', ...next },
  'mcp-agents': { line: 'developers', ...later },
  // Trust
  'suitability-gates': { line: 'trust', ...dev },
  'ai-disclosure': { line: 'trust', ...dev },
  'no-trackers': { line: 'trust', status: 'available' },
  'reporting-appeals': { line: 'trust', ...next },
} as const satisfies Record<string, FeatureEntry>;

export type FeatureId = keyof typeof features;
export const featureIds = Object.keys(features) as FeatureId[];

export function featuresOf(line: PageId): FeatureId[] {
  return featureIds.filter((id) => features[id].line === line);
}

/** The roadmap column a feature sits in; available features are already shipped. */
export function horizonOf(id: FeatureId): Horizon | 'available' {
  const entry: FeatureEntry = features[id];
  return entry.status === 'available'
    ? 'available'
    : entry.status === 'in-development'
      ? 'now'
      : entry.horizon;
}
