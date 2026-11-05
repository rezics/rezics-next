/**
 * TEST ONLY. LIBRARY_SHELF_MAINTENANCE_DRIVER is an absolute path/file URL exporting
 * createLibraryShelfMaintenanceDriver(): Promise<LibraryShelfMaintenanceDriver>.
 * Own an isolated migrated PostgreSQL DB, real installed Access/authentication,
 * semantic subjects and production kernel, commands, effects and DBOS executor.
 * close removes ONLY owned resources, including partial setup on factory failure.
 * Dispatch starts held. No policy/count model, replacement guard, fabricated SQL
 * observations or expected receipt/state generation in the adapter. Pauses/faults
 * instrument actual native boundaries. Inspection uses independent SQL in stable
 * key order; traces come from executed statements/locks/transport bytes.
 *
 * Empty fixtures have no personal inputs. Legacy fixtures use actual pre-shelf
 * commands in an owned DB before enabling the current schema/runtime, NOT raw
 * low-level rows offered as proof: two entries (first planned, second completed),
 * three active Collections (public/private/unlisted), copies/follows, and progress
 * sessions including stored record/completion and an abandon with no stored date.
 * Use fixed command clock instants, distinct from migration time. Subjects are
 * created/read through real semantic Access. A third subject has no entry.
 * Ready fixtures run the real initial backfill to completion. Full legacy entry,
 * session, head and source expectations below are captured from actual original
 * command receipts/source observations, never copied from rebuilt rows.
 */
import { expect } from 'bun:test';
import type {
  ShelfMaintenanceBinding,
  ShelfMaintenanceKind,
  ShelfMaintenancePhase,
  ShelfMaintenanceReceipt,
} from '../services/kernel/src/library/shelf-maintenance-ops-contract.ts';

export type MaintenanceCrash =
  | 'before-commit'
  | 'after-commit-before-response'
  | 'after-commit-before-enqueue'
  | 'after-enqueue-before-ack'
  | 'after-ack-before-dispatch'
  | 'before-pointer-swap'
  | 'after-pointer-swap-before-commit';
export type MaintenanceMutation =
  | 'create-entry' // third subject, planned
  | 'update-entry' // first subject, paused
  | 'delete-entry' // second subject
  | 'delete-collection' // private Collection
  | 'progress' // accepted record on first subject's active session
  | 'reserve-type'; // ordinary factory; no maintenance capability
export interface MaintenanceFixture {
  accountId: string;
  subjects: readonly [string, string, string];
  /** Same genuine cached authenticated Actor is used on all personal attempts, including after deletion. */
  actor: object;
  expectedFields: {
    sessions: unknown[];
    heads: unknown[];
    entries: unknown[];
  };
  retainedPublic: unknown[];
  detachedLogs: unknown[];
}
export interface MaintenancePageTrace {
  phase: ShelfMaintenancePhase;
  transactionId: string;
  runId: string;
  epoch: string;
  sequence: string;
  segment: number;
  committed: boolean;
  sourceRows: number;
  deletedRows: number;
  edgeOperations: number;
  sliceBytes: number;
  sliceStatements: number;
  stagingWholeValueBytes: number;
  accountBarrierChecked: boolean;
  gateChecked: boolean;
  runChecked: boolean;
  sourceConnectionsWhileOwnerHeld: number;
  connectionsWhileWaiting: number;
  deadline: number;
  startedAt: number;
  cursorBytes: number;
  cursorScalars: number;
}
export interface MaintenanceInspection {
  gate: null | {
    mode: 'open' | 'rebuilding' | 'purging' | 'purged';
    epoch: string;
    ready: boolean;
    activeGeneration: string | null;
    runId: string | null;
  };
  counts: { generation: string; bucket: string; typeId: string; n: string }[];
  fields: MaintenanceFixture['expectedFields'];
  /** Exhaustive Library private native rows, including work/scratch/bulk/bytea; excludes minimal terminal
   * gate/run receipt, separately inventoried shared evidence, and the two explicit retained artifact sets. */
  privateRows: { relation: string; key: unknown; bytes: number }[];
  retainedPublic: unknown[];
  detachedLogs: unknown[];
  intents: ShelfMaintenanceBinding[];
  receipts: ShelfMaintenanceReceipt[];
  /** Ordinary personal receipts/events/non-derived business fields only; metadata fields/counters/receipts excluded. */
  personal: unknown;
  reservations: {
    id: string;
    runId: string | null;
    epoch: string;
    generation: string;
    offset: string;
    bytes: number;
  }[];
  dictionary: { typeId: string; fullType: string }[];
  pages: MaintenancePageTrace[];
  remotePages: { examined: number; deleted: number; ownerConnectionsHeld: number; receiptKey: string }[];
  workflows: { runId: string; segment: number; pages: number; payloadBytes: number }[];
  workflowPayloads: unknown[];
  /** Real init SQL trace: three indexed exact-owner probes, no residual-history scan or COUNT. */
  initialization: { probes: string[]; accountShare: boolean; gateExclusive: boolean; populationScans: string[] }[];
  faults: { phase: ShelfMaintenancePhase | 'initialize'; boundary: MaintenanceCrash }[];
  /** Outstanding shared retention owners, not normalized into private-domain completion. */
  sharedEvidence: string[];
}

