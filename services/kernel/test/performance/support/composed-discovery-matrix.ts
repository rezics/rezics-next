import type { FilterDocument } from '@rezics/filter';
import type { BookName, RecipeName } from '../../support/released-discovery.ts';

export const PUBLIC_JOBS = ['long-harem-light-novels', 'quick-vegetarian-recipes'] as const;
export const DEFERRED_JOBS = ['quick-vegetarian-not-cooked', 'bulk-long-harem-light-novels'] as const;
export const JOBS = [...PUBLIC_JOBS, ...DEFERRED_JOBS] as const;

export type PublicJob = (typeof PUBLIC_JOBS)[number];
export type DeferredJob = (typeof DEFERRED_JOBS)[number];
export type DiscoveryJob = (typeof JOBS)[number];

export const SURFACES = [
  'catalogue-direct',
  'catalogue-prepared',
  'curated-collection',
  'everything-without-state',
  'own-state',
  'mounted-zone',
  'configured-typelist',
] as const;

export type DiscoverySurface = (typeof SURFACES)[number];

export const PUBLIC_SURFACES = [
  'catalogue-direct',
  'catalogue-prepared',
  'curated-collection',
  'mounted-zone',
  'configured-typelist',
] as const satisfies readonly DiscoverySurface[];

export const OWNER_SURFACES = ['everything-without-state', 'own-state'] as const satisfies readonly DiscoverySurface[];

export const PAGE_SCENARIOS = ['first-page', 'deep-page', 'sparse-page', 'empty-page'] as const;
export const SHARED_SCENARIOS = [
  'composed-page-at-limits',
  'aliases-and-duplicates',
  'unrelated-owner-history',
  'privacy-reduction-served-share',
  'preparation-frontier-resume',
  'foreign-dependency-revoked-midway',
] as const;
export const CONTROL_SCENARIOS = [
  'hidden-control',
  'denied-control',
  'suspended-control',
  'empty-control',
] as const;
export const BULK_SCENARIOS = ['bulk-captured-population', 'bulk-retry-cancel-revoke'] as const;
export const SCENARIOS = [...PAGE_SCENARIOS, ...SHARED_SCENARIOS, ...CONTROL_SCENARIOS, ...BULK_SCENARIOS] as const;

export type DiscoveryScenario = (typeof SCENARIOS)[number];

export const PUBLIC_PERSONAS = ['anonymous', 'alice'] as const;
export const OWNER_PERSONAS = ['alice'] as const;
export type PublicPersona = (typeof PUBLIC_PERSONAS)[number];

export const BOOK_JOB_NAMES = ['B-long'] as const satisfies readonly BookName[];
export const BOOK_DEEP_NAMES = ['B-long', 'B-edge', 'B-characters'] as const satisfies readonly BookName[];
export const RECIPE_JOB_NAMES = ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked'] as const satisfies readonly RecipeName[];
export const RECIPE_NOT_COOKED_NAMES = ['R-quick', 'R-edge', 'R-other-cooked'] as const satisfies readonly RecipeName[];

export type JobFilterSet = Readonly<{
  words: FilterDocument;
  formHarem: FilterDocument;
  combined: FilterDocument;
  dietTime: FilterDocument;
}>;

export function scenarioName(job: DiscoveryJob, surface: DiscoverySurface, scenario: DiscoveryScenario): string {
  return `${job}/${surface}/${scenario}`;
}

export function surfacesFor(job: DiscoveryJob): readonly DiscoverySurface[] {
  if (job === 'quick-vegetarian-not-cooked') return OWNER_SURFACES;
  return SURFACES;
}

export function personasFor(surface: DiscoverySurface): readonly PublicPersona[] {
  return (OWNER_SURFACES as readonly string[]).includes(surface) ? OWNER_PERSONAS : PUBLIC_PERSONAS;
}

export function jobSubjectNames(job: PublicJob): readonly string[] {
  return job === 'long-harem-light-novels' ? BOOK_JOB_NAMES : RECIPE_JOB_NAMES;
}

