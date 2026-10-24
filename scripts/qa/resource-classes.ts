import { seedVerificationPlan } from './seed-verification.ts';

/** Stack allocation and command deadline are declared before any fixture starts.
 * A large tmpfs corpus needs RAM for TDB2's retained files as well as the JVM. */
export const qaResourceClasses = {
  ordinary: {
    storage: 'test',
    memory: '2g',
    jvmArgs: '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m',
    budgetMs: 480_000,
  },
  // Six complete reader traversals include four 261-thread public rankings,
  // private admission histories, chart continuations and cursor refusals. The
  // measured visitor/stranger/member cases took 55/70/88s; bound each at 120s.
  // Restore keeps its independent 600s active-work bound and the ordinary heap.
  // A standalone consumer may also prepare custody; the physical cut copies
  // persistent volumes and cannot retain tmpfs stores.
  'realm-ranking': {
    storage: 'scale',
    memory: '2g',
    jvmArgs: '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m',
    budgetMs: 6 * 120_000,
  },
  'large-tmpfs': {
    storage: 'test',
    memory: '7g',
    jvmArgs: '-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=512m',
    budgetMs: 600_000,
  },
  // Real Event history plus faster unrelated writer churn retains more TDB2
  // copy-on-write files than the ordinary large corpus.
  'temporal-tmpfs': {
    storage: 'test',
    memory: '12g',
    jvmArgs: '-Xms128m -Xmx3072m -XX:MaxDirectMemorySize=512m',
    budgetMs: 600_000,
  },
  'catalogue-disk': {
    storage: 'scale',
    memory: '7g',
    jvmArgs: '-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=512m',
    budgetMs: 480_000,
  },
  // Each selected restore owns its preparation ceiling plus harness/reader cleanup.
  // Named selections restore twice for isolation; the default restores four times.
  'seed-cut-restore': {
    storage: 'scale',
    memory: '7g',
    jvmArgs: '-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=512m',
    get budgetMs() { return seedVerificationPlan(process.env.REZICS_SEED_VERIFY_CUT).budgetMs; },
  },
} as const;
export type QaResourceClass = keyof typeof qaResourceClasses;

/** Compare JDK diagnostics with the declared class, including large tmpfs probes. */
export function qaResourceHeapBytes(name: QaResourceClass): number {
  const maximum = /(?:^|\s)-Xmx(\d+)([kmg])(?:\s|$)/i.exec(qaResourceClasses[name].jvmArgs);
  if (!maximum) throw new Error(`Missing heap maximum for ${name}`);
  const units: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(maximum[1]) * units[maximum[2]!.toLowerCase()]!;
}

/** Heavy files own one project each; retained data cannot accumulate in a 2 GiB shard. */
export const integrationResourceClasses: ReadonlyMap<string, QaResourceClass> = new Map([
  // Restart proofs retain both PostgreSQL checkpoints and Fuseki's model volume.
  ['tests/qa/integration/restart-resilience.test.ts', 'catalogue-disk'],
  ['tests/qa/integration/outcomes/realm/ranking.test.ts', 'realm-ranking'],
  ['services/main/tests/also-enjoyed-read-cost.integration.test.ts', 'catalogue-disk'],
  // The thousand-entry outcome owns its projection build and six complete traversals.
  ['tests/qa/integration/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.test.ts', 'large-tmpfs'],
  // Operator custody maintenance verifies harness-owned persistent owner volumes.
  ['tests/qa/integration/model-custody-backfill.test.ts', 'catalogue-disk'],
  // Container restart must retain legacy RDF, and the terminal gap needs its own project.
  ['tests/qa/integration/local-read-basis.test.ts', 'catalogue-disk'],
  // Native projection restart evidence and its Lucene state must survive a container restart.
  ['services/main/tests/content-projection.integration.test.ts', 'catalogue-disk'],
  ['tests/qa/integration/event-query-bounds.test.ts', 'temporal-tmpfs'],
  ...[
    'recipe-export-limit',
    'g-1021-reading-cost',
    'g-1022-reading-cost',
    'g-1025-home-cost',
    'g-1025-ranking-cost',
    'g-1034-realm-ranking',
    'g-1048-search-availability',
    'g-854-large-library',
    'g-852-zones',
    'g-556-ranked-large',
    'g-939-discovery',
    'g-954-reading-position',
    'g-1051-query-scale',
    'g-1014-structure-cost',
    'g-1026-community-cost',
    'g-828-zone-browse',
    'g-856-zones',
    'g-856-library',
  ].map((name) => [`tests/qa/integration/${name}.test.ts`, 'large-tmpfs'] as const),
  ...[
    'g-1038-catalogue-scale',
    'g-1031-catalogue-write',
    'g-1035-catalogue-write',
    'g-1032-catalogue-preparation',
    'profile-corpus-restore',
    'audit-bounded-reads',
    'notification-read-budget',
    'official-zone-read-budget',
    'rating-population-read-budget',
    'realm-discussion-source',
    'library-growth',
    'recipe-page-growth',
    'zone-navigation-growth',
  ].map((name) => [`tests/qa/integration/${name}.test.ts`, 'catalogue-disk'] as const),
  ['tests/qa/fault-recovery/work-profile-seed-build.test.ts', 'catalogue-disk'],
  ['tests/qa/integration/work-profile-seed-checkpoints.test.ts', 'seed-cut-restore'],
]);