export interface LibraryShelfMaintenanceDriver {
  fixture(
    mode: 'empty' | 'legacy' | 'ready',
    options?: {
      /** Force actual allocator digest collisions, prime primary and use this exact long type for first subject. */
      longType?: string;
      /** Legacy fixtures may contain ONLY the named real command inputs to test each EXISTS branch. */
      inputs?: 'entries-only' | 'collections-only' | 'sessions-only';
      /** Generate >100 child rows per parent, >100 pages overall, plus cancelled generations and bulk evidence. */
      large?: boolean;
    },
  ): Promise<MaintenanceFixture>;
  initialize(f: MaintenanceFixture): Promise<void>;
  start(f: MaintenanceFixture, kind: Exclude<ShelfMaintenanceKind, 'purge'>): Promise<ShelfMaintenanceBinding>;
  /** Actual production command/HTTP handler; retry key is stable per mutation for the fixture. */
  mutate(f: MaintenanceFixture, mutation: MaintenanceMutation): Promise<Response>;
  /** Production private reader with real Access/readiness; exact type filter is for page/summary only. */
  read(f: MaintenanceFixture, reader: 'page' | 'summary' | 'facets', type?: string): Promise<Response>;
  inspect(f: MaintenanceFixture): Promise<MaintenanceInspection>;
  /** Run only real runnable intents/effects to idle; no forced cursor changes; hold dispatch again afterward. */
  settle(): Promise<void>;
  /** Bounded indexed recovery scan ONLY; no user action may supply missing work after a crash. */
  recover(): Promise<void>;
  crashNext(
    f: MaintenanceFixture,
    phase: ShelfMaintenancePhase | 'initialize',
    boundary: MaintenanceCrash,
  ): Promise<{
    reached: Promise<void>;
  }>;
  pauseNext(
    f: MaintenanceFixture,
    boundary:
      | 'initializer-before-probes'
      | 'writer-after-gate'
      | 'page-after-gate'
      | 'before-publish'
      | 'after-type-source-release'
      | 'before-reservation-publication',
  ): Promise<{ reached: Promise<void>; resume(): Promise<void> }>;
  /** Resolve only when pg_locks/production trace proves this live contender is waiting on the named lock. */
  waitForBlocked(f: MaintenanceFixture, lock: 'account' | 'gate'): Promise<void>;
  /** Actual deletion command; returns after Accounts commit, without waiting for held Library dispatch. */
  deleteOwner(f: MaintenanceFixture, path?: 'ordinary' | 'no-continuation' | 'organization-close'): Promise<void>;
  /** Captured actual job bindings replay through production dispatch, no synthetic restored initiator. */
  captureJobs(f: MaintenanceFixture): Promise<unknown[]>;
  redeliver(jobs: unknown[]): Promise<void>;
  /** Same ordinary factory with copied/serialized capability at the real native guard seam; must refuse. */
  forgeDerivedPage(f: MaintenanceFixture, form: 'copied' | 'serialized' | 'other-tx'): Promise<void>;
  /** Pre-gate source observation retained by a real ordinary reservation worker; resume after fence. */
  prepareOrdinaryReservation(f: MaintenanceFixture): Promise<{ resume(): Promise<void> }>;
  /** Actual source ownership/error seam, never fabricates an invisible type/empty source. */
  sourceFault(f: MaintenanceFixture, state: 'unavailable' | 'clear'): Promise<void>;
  /** Persistence fault seam on an idle open gate only; never manufactures readiness/source/Access evidence. */
  setEpochForTest(f: MaintenanceFixture, epoch: bigint): Promise<void>;
  close(): Promise<void>;
}

