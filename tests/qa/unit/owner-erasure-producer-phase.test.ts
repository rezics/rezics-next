import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../scripts/fixture/corpus.ts';
import type { RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import {
  RetainedSources, retainedSourceFailure, SOURCE_PREPARATION_MS, SOURCE_RESTORE_MS,
  type RetainedSourceAdapter,
} from '../../../scripts/qa/retained-source.ts';
import { ownerErasureSourceBuild } from '../fault-recovery/owner-restore-erasure-fixture.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup(options: { producerMs?: number; cutMs?: number; producerError?: Error; retainError?: Error; closeError?: Error } = {}) {
  const root = join(process.cwd(), '.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'owner-erasure-phase-'));
  directories.push(directory);
  let clock = 0, producers = 0, removals = 0, closed = false;
  const events: string[] = [];
  const close = async () => {
    if (options.closeError) throw options.closeError;
    if (!closed) { closed = true; events.push('close-staged-fixture'); }
  };
  const phases = ownerErasureSourceBuild(async phase => {
    producers++;
    events.push('authored-population');
    phase.registerCleanup(close);
    clock += options.producerMs ?? 599_999;
    if (options.producerError) throw options.producerError;
    const cut = await phase.physicalCut();
    expect(cut.key).toBe(phase.context.key);
    expect(cut.backup).toBe(phase.context.backup);
    expect(cut.budget).not.toBe(phase.context.budget);
    expect(cut.budget.elapsed()).toBe(0);
    events.push('recovery-fence', 'signed-coverage', 'physical-backup');
    clock += options.cutMs ?? 100;
    return {
      close,
      timing: { durations: () => ({ 'source.actual-api-fixture-work': options.producerMs ?? 599_999 }) },
      async retain(context) {
        events.push('immutable-publication');
        if (options.retainError) throw options.retainError;
        writeFileSync(join(context.backup, 'cut'), 'bounded unit backup bytes');
        clock += 100;
        return { metadata: { contract: 'unit-owner-erasure' }, ownerState: { fence: 'cut' },
          rdfDigest: sha256('unit-rdf'), producerRevision: 'unit-revision', qaIdentity: 'unit-source', phases: {} };
      },
    };
  });
  const adapter: RetainedSourceAdapter<RetainedOwnerState, never> = {
    specification: { producer: 'owner-erasure-source', version: '1', files: { fixture: sha256('unit-fixture') },
      inputs: { foregroundSeed: null }, compatibility: { native: 'unit' } },
    producerBuild: phases.producerBuild,
    build: async context => {
      events.push('cut-budget-start');
      return await phases.build(context);
    },
    async verify() { events.push('backup-verification'); clock += 100; return []; },
    async restore() { throw new Error('this unit never restores a physical source'); },
    async dispose() {},
    async remove(key) { removals++; await phases.remove(key); },
  };
  const store = new RetainedSources(join(directory, 'sources'), () => clock);
  return { directory, store, adapter, phases, events,
    counts: () => ({ producers, removals, closed }) };
}

test('owner producer suspends once before fencing and uses a fresh physical-cut budget through verification', async () => {
  const f = setup();
  const prepared = await f.store.prepare(f.adapter);
  expect(f.events).toEqual(['authored-population', 'cut-budget-start', 'recovery-fence', 'signed-coverage',
    'physical-backup', 'immutable-publication', 'close-staged-fixture', 'backup-verification', 'backup-verification']);
  expect(prepared.producerBuild).toMatchObject({ deadlineMs: 600_000, elapsedMs: 599_999, admissionWaitMs: 0 });
  expect(prepared.producerBuild!.evidence.length).toBeLessThanOrEqual(2_000);
  expect(prepared.elapsedMs).toBe(400);
  expect(prepared.manifest.provenance.producerBuild).toEqual(prepared.producerBuild);
  expect(SOURCE_PREPARATION_MS).toBe(600_000);
  expect(SOURCE_RESTORE_MS).toBe(600_000);
  expect((await f.store.prepare(f.adapter)).built).toBe(false);
  expect(f.counts().producers).toBe(1);
});

for (const [phase, options] of [
  ['producer', { producerMs: 600_001 }], ['physical-cut', { cutMs: 600_001 }],
] as const) {
  test(`owner ${phase} deadline failure removes staging without fencing another source`, async () => {
    const f = setup(options);
    const error = await f.store.prepare(f.adapter).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(retainedSourceFailure(error)?.boundary).toBe(phase === 'producer' ? 'producer-build' : 'build');
    expect(f.counts()).toEqual({ producers: 1, removals: 2, closed: true });
    expect(f.events.includes('recovery-fence')).toBe(phase !== 'producer');
    expect(f.events).not.toContain('backup-verification');
    expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
    await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
  });
}

test('producer failure preserves its error and closes only its staged fixture', async () => {
  const primary = new Error('authored population refused', { cause: new Error('admission failed') });
  const f = setup({ producerError: primary });
  const stack = primary.stack;
  await expect(f.store.prepare(f.adapter)).rejects.toBe(primary);
  expect(primary.stack).toBe(stack);
  expect(f.counts().closed).toBe(true);
  expect(f.events).toEqual(['authored-population', 'close-staged-fixture']);
});

test('publication failure stays primary when fixture cleanup fails and staging cannot be selected', async () => {
  const primary = new Error('immutable publication refused'), cleanup = new Error('staged fixture still held');
  const f = setup({ retainError: primary, closeError: cleanup });
  await expect(f.store.prepare(f.adapter)).rejects.toBe(primary);
  expect(retainedSourceFailure(primary)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  expect(f.events).not.toContain('backup-verification');
  const key = retainedSourceFailure(primary)!.key;
  expect(existsSync(join(f.directory, 'sources', key, 'manifest.json'))).toBe(false);
  expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
});

test('another source key cannot resume or remove the staged producer', async () => {
  const f = setup(), build = f.adapter.build;
  f.adapter.build = async context => {
    await f.phases.remove('rs-owner-erasure-source-sibling');
    expect(f.counts().closed).toBe(false);
    await expect(f.phases.build({ ...context, key: 'rs-owner-erasure-source-sibling' }))
      .rejects.toThrow('requires its staged producer');
    return build(context);
  };
  await f.store.prepare(f.adapter);
  expect(f.counts().producers).toBe(1);
  expect(f.events.filter(event => event === 'recovery-fence')).toHaveLength(1);
});

test('a failed producer records cleanup failure and its staged close remains retryable', async () => {
  const primary = new Error('producer interrupted'), cleanup = new Error('temporary fixture cleanup failure');
  const options = { producerError: primary, closeError: cleanup as Error | undefined };
  const f = setup(options);
  await expect(f.store.prepare(f.adapter)).rejects.toBe(primary);
  expect(retainedSourceFailure(primary)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  expect(f.events).not.toContain('recovery-fence');
  options.closeError = undefined;
  await f.phases.remove(retainedSourceFailure(primary)!.key);
  expect(f.counts().closed).toBe(true);
  await f.phases.remove(retainedSourceFailure(primary)!.key);
  expect(f.events.filter(event => event === 'close-staged-fixture')).toHaveLength(1);
});