export function deepSubjectNames(job: PublicJob): readonly string[] {
  return job === 'long-harem-light-novels' ? BOOK_DEEP_NAMES : RECIPE_JOB_NAMES;
}

export function jobFilter(job: PublicJob, filters: JobFilterSet): FilterDocument {
  return job === 'long-harem-light-novels' ? filters.combined : filters.dietTime;
}

export function deepFilter(job: PublicJob, filters: JobFilterSet): FilterDocument {
  return job === 'long-harem-light-novels' ? filters.formHarem : filters.dietTime;
}

export function jobType(job: PublicJob): 'schema:Book' | 'schema:Recipe' {
  return job === 'long-harem-light-novels' ? 'schema:Book' : 'schema:Recipe';
}

export function emptyFilter(job: PublicJob, haremId: string): FilterDocument {
  return job === 'long-harem-light-novels'
    ? {
        and: [
          { type: { in: ['schema:Recipe'] } },
          { statement: { property: 'schema:keywords', in: [haremId] } },
        ],
      }
    : {
        and: [
          { type: { in: ['schema:Book'] } },
          { statement: { property: 'schema:suitableForDiet', in: [haremId] } },
        ],
      };
}

export function isCanonicalSurface(surface: DiscoverySurface): boolean {
  return surface !== 'curated-collection';
}

export function admitsAnonymous(surface: DiscoverySurface): boolean {
  return !(OWNER_SURFACES as readonly string[]).includes(surface);
}

export function applicableScenarios(job: DiscoveryJob, surface: DiscoverySurface): readonly DiscoveryScenario[] {
  if (job === 'bulk-long-harem-light-novels') return [...PAGE_SCENARIOS, ...CONTROL_SCENARIOS, ...BULK_SCENARIOS];
  if (job === 'quick-vegetarian-not-cooked')
    return [...PAGE_SCENARIOS, 'aliases-and-duplicates', 'unrelated-owner-history', ...CONTROL_SCENARIOS];
  const shared: DiscoveryScenario[] = [
    ...PAGE_SCENARIOS,
    'aliases-and-duplicates',
    'preparation-frontier-resume',
    'foreign-dependency-revoked-midway',
    ...CONTROL_SCENARIOS,
  ];
  if (surface === 'mounted-zone') shared.push('composed-page-at-limits');
  if (surface === 'own-state' || surface === 'everything-without-state') shared.push('unrelated-owner-history');
  if (surface === 'catalogue-direct' || surface === 'catalogue-prepared')
    shared.push('privacy-reduction-served-share');
  return shared;
}

export type FrozenCell = Readonly<{
  name: string;
  job: DiscoveryJob;
  surface: DiscoverySurface;
  scenario: DiscoveryScenario;
  deferred: boolean;
}>;

export function frozenPublicCells(): readonly FrozenCell[] {
  const cells: FrozenCell[] = [];
  for (const job of JOBS) {
    for (const surface of surfacesFor(job)) {
      for (const scenario of applicableScenarios(job, surface)) {
        cells.push({
          name: scenarioName(job, surface, scenario),
          job,
          surface,
          scenario,
          deferred: (DEFERRED_JOBS as readonly string[]).includes(job),
        });
      }
    }
  }
  return cells;
}

export const DEFERRED_AUTHORITY = {
  'quick-vegetarian-not-cooked':
    'Commerce has not adopted completed cooking history or the not-cooked owner-query wire; clearing state cannot erase completion.',
  'bulk-long-harem-light-novels':
    'Commerce has not adopted filtered bulk capture, owner-query wire, or libraryOperations outcome pages for this capability.',
} as const;

export const FEWEST_TESTS_DECISION =
  'Fewest tests: one HTTP/native helper per admitted public cell covering first/deep/empty together, sparse and unrelated-history growth as independent axes, one composed 16-read page, one alias/duplicate, one resume, one revocation, and named control cases; not-cooked and bulk stay frozen on Commerce prerequisites.';
