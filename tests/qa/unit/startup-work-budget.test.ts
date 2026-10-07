import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FixtureWorkBudget } from '../../../scripts/fixture/budget.ts';
import { prepareFixture } from '../../../scripts/fixture/prepare.ts';
import { startRestoredFixture } from '../../../scripts/fixture/restore.ts';
import type { FixtureManifest } from '../../../scripts/fixture/manifest.ts';
import { graphRunner } from '../../../scripts/ops/backup.ts';
import { RecoveryBudget, type stackContext } from '../../../scripts/ops/recovery-set.ts';
import { GiB } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });

async function clocked<T>(work: (clock: {
  now: () => number; advance: (ms: number) => void;
  admission: {
    lockFile: string; now: () => number; pollMs: number;
    sleep: (ms: number) => Promise<void>; announce: () => void;
    read: () => Promise<{ vmTotal: number; vmUsed: number; hostAvailable: number }>;
  };
}) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(scratch, 'startup-active-budget-'));
  let at = 0;
  const now = () => at;
  const admission = { lockFile: join(directory, 'mutex.sqlite'), now, pollMs: 400_000,
    sleep: async (ms: number) => { at += ms; }, announce: () => {},
    read: async () => ({ vmTotal: 24 * GiB, vmUsed: at < 800_000 ? 24 * GiB : 0,
      hostAvailable: 20 * GiB }) };
  try { return await work({ now, advance: ms => { at += ms; }, admission }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
const qa = { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '2000000' };

test('fixture build startup can wait longer than preparation while preserving active Compose budget', async () => {
  await clocked(async ({ now, advance, admission }) => {
    const budget = new FixtureWorkBudget(600_000, now);
    advance(10_000);
    await budget.startup(root, qa, () => {
      expect(now()).toBe(810_000);
      expect(budget.remaining()).toBe(590_000);
      advance(300_000);
    }, admission);
    expect(budget.remaining()).toBe(290_000);
    expect(budget.admissionWaitMs()).toBe(800_000);
  });
});

test('fixture restore gives Compose 180 seconds after long admission and retains remaining preparation time', async () => {
  await clocked(async ({ now, advance, admission }) => {
    const budget = new FixtureWorkBudget(600_000, now);
    advance(25_000);
    await startRestoredFixture(budget, qa, timeout => {
      expect(now()).toBe(825_000);
      expect(timeout).toBe(180_000);
      expect(budget.remaining()).toBe(575_000);
      advance(timeout);
    }, admission);
    expect(budget.remaining()).toBe(395_000);
  });
});

test('fixture preparation wrapper excludes builder admission while still rejecting excessive active work', async () => {
  const manifest = { id: 'fx-small-test' } as FixtureManifest;
  let at = 0;
  const dependencies = { now: () => at, retained: () => undefined,
    build: async (_profile: string, _seed?: string, _budgetMs?: number,
      onAdmissionWait?: (ms: number) => void) => {
      at += 800_000;
      onAdmissionWait?.(800_000);
      at += 300_000;
      return manifest;
    } };
  expect(await prepareFixture('small', undefined, dependencies)).toMatchObject({
    elapsedMs: 300_000, admissionWaitMs: 800_000 });
  await expect(prepareFixture('small', undefined, { ...dependencies,
    build: async (_profile: string, _seed?: string, _budgetMs?: number,
      onAdmissionWait?: (ms: number) => void) => {
      at += 800_000;
      onAdmissionWait?.(800_000);
      at += 600_001;
      return manifest;
    } })).rejects.toThrow('600 seconds');
});

test('backup graph restart excludes long admission from the shared recovery budget', async () => {
  await clocked(async ({ now, advance, admission }) => {
    const budget = new RecoveryBudget(now);
    advance(40_000);
    const calls: string[][] = [];
    const context: ReturnType<typeof stackContext> = { directory: '', saved: {}, apps: {}, project: '',
      environment: qa, compose: args => {
        expect(budget.remaining()).toBe(560_000);
        calls.push(args);
        advance(300_000);
        return '';
      }, startup: (work, options) => budget.startup(qa, work, { ...options, ...admission }) };
    await budget.phase('restart-graph', () => graphRunner(context).start());
    expect(calls).toEqual([['up', '-d', '--wait', 'fuseki']]);
    expect(budget.remaining()).toBe(260_000);
    expect(budget.phases.memoryAdmission).toBe(800_000);
  });
});

test('held restore startup excludes admission from its phase and still enforces active work deadline', async () => {
  await clocked(async ({ now, advance, admission }) => {
    const budget = new RecoveryBudget(now);
    advance(50_000);
    await budget.phase('start-held', () => budget.startup(qa, () => {
      expect(now()).toBe(850_000);
      expect(budget.remaining()).toBe(550_000);
      advance(300_000);
    }, admission));
    expect(budget.remaining()).toBe(250_000);
    expect(budget.elapsed()).toBe(350_000);
    await expect(budget.phase('active-expiration', () => { advance(250_001); }))
      .rejects.toThrow('exceeded its 600-second budget');
  });
});

test('production recovery startup keeps its saved-profile bypass and active timeout', async () => {
  let at = 0;
  const budget = new RecoveryBudget(() => at);
  const env = { REZICS_STACK_PROFILE: 'dev', GOAL_TASK_ID: 'G-1234',
    REZICS_FUSEKI_MEMORY_LIMIT: '0', REZICS_QA_MEMORY_DEADLINE: 'invalid' };
  await budget.phase('start-held', () => budget.startup(env, () => {
    expect(budget.remaining()).toBe(600_000);
    at += 100_000;
  }, { read: async () => { throw new Error('Production must not measure QA memory'); } }));
  expect(budget.remaining()).toBe(500_000);
  expect(budget.phases.memoryAdmission).toBeUndefined();
});
