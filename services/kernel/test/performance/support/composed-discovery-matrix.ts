import type { FilterDocument } from '@rezics/filter';
import type { BookName, RecipeName } from '../../support/released-discovery.ts';

export const PUBLIC_JOBS = ['long-harem-light-novels', 'quick-vegetarian-recipes'] as const;
export const OWNER_JOBS = ['quick-vegetarian-not-cooked'] as const;
export const BULK_JOBS = ['bulk-long-harem-light-novels'] as const;
export const DEFERRED_JOBS = [] as const;
export const JOBS = [...PUBLIC_JOBS, ...OWNER_JOBS, ...BULK_JOBS, ...DEFERRED_JOBS] as const;

export type PublicJob = (typeof PUBLIC_JOBS)[number];
export type OwnerJob = (typeof OWNER_JOBS)[number];
export type BulkJob = (typeof BULK_JOBS)[number];
export type QueryableJob = PublicJob | OwnerJob | BulkJob;
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
export const OWNER_QUERY_SURFACES = [
  'curated-collection',
  ...OWNER_SURFACES,
] as const satisfies readonly DiscoverySurface[];

export const PAGE_SCENARIOS = ['first-page', 'deep-page', 'sparse-page', 'empty-page'] as const;
export const SHARED_SCENARIOS = [
  'composed-page-at-limits',
  'aliases-and-duplicates',
  'unrelated-owner-history',
  'privacy-reduction-served-share',
  'preparation-frontier-resume',
  'foreign-dependency-revoked-midway',
] as const;
export const CONTROL_SCENARIOS = ['hidden-control', 'denied-control', 'suspended-control', 'empty-control'] as const;
export const BULK_SCENARIOS = ['bulk-captured-population'] as const;
export const SCENARIOS = [...PAGE_SCENARIOS, ...SHARED_SCENARIOS, ...CONTROL_SCENARIOS, ...BULK_SCENARIOS] as const;

export type DiscoveryScenario = (typeof SCENARIOS)[number];

export const PUBLIC_PERSONAS = ['anonymous', 'alice'] as const;
export const OWNER_PERSONAS = ['alice'] as const;
export type PublicPersona = (typeof PUBLIC_PERSONAS)[number];

export const BOOK_JOB_NAMES = ['B-long'] as const satisfies readonly BookName[];
export const BOOK_DEEP_NAMES = ['B-long', 'B-edge', 'B-characters'] as const satisfies readonly BookName[];
export const RECIPE_JOB_NAMES = [
  'R-quick',
  'R-edge',
  'R-cooked',
  'R-other-cooked',
] as const satisfies readonly RecipeName[];
export const RECIPE_NOT_COOKED_NAMES = ['R-quick', 'R-edge', 'R-other-cooked'] as const satisfies readonly RecipeName[];
export const RECIPE_NOT_COOKED_STATE_NAMES = ['R-quick', 'R-other-cooked'] as const satisfies readonly RecipeName[];

export type JobFilterSet = Readonly<{
  words: FilterDocument;
  formHarem: FilterDocument;
  combined: FilterDocument;
  dietTime: FilterDocument;
  notCooked: FilterDocument;
}>;

export function scenarioName(job: DiscoveryJob, surface: DiscoverySurface, scenario: DiscoveryScenario): string {
  return `${job}/${surface}/${scenario}`;
}

export function surfacesFor(job: DiscoveryJob): readonly DiscoverySurface[] {
  if (job === 'quick-vegetarian-not-cooked') return OWNER_QUERY_SURFACES;
  if (job === 'bulk-long-harem-light-novels') return OWNER_QUERY_SURFACES;
  return SURFACES;
}

export function personasFor(surface: DiscoverySurface): readonly PublicPersona[] {
  return (OWNER_SURFACES as readonly string[]).includes(surface) ? OWNER_PERSONAS : PUBLIC_PERSONAS;
}

export function jobSubjectNames(job: QueryableJob): readonly string[] {
  if (job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels') return BOOK_JOB_NAMES;
  return job === 'quick-vegetarian-not-cooked' ? RECIPE_NOT_COOKED_NAMES : RECIPE_JOB_NAMES;
}

export function deepSubjectNames(job: QueryableJob): readonly string[] {
  if (job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels') return BOOK_DEEP_NAMES;
  return job === 'quick-vegetarian-not-cooked' ? RECIPE_NOT_COOKED_NAMES : RECIPE_JOB_NAMES;
}

export function jobFilter(job: QueryableJob, filters: JobFilterSet): FilterDocument {
  if (job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels') return filters.combined;
  return job === 'quick-vegetarian-not-cooked' ? filters.notCooked : filters.dietTime;
}

export function deepFilter(job: QueryableJob, filters: JobFilterSet): FilterDocument {
  return job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels'
    ? filters.formHarem
    : jobFilter(job, filters);
}

export function jobType(job: QueryableJob): 'schema:Book' | 'schema:Recipe' {
  return job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels' ? 'schema:Book' : 'schema:Recipe';
}

export function emptyFilter(job: QueryableJob, haremId: string): FilterDocument {
  return job === 'long-harem-light-novels' || job === 'bulk-long-harem-light-novels'
    ? {
        and: [{ type: { in: ['schema:Recipe'] } }, { statement: { property: 'schema:keywords', in: [haremId] } }],
      }
    : {
        and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:suitableForDiet', in: [haremId] } }],
      };
}

export function emptyOwnerFilter(job: QueryableJob, filters: JobFilterSet): FilterDocument {
  return { and: [jobFilter(job, filters), { type: { in: [jobType(job)] } }] };
}

export function isCanonicalSurface(surface: DiscoverySurface): boolean {
  return surface !== 'curated-collection';
}

export function admitsAnonymous(surface: DiscoverySurface): boolean {
  return !(OWNER_SURFACES as readonly string[]).includes(surface);
}

export function applicableScenarios(job: DiscoveryJob, surface: DiscoverySurface): readonly DiscoveryScenario[] {
  if (job === 'bulk-long-harem-light-novels') return [...BULK_SCENARIOS];
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
  if (surface === 'catalogue-direct' || surface === 'catalogue-prepared') shared.push('privacy-reduction-served-share');
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

export const FEWEST_TESTS_DECISION =
  'Fewest tests: one HTTP/native helper per admitted public cell covers first/deep/empty together; the request-owned not-cooked job exercises curated, Everything and own-state Sources, while public catalogue, Zone and TypeList definitions retain released public meaning; sparse catalogue, unrelated history/owner growth, one composed 16-read page, one alias/duplicate, public preparation resume, revocation, and named controls remain independent pins; filtered bulk uses the sealed existing operation manifest.';