export function integrationResourceClass(files: readonly string[]): QaResourceClass {
  const heavy = files.filter((file) => integrationResourceClasses.has(file));
  if (heavy.length && files.length !== 1)
    throw new Error(`Heavy integration files require their own project: ${heavy.join(', ')}`);
  return heavy.length ? integrationResourceClasses.get(heavy[0]!)! : 'ordinary';
}

/** Check the running container, not just environment values or a plan label.
 * Compose overlays previously replaced a saved 7 GiB allocation with 2 GiB. */
export function assertQaResourceAllocation(
  name: QaResourceClass,
  actual: {
    memory: number;
    mounts: { Type: string; Destination: string }[];
    tmpfs?: Record<string, string> | null;
  },
  storage: 'test' | 'scale' = qaResourceClasses[name].storage,
): void {
  const minimum = Number.parseInt(qaResourceClasses[name].memory, 10) * 1024 ** 3;
  if (
    !Number.isSafeInteger(actual.memory) ||
    actual.memory < 0 ||
    (actual.memory !== 0 && actual.memory < minimum)
  )
    throw new Error(`${name} Fuseki memory allocation is below ${minimum} bytes`);
  const mount = actual.mounts.find((mount) => mount.Destination === '/fuseki/databases');
  // Compose's tmpfs syntax is recorded in HostConfig.Tmpfs; --mount tmpfs
  // instead appears in Mounts. Both describe the same storage allocation.
  const tmpfs = Object.hasOwn(actual.tmpfs ?? {}, '/fuseki/databases') || mount?.Type === 'tmpfs';
  if (storage === 'test' ? !tmpfs : tmpfs || mount?.Type !== 'volume')
    throw new Error(`${name} Fuseki storage does not match ${storage}`);
}

/** Queued projects keep their own deadlines, even when only one QA slot is free.
 * Turnover includes cleanup and the next startup/bootstrap; each remains bounded
 * independently by the runner. Ordinary plans keep the existing tier deadline. */
export function integrationTierBudget(classes: readonly QaResourceClass[], slots: number): number {
  if (!Number.isInteger(slots) || slots < 1) throw new Error('Invalid QA slot count');
  if (classes.every((name) => name === 'ordinary')) return qaResourceClasses.ordinary.budgetMs;
  return Math.max(qaResourceClasses.ordinary.budgetMs,
    queuedProjectsBudget(classes.map((name) => qaResourceClasses[name].budgetMs), slots));
}

/** Wall deadline for projects queued on fewer slots than projects, each within its own budget.
 * List scheduling completes within average load plus the longest job's remaining worker share;
 * the first project's turnover allowance is excluded. */
export function queuedProjectsBudget(projectBudgetsMs: readonly number[], slots: number): number {
  if (!Number.isInteger(slots) || slots < 1) throw new Error('Invalid QA slot count');
  if (!projectBudgetsMs.length) return 0;
  const workers = Math.min(slots, projectBudgetsMs.length);
  const costs = projectBudgetsMs.map((ms) => ms + 480_000);
  const bound =
    costs.reduce((sum, ms) => sum + ms, 0) / workers +
    Math.max(...costs) * (1 - 1 / workers) -
    480_000;
  return Math.max(...projectBudgetsMs, Math.ceil(bound));
}