/** Test assertions over independent native observations; no adapter or modeled state is supplied here. */
export function maintenanceAssertions(current: () => LibraryShelfMaintenanceDriver, forbiddenInput: string) {
  const tabs = ['all', 'planned', 'in_progress', 'completed', 'paused', 'dropped', 'collections'] as const;
  async function unavailable(f: MaintenanceFixture) {
    for (const reader of ['page', 'summary', 'facets'] as const) {
      for (const type of reader === 'facets' ? [undefined] : [undefined, 'schema:Unknown']) {
        const response = await current().read(f, reader, type);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: 503, retryable: true });
      }
    }
  }
  async function totals(
    f: MaintenanceFixture,
    all: number,
    planned: number,
    completed: number,
    paused: number,
    collections: number,
  ) {
    const response = await current().read(f, 'summary');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(Object.keys(result.tabs).sort()).toEqual([...tabs].sort());
    const expected = { all, planned, completed, paused, collections, in_progress: 0, dropped: 0 };
    for (const tab of tabs) expect(result.tabs[tab]).toEqual({ total: expected[tab], shown: expected[tab] });
  }
  function bounds(s: MaintenanceInspection) {
    expect(s.pages.length).toBeGreaterThan(0);
    for (const p of s.pages) {
      expect(p.sourceRows).toBeLessThanOrEqual(100);
      expect(p.deletedRows).toBeLessThanOrEqual(100);
      expect(p.edgeOperations).toBeLessThanOrEqual(100);
      expect(p.sliceBytes).toBeLessThanOrEqual(25_600);
      expect(p.sliceStatements).toBeLessThanOrEqual(1);
      expect(p.stagingWholeValueBytes).toBe(0);
      expect(p.accountBarrierChecked && p.gateChecked && p.runChecked).toBe(true);
      expect(p.sourceConnectionsWhileOwnerHeld).toBe(0);
      expect(p.connectionsWhileWaiting).toBe(0);
      expect(p.deadline - p.startedAt).toBeGreaterThan(0);
      expect(p.deadline - p.startedAt).toBeLessThanOrEqual(5_000);
      expect(p.cursorBytes).toBeLessThanOrEqual(2_048);
      expect(p.cursorScalars).toBeLessThanOrEqual(8);
      expect(p.epoch).toMatch(/^(0|[1-9]\d*)$/);
      expect(p.sequence).toMatch(/^(0|[1-9]\d*)$/);
      if (p.committed)
        expect(
          s.receipts.some(
            (r) =>
              r.transactionId === p.transactionId &&
              r.binding.runId === p.runId &&
              r.binding.epoch === p.epoch &&
              r.binding.sequence === p.sequence,
          ),
        ).toBe(true);
    }
    for (const w of s.workflows) {
      expect(w.pages).toBeLessThanOrEqual(100);
      expect(w.payloadBytes).toBeLessThanOrEqual(4_096);
    }
    for (const c of s.counts) expect(c.n).toMatch(/^(0|[1-9]\d*)$/);
    for (const p of s.remotePages) {
      expect(p.examined).toBeLessThanOrEqual(100);
      expect(p.deleted).toBeLessThanOrEqual(100);
      expect(p.ownerConnectionsHeld).toBe(0);
      expect(p.receiptKey.length).toBeGreaterThan(0);
    }
    const keys = s.receipts.map((r) => r.receiptKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(JSON.stringify(s.workflowPayloads)).not.toContain(forbiddenInput);
  }
  async function finished(f: MaintenanceFixture, phases: readonly ShelfMaintenancePhase[]) {
    const s = await current().inspect(f);
    expect(s.gate).toMatchObject({ mode: 'open', ready: true });
    expect(s.gate!.activeGeneration).not.toBeNull();
    expect(s.intents).toEqual([]);
    for (const phase of phases) expect(s.receipts.some((r) => r.phase === phase)).toBe(true);
    expect(s.receipts.filter((r) => r.terminal)).toHaveLength(1);
    bounds(s);
    return s;
  }
  async function deletedDenied(f: MaintenanceFixture) {
    const before = (await current().inspect(f)).personal;
    expect([401, 403, 404]).toContain((await current().mutate(f, 'create-entry')).status);
    expect((await current().inspect(f)).personal).toEqual(before);
  }
  return { unavailable, totals, bounds, finished, deletedDenied };
}

export const crashes: MaintenanceCrash[] = [
  'before-commit',
  'after-commit-before-enqueue',
  'after-enqueue-before-ack',
  'after-ack-before-dispatch',
];
export const phaseCrashes = (phase: ShelfMaintenancePhase): MaintenanceCrash[] =>
  phase === 'complete' ? ['before-commit', 'after-commit-before-response'] : crashes;
