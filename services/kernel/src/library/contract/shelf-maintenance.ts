/** Effect-free shelf maintenance phases and readiness vocabulary. */
/** Inputs are exact-owner EXISTS results obtained under account share and serialized gate initialization. */
export interface InitialShelfInputs {
  readonly hasEntries: boolean;
  readonly hasCollections: boolean;
  readonly hasSessions: boolean;
}

export function initialShelfReadiness(inputs: InitialShelfInputs): 'ready' | 'backfill' {
  return inputs.hasEntries || inputs.hasCollections || inputs.hasSessions ? 'backfill' : 'ready';
}

/** Incomplete history cannot support even a negative delta. This does not grant writer admission. */
export function counterWriteMode(ready: boolean): 'active' | 'defer' {
  return ready ? 'active' : 'defer';
}

export const EMPTY_SHELF_GENERATION = '00000000-0000-0000-0000-000000000000';

export const SHELF_BACKFILL_PHASES = [
  'drain',
  'session-changes',
  'sessions',
  'head-inputs',
  'heads',
  'entries',
  'types',
  'count-entries',
  'count-collections',
  'validate',
  'publish',
  'retire-counts',
  'retire-reservations',
  'complete',
] as const;

export const SHELF_COUNTER_PHASES = [
  'drain',
  'count-entries',
  'count-collections',
  'validate',
  'publish',
  'retire-counts',
  'retire-reservations',
  'complete',
] as const;

export const SHELF_PURGE_PHASES = [
  'cancel-work',
  'bulk-evidence',
  'reservations',
  'type-sources',
  'progress-changes',
  'progress-units',
  'sessions',
  'heads',
  'copies',
  'entries',
  'follows',
  'collection-members',
  'collections',
  'published-logs',
  'counts',
  'type-nodes',
  'type-roots',
  'type-values',
  'complete',
] as const;

export type ShelfMaintenancePhase = (typeof SHELF_BACKFILL_PHASES)[number] | (typeof SHELF_PURGE_PHASES)[number];

export type ShelfMaintenanceKind = 'backfill' | 'counters' | 'purge';

export type ShelfOwner = Readonly<{ route: number; accountId: string }>;

export type ShelfMaintenanceCursor = readonly (string | number | boolean | null)[];
