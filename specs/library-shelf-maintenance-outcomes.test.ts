import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EMPTY_SHELF_GENERATION,
  SHELF_BACKFILL_PHASES,
  SHELF_COUNTER_PHASES,
  SHELF_PURGE_PHASES,
} from '../services/kernel/src/library/shelf-maintenance-ops-contract.ts';
import type { ShelfMaintenancePhase } from '../services/kernel/src/library/shelf-maintenance-ops-contract.ts';
import { maintenanceAssertions, crashes, phaseCrashes } from './library-shelf-maintenance-driver.ts';
import type {
  LibraryShelfMaintenanceDriver,
  MaintenanceCrash,
  MaintenanceFixture,
} from './library-shelf-maintenance-driver.ts';

setDefaultTimeout(240_000);
let driver: LibraryShelfMaintenanceDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_SHELF_MAINTENANCE_DRIVER;
  if (!location) throw new Error('Library shelf maintenance outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_SHELF_MAINTENANCE_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_SHELF_MAINTENANCE_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryShelfMaintenanceDriver !== 'function')
    throw new Error('Expected createLibraryShelfMaintenanceDriver factory');
  driver = await binding.createLibraryShelfMaintenanceDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

const longType = 'schema:' + 'A'.repeat(256 * 205);
const { totals, unavailable, bounds, finished, deletedDenied } = maintenanceAssertions(() => driver, longType);
async function faultRun(
  f: MaintenanceFixture,
  phase: ShelfMaintenancePhase | 'initialize',
  boundary: MaintenanceCrash,
  body: () => Promise<unknown>,
) {
  const fault = await driver.crashNext(f, phase, boundary);
  const work = body();
  // Observe rejection immediately; the independently observed boundary proves the intended crash actually happened.
  const result = Promise.allSettled([work]);
  await fault.reached;
  await result;
  expect((await driver.inspect(f)).faults).toContainEqual({ phase, boundary });
  await driver.recover();
  // An uncommitted initializer has published neither a gate nor a 503 readiness result.
  if (phase === 'initialize' && boundary === 'before-commit') await driver.initialize(f);
  await driver.settle();
}

test('empty first readers and concurrent first writers publish one exact zero generation', async () => {
  const f = await driver.fixture('empty');
  const pause = await driver.pauseNext(f, 'initializer-before-probes');
  const init = driver.initialize(f);
  try {
    await pause.reached;
    const write = driver.mutate(f, 'create-entry');
    const otherRead = driver.initialize(f);
    await driver.waitForBlocked(f, 'gate');
    await pause.resume();
    await Promise.all([init, otherRead]);
    expect((await write).status).toBe(201);
  } finally {
    await pause.resume();
  }
  const s = await driver.inspect(f);
  expect(s.gate).toMatchObject({ mode: 'open', ready: true, activeGeneration: EMPTY_SHELF_GENERATION });
  expect(s.intents).toEqual([]);
  expect(s.initialization.length).toBeGreaterThan(0);
  for (const i of s.initialization) {
    expect(i.accountShare && i.gateExclusive).toBe(true);
    expect(i.probes.slice().sort()).toEqual(['collections', 'entries', 'sessions']);
    expect(i.populationScans).toEqual([]);
  }
  await totals(f, 1, 1, 0, 0, 0);
});

test('an admitted first writer cannot be missed by a concurrent readiness initializer', async () => {
  const f = await driver.fixture('empty');
  const pause = await driver.pauseNext(f, 'writer-after-gate');
  const write = driver.mutate(f, 'create-entry');
  try {
    await pause.reached;
    const init = driver.initialize(f);
    await driver.waitForBlocked(f, 'gate');
    await pause.resume();
    expect((await write).status).toBe(201);
    await init;
  } finally {
    await pause.resume();
  }
  await driver.settle();
  await totals(f, 1, 1, 0, 0, 0);
});

test('legacy create update delete and Collection removal defer counters while all shelf reads are unavailable', async () => {
  const f = await driver.fixture('legacy');
  await driver.initialize(f);
  const before = await driver.inspect(f);
  expect(before.gate).toMatchObject({ mode: 'open', ready: false });
  expect(before.intents).toHaveLength(1);
  await unavailable(f);
  for (const mutation of ['create-entry', 'update-entry', 'delete-entry', 'delete-collection'] as const)
    expect((await driver.mutate(f, mutation)).status).toBe(
      mutation === 'create-entry' ? 201 : mutation === 'update-entry' ? 200 : 204,
    );
  expect((await driver.inspect(f)).counts).toEqual(before.counts);
  await unavailable(f);
  await driver.recover();
  await driver.settle();
  await finished(f, SHELF_BACKFILL_PHASES);
  await totals(f, 2, 1, 0, 1, 2);
});

test('cold legacy initialization recovers its own intent without an unrelated user write', async () => {
  for (const boundary of crashes) {
    const f = await driver.fixture('legacy');
    const personal = (await driver.inspect(f)).personal;
    await faultRun(f, 'initialize', boundary, () => driver.initialize(f));
    const s = await finished(f, SHELF_BACKFILL_PHASES);
    expect(s.fields).toEqual(f.expectedFields);
    expect(s.personal).toEqual(personal);
    await totals(f, 2, 1, 1, 0, 3);
  }
});

test('each real legacy input alone prevents a false empty ready generation', async () => {
  for (const inputs of ['entries-only', 'collections-only', 'sessions-only'] as const) {
    const f = await driver.fixture('legacy', { inputs });
    await driver.initialize(f);
    expect((await driver.inspect(f)).gate!.ready).toBe(false);
    await unavailable(f);
    await driver.recover();
    await driver.settle();
    await totals(
      f,
      inputs === 'entries-only' ? 2 : 0,
      inputs === 'entries-only' ? 1 : 0,
      inputs === 'entries-only' ? 1 : 0,
      0,
      inputs === 'collections-only' ? 3 : 0,
    );
  }
});

test('native epoch and receipt checkpoints preserve values above the safe integer range', async () => {
  const f = await driver.fixture('ready');
  const epoch = 9_007_199_254_740_993n;
  await driver.setEpochForTest(f, epoch);
  await driver.start(f, 'counters');
  await driver.settle();
  const s = await driver.inspect(f);
  expect(s.gate!.epoch).toBe((epoch + 1n).toString());
  expect(s.receipts.some((r) => r.binding.epoch === (epoch + 1n).toString())).toBe(true);
  await totals(f, 2, 1, 1, 0, 3);
  bounds(s);
});

test('counter-only rebuild serves the old complete generation and publishes exactly once', async () => {
  const f = await driver.fixture('ready');
  const old = await driver.inspect(f);
  await driver.start(f, 'counters');
  const pause = await driver.pauseNext(f, 'before-publish');
  const work = driver.settle();
  try {
    await pause.reached;
    await totals(f, 2, 1, 1, 0, 3);
    expect((await driver.inspect(f)).gate!.activeGeneration).toBe(old.gate!.activeGeneration);
    const personal = (await driver.inspect(f)).personal;
    expect((await driver.mutate(f, 'update-entry')).status).toBe(503);
    expect((await driver.inspect(f)).personal).toEqual(personal);
  } finally {
    await pause.resume();
  }
  await work;
  const s = await driver.inspect(f);
  expect(s.gate!.activeGeneration).not.toBe(old.gate!.activeGeneration);
  expect(s.fields).toEqual(old.fields);
  await totals(f, 2, 1, 1, 0, 3);
  expect((await driver.mutate(f, 'update-entry')).status).toBe(200);
  await totals(f, 2, 0, 1, 1, 3);
  const after = await driver.inspect(f);
  expect(after.counts.every((c) => c.generation === after.gate!.activeGeneration)).toBe(true);
});

test('field rewrites disable affected shelf reads even when an old complete counter generation exists', async () => {
  const f = await driver.fixture('ready');
  await driver.start(f, 'backfill');
  const pause = await driver.pauseNext(f, 'before-publish');
  const work = driver.settle();
  try {
    await pause.reached;
    await unavailable(f);
  } finally {
    await pause.resume();
  }
  await work;
  await totals(f, 2, 1, 1, 0, 3);
});

test('every backfill and counter phase survives commit enqueue ack and atomic swap crashes without double increments', async () => {
  for (const kind of ['backfill', 'counters'] as const) {
    const phases = kind === 'backfill' ? SHELF_BACKFILL_PHASES : SHELF_COUNTER_PHASES;
    for (const phase of phases)
      for (const boundary of phaseCrashes(phase)) {
        const f = await driver.fixture(kind === 'backfill' ? 'legacy' : 'ready');
        await faultRun(f, phase, boundary, async () => {
          await driver.start(f, kind);
          await driver.settle();
        });
        await totals(f, 2, 1, 1, 0, 3);
        const s = await driver.inspect(f);
        expect(s.fields).toEqual(f.expectedFields);
        expect(s.gate).toMatchObject({ mode: 'open', ready: true });
        expect(s.intents).toEqual([]);
        bounds(s);
      }
  }
  for (const boundary of ['before-pointer-swap', 'after-pointer-swap-before-commit'] as const) {
    const f = await driver.fixture('legacy');
    await faultRun(f, 'publish', boundary, async () => {
      await driver.start(f, 'backfill');
      await driver.settle();
    });
    await totals(f, 2, 1, 1, 0, 3);
    await finished(f, SHELF_BACKFILL_PHASES);
  }
});

test('same-run long dictionary continuations work under rebuilding while ordinary and forged writers refuse', async () => {
  const f = await driver.fixture('legacy', { longType });
  await driver.start(f, 'backfill');
  const pause = await driver.pauseNext(f, 'before-reservation-publication');
  const work = driver.settle();
  try {
    await pause.reached;
    const s = await driver.inspect(f);
    expect(s.reservations.length).toBeGreaterThan(0);
    expect(s.reservations.every((r) => r.runId === s.gate!.runId && r.epoch === s.gate!.epoch)).toBe(true);
    expect(s.dictionary.some((v) => v.fullType === longType)).toBe(false);
    const personal = s.personal;
    for (const mutation of ['create-entry', 'progress', 'reserve-type'] as const)
      expect((await driver.mutate(f, mutation)).status).toBe(503);
    for (const form of ['copied', 'serialized', 'other-tx'] as const)
      await expect(driver.forgeDerivedPage(f, form)).rejects.toThrow();
    expect((await driver.inspect(f)).personal).toEqual(personal);
  } finally {
    await pause.resume();
  }
  await work;
  const s = await finished(f, SHELF_BACKFILL_PHASES);
  expect(s.reservations).toEqual([]);
  expect(s.dictionary.filter((v) => v.fullType === longType)).toHaveLength(1);
  expect(s.pages.filter((p) => p.sliceBytes > 0).length).toBeGreaterThan(1);
  const facets = await driver.read(f, 'facets');
  expect(facets.status).toBe(200);
  expect((await facets.json()).types).toContainEqual({ type: longType, count: 1 });
  const filtered = await driver.read(f, 'summary', longType);
  expect(filtered.status).toBe(200);
  expect((await filtered.json()).tabs.all).toEqual({ total: 2, shown: 1 });
  await totals(f, 2, 1, 1, 0, 3);
});

test('unavailable source observations cannot publish a falsely complete type or zero count', async () => {
  const f = await driver.fixture('legacy');
  await driver.sourceFault(f, 'unavailable');
  await driver.start(f, 'backfill');
  await Promise.allSettled([driver.settle()]);
  await unavailable(f);
  expect((await driver.inspect(f)).gate!.ready).toBe(false);
  await driver.sourceFault(f, 'clear');
  await driver.recover();
  await driver.settle();
  await totals(f, 2, 1, 1, 0, 3);
});

test('a reservation from an earlier open epoch cannot continue in the active rebuilding run', async () => {
  const f = await driver.fixture('legacy', { longType });
  const ordinary = await driver.prepareOrdinaryReservation(f);
  await driver.start(f, 'backfill');
  const pause = await driver.pauseNext(f, 'before-publish');
  const work = driver.settle();
  try {
    await pause.reached;
    const before = await driver.inspect(f);
    await expect(ordinary.resume()).rejects.toThrow();
    expect((await driver.inspect(f)).personal).toEqual(before.personal);
  } finally {
    await pause.resume();
  }
  await work;
  await expect(ordinary.resume()).rejects.toThrow();
  await totals(f, 2, 1, 1, 0, 3);
});

test('drain waits for admitted writers and the account deletion barrier defeats in-flight rebuilds', async () => {
  const f = await driver.fixture('ready');
  const pause = await driver.pauseNext(f, 'writer-after-gate');
  const write = driver.mutate(f, 'update-entry');
  try {
    await pause.reached;
    const start = driver.start(f, 'counters');
    await driver.waitForBlocked(f, 'gate');
    await pause.resume();
    expect((await write).status).toBe(200);
    await start;
  } finally {
    await pause.resume();
  }
  const held = await driver.pauseNext(f, 'page-after-gate');
  const work = driver.settle();
  try {
    await held.reached;
    const deletion = driver.deleteOwner(f);
    await driver.waitForBlocked(f, 'account');
    await held.resume();
    await deletion;
  } finally {
    await held.resume();
  }
  await Promise.allSettled([work]);
  await deletedDenied(f);
  await driver.recover();
  await driver.settle();
  expect((await driver.inspect(f)).gate!.mode).toBe('purged');
});

test('purge wins after source release and stale ordinary reservations or old runs cannot resurrect', async () => {
  const f = await driver.fixture('legacy', { longType });
  const ordinary = await driver.prepareOrdinaryReservation(f);
  await driver.start(f, 'backfill');
  const pause = await driver.pauseNext(f, 'after-type-source-release');
  const work = driver.settle();
  let jobs: unknown[];
  try {
    await pause.reached;
    jobs = await driver.captureJobs(f);
    await driver.deleteOwner(f);
  } finally {
    await pause.resume();
  }
  await Promise.allSettled([work]);
  await expect(ordinary.resume()).rejects.toThrow();
  await driver.recover();
  await driver.settle();
  const purged = await driver.inspect(f);
  expect(purged.gate!.mode).toBe('purged');
  await driver.redeliver(jobs!);
  await driver.settle();
  expect((await driver.inspect(f)).privateRows).toEqual(purged.privateRows);
  expect(purged.privateRows).toEqual([]);
});

test('all deletion paths finish bounded child cleanup with retained public artifacts and honest native receipts', async () => {
  for (const path of ['ordinary', 'no-continuation', 'organization-close'] as const) {
    const f = await driver.fixture('ready', { large: true });
    await driver.deleteOwner(f, path); // Must return while Library dispatch remains held.
    await deletedDenied(f);
    await driver.recover();
    await driver.settle();
    const s = await driver.inspect(f);
    expect(s.gate).toMatchObject({ mode: 'purged', ready: false });
    expect(s.privateRows).toEqual([]);
    expect(s.retainedPublic).toEqual(f.retainedPublic);
    expect(s.detachedLogs).toEqual(f.detachedLogs);
    expect(s.intents).toEqual([]);
    const terminal = s.receipts.filter((r) => r.terminal && r.binding.runId === s.gate!.runId);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.sharedEvidence).toBe('separate-contract');
    expect(s.sharedEvidence).toEqual(expect.arrayContaining(['core', 'workflow-history']));
    for (const phase of SHELF_PURGE_PHASES) expect(s.receipts.some((r) => r.phase === phase)).toBe(true);
    expect(new Set(s.workflows.filter((w) => w.runId === s.gate!.runId).map((w) => w.segment)).size).toBeGreaterThan(1);
    bounds(s);
  }
});

test('every purge phase resumes through commit enqueue and ack crashes to one terminal native receipt', async () => {
  for (const phase of SHELF_PURGE_PHASES)
    for (const boundary of phaseCrashes(phase)) {
      const f = await driver.fixture('ready');
      await faultRun(f, phase, boundary, async () => {
        await driver.deleteOwner(f);
        await driver.settle();
      });
      const s = await driver.inspect(f);
      expect(s.gate!.mode).toBe('purged');
      expect(s.privateRows).toEqual([]);
      expect(s.receipts.filter((r) => r.terminal && r.binding.runId === s.gate!.runId)).toHaveLength(1);
      bounds(s);
    }
});
