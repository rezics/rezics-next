import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { firstFailure, git } from './merge.ts';
import { promote } from './promotion.ts';
import type { PromotionRun } from './types.ts';
import { integrationHarness } from './test-support.ts';

setDefaultTimeout(30_000);

const success = { passed: true, output: '', timedOut: false };

test('a matching failure on main is classified as an environment failure through the promotion entry', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('candidate');
    const mainBase = h.head('main');
    const devHead = h.head();
    git(h.root, 'branch', 'stabilize', devHead);
    const failure = firstFailure('AssertionError: shared baseline failure');
    const run: PromotionRun = {
      id: 'promotion-baseline-fixture',
      phase: 'classify-main',
      mainBase,
      devHead,
      taskIds: [task.id],
      rootGate: ['fixture-gate'],
      promotionParallelism: h.settings.promotionParallelism,
      boundaries: [{ taskId: task.id, commit: task.integratedCommit! }],
      headResults: [
        {
          commit: devHead,
          command: ['fixture-gate'],
          passed: false,
          timedOut: false,
          firstFailure: failure,
        },
      ],
      prefixResults: [],
      failedCommand: ['fixture-gate'],
      firstFailure: failure,
    };
    h.store.savePromotion(run);
    const checked: { commit: string; command: string[] }[] = [];

    await h.promote(async (command, cwd) => {
      checked.push({ commit: git(cwd, 'rev-parse', 'HEAD'), command: [...command] });
      return { passed: false, output: 'AssertionError: shared baseline failure', timedOut: false };
    });

    expect(checked).toEqual([{ commit: mainBase, command: ['fixture-gate'] }]);
    expect(h.head('main')).toBe(mainBase);
    expect(h.head()).toBe(devHead);
    expect(h.store.promotion()).toMatchObject({ phase: 'report-environment', mainResult: { passed: false } });
  } finally {
    h.dispose();
  }
});

test('a stale verifier ref thousands of commits behind cannot pin promotion or bypass the frozen candidate gate', async () => {
  const h = integrationHarness();
  try {
    await h.seed('eligible-feature');
    const originalMain = h.head('main');
    git(h.root, 'update-ref', 'refs/heads/dev-verified', originalMain);
    const previousDev = h.head('dev');
    const latestTree = join(h.settings.stateDirectory, 'latest-without-manifest');
    git(h.root, 'worktree', 'add', '--detach', latestTree, previousDev);
    git(latestTree, 'rm', 'package.json');
    git(latestTree, 'commit', '-m', 'prepare gate fixture');
    const preparedHead = git(latestTree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/dev', preparedHead, previousDev);
    git(h.root, 'worktree', 'remove', '--force', latestTree);
    const count = 1200;
    const now = Math.floor(Date.now() / 1000);
    const input: string[] = [];
    for (let index = 0; index < count; index++) {
      input.push(
        'commit refs/heads/dev',
        `mark :${index + 1}`,
        `committer Fixture <fixture@example.invalid> ${now + index} +0000`,
        'data 1',
        'x',
        `from ${index === 0 ? preparedHead : `:${index}`}`,
        '',
      );
    }
    const imported = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: h.root,
      encoding: 'utf8',
      input: `${input.join('\n')}\n`,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(imported.status).toBe(0);
    const latest = h.head('dev');
    expect(Number(git(h.root, 'rev-list', '--count', 'dev-verified..dev'))).toBeGreaterThanOrEqual(count);

    h.settings.gate = ['root-gate'];
    const gated: { command: string; candidate: string }[] = [];
    await h.promote(async (command, cwd) => {
      gated.push({ command: command.join(' '), candidate: git(cwd, 'rev-parse', 'HEAD') });
      return command[0] === 'true'
        ? { passed: false, output: 'AssertionError: fresh task acceptance gate required', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    });

    expect(h.head('stabilize')).toBe(latest);
    expect(h.head('main')).toBe(originalMain);
    expect(gated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'root-gate', candidate: latest }),
        expect.objectContaining({ command: 'true', candidate: latest }),
      ]),
    );
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally {
    h.dispose();
  }
});

test('promotion publishes the exact gated candidate onto main', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('candidate');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    const gated: string[] = [];
    await h.promote(async (command, cwd) => {
      if (command[0] === 'true') gated.push(git(cwd, 'rev-parse', 'HEAD'));
      return success;
    });
    const published = h.head('main');
    expect(gated.length).toBeGreaterThan(0);
    expect(new Set(gated)).toEqual(new Set([published]));
    expect(h.store.task(task.id).state).toBe('merged');
    expect(h.store.task(task.id).mergedCommit).toBe(published);
    expect(h.store.promotion()).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('beforeAdvance concurrent main fast-forward still publishes the gated candidate', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('candidate');
    const originalMain = h.head('main');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    let seen = '';
    await promote({
      settings: h.settings,
      job: h.job,
      runGate: async () => success,
      beforeAdvance: () => {
        seen = h.head('main');
        git(h.root, 'merge', '--ff-only', '--no-edit', candidate);
      },
    });
    await h.job.drain();
    expect(seen).toBe(originalMain);
    expect(h.head('main')).toBe(candidate);
    expect(h.store.task(task.id).state).toBe('merged');
    expect(h.store.promotion()).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('an already-published main head replays without moving refs', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('candidate');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    await h.promote(async () => success);
    const published = h.head('main');
    expect(h.store.task(task.id).state).toBe('merged');
    h.store.savePromotion({
      id: 'replay-publish',
      phase: 'publish-main',
      mainBase: published,
      devHead: published,
      taskIds: [task.id],
      rootGate: ['true'],
      promotionParallelism: h.settings.promotionParallelism,
      boundaries: [{ taskId: task.id, commit: published }],
      headResults: [],
      prefixResults: [],
      promoteHead: published,
      promoteTaskIds: [task.id],
    });
    await h.promote(async () => {
      throw new Error('already-published replay cannot run a gate');
    });
    expect(h.head('main')).toBe(published);
    expect(h.store.task(task.id).state).toBe('merged');
    expect(h.store.promotion()).toBeUndefined();
  } finally {
    h.dispose();
  }
});
