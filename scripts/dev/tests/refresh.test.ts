import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  type RefreshActions, type RefreshInputs } from '../refresh.ts';
import { refreshHeavyLockHeld, refreshSharedStack } from '../refresh-stack.ts';

const root = resolve(import.meta.dir, '../../..');
const current: RefreshInputs = { revision: 'committed-main', previousRevision: 'committed-main',
  imagePresent: true, storageChanged: false, pendingMigrations: [], modelCurrent: true,
  unhealthyResources: [], environmentChanges: [], appHostChanged: false };

describe('shared stack refresh planning', () => {
  test('a second successful run has no mutating steps', () => {
    expect(refreshPlan(current)).toEqual({ steps: [], blockers: [] });
  });

  test('a missing pinned image is built before stopped-writer storage and model maintenance', () => {
    expect(refreshPlan({ ...current, imagePresent: false, storageChanged: true,
      pendingMigrations: ['access/new.sql'], modelCurrent: false }).steps).toEqual([
      'build-image', 'stop-writers', 'prepare-storage', 'align-model',
      'restart-resources', 'wait-ready', 'record-success',
    ]);
  });

  for (const [reason, changes] of [
    ['first refresh', { previousRevision: undefined }],
    ['new committed main', { revision: 'merged-main' }],
    ['container drift', { storageChanged: true }],
    ['pending Access migration', { pendingMigrations: ['access/new.sql'] }],
  ] as const) {
    test(`${reason} prepares storage and aligns the model before restarting`, () => {
      expect(refreshPlan({ ...current, ...changes }).steps).toEqual([
        'stop-writers', 'prepare-storage', 'align-model', 'restart-resources', 'wait-ready', 'record-success',
      ]);
    });
  }

  test('a stale model generation is aligned without unnecessary storage work', () => {
    expect(refreshPlan({ ...current, modelCurrent: false }).steps).toEqual([
      'stop-writers', 'align-model', 'restart-resources', 'wait-ready', 'record-success',
    ]);
  });

  test('a failed relay is recovered even at an already recorded revision', () => {
    expect(refreshPlan({ ...current, unhealthyResources: ['main-relay'] }).steps).toEqual([
      'stop-writers', 'restart-resources', 'wait-ready', 'record-success',
    ]);
  });

  test('environment drift and changed topology require an AppHost restart', () => {
    const plan = refreshPlan({ ...current, environmentChanges: ['NEW_TOKEN'], appHostChanged: true });
    expect(plan.blockers).toHaveLength(2);
    expect(plan.blockers.join('\n')).toContain('restart the AppHost with task dev');
    expect(plan.blockers.join('\n')).toContain('NEW_TOKEN');
  });

  test('environment comparison ignores ordering and reports only changed names', () => {
    expect(changedEnvironment({ A: '1', PASSWORD: 'old-secret' }, { PASSWORD: 'new-secret', B: '2' }))
      .toEqual(['A', 'B', 'PASSWORD']);
    expect(changedEnvironment({ A: '1', B: '2' }, { B: '2', A: '1' })).toEqual([]);
  });
});

function actions(events: string[], fail?: keyof RefreshActions): RefreshActions {
  const step = (name: keyof RefreshActions) => async () => {
    events.push(name);
    if (name === fail) throw new Error(`failed ${name}`);
  };
  return { buildImage: step('buildImage'), stopWriters: step('stopWriters'), prepareStorage: step('prepareStorage'),
    alignModel: step('alignModel'), restartResources: step('restartResources'), waitReady: step('waitReady'),
    recordSuccess: step('recordSuccess') };
}

describe('shared stack refresh execution and guards', () => {
  test('worktrees, other branches and tracked edits are refused', () => {
    expect(() => assertRefreshCheckout(true, 'main', false)).toThrow('never in a worktree');
    expect(() => assertRefreshCheckout(false, 'feature', false)).toThrow('committed main');
    expect(() => assertRefreshCheckout(false, 'main', true)).toThrow('committed main');
    expect(() => assertRefreshCheckout(false, 'main', false)).not.toThrow();
  });

  test('blocked preflight makes no changes', async () => {
    const events: string[] = [];
    await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged', environmentChanges: ['NEW_TOKEN'] }),
      actions(events))).rejects.toThrow('restart the AppHost');
    expect(events).toEqual([]);
  });

  test('success is recorded only after ordered maintenance and readiness', async () => {
    const events: string[] = [];
    await executeRefresh(refreshPlan({ ...current, imagePresent: false }), actions(events));
    expect(events).toEqual(['buildImage', 'stopWriters', 'prepareStorage', 'alignModel',
      'restartResources', 'waitReady', 'recordSuccess']);
    events.length = 0;
    await executeRefresh(refreshPlan(current), actions(events));
    expect(events).toEqual([]);
  });

  for (const failure of ['prepareStorage', 'alignModel', 'restartResources', 'waitReady'] as const) {
    test(`${failure} failure records no successful refresh and can be retried`, async () => {
      const events: string[] = [];
      const plan = refreshPlan({ ...current, revision: 'merged' });
      await expect(executeRefresh(plan, actions(events, failure))).rejects.toThrow(`failed ${failure}`);
      expect(events).not.toContain('recordSuccess');
      const retry: string[] = [];
      await executeRefresh(plan, actions(retry));
      expect(retry.at(-1)).toBe('recordSuccess');
    });
  }

  test('heavy lock inspection detects live owners and the creation race without modifying stale locks', () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp/refresh-lock-'));
    const lock = join(dir, 'heavy');
    try {
      expect(refreshHeavyLockHeld(lock)).toBe(false);
      mkdirSync(lock);
      expect(refreshHeavyLockHeld(lock, () => false)).toBe(true);
      writeFileSync(join(lock, 'pid'), '99999999');
      const old = new Date(Date.now() - 20_000);
      utimesSync(lock, old, old);
      expect(refreshHeavyLockHeld(lock, () => true)).toBe(true);
      expect(refreshHeavyLockHeld(lock, () => false)).toBe(false);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('99999999');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(process.env.REZICS_REFRESH_SHARED_DRY_RUN !== '1')('dry-run inspects the shared stack without preparation or configuration writes', async () => {
    const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8' });
    if (git.status !== 0) throw new Error('Cannot locate the shared checkout');
    const shared = dirname(git.stdout.trim());
    const stack = join(shared, '.temp/stack/rezics-dev');
    const files = ['compose.env', 'apps.env', 'dev.env'];
    const before = files.map(file => ({ bytes: readFileSync(join(stack, file), 'utf8'), mtime: statSync(join(stack, file)).mtimeMs }));
    try {
      await refreshSharedStack(shared, ['--dry-run'], { prepare: async () => { throw new Error('Dry-run attempted preparation'); } });
    } finally {
      files.forEach((file, index) => {
        expect(readFileSync(join(stack, file), 'utf8')).toBe(before[index]!.bytes);
        expect(statSync(join(stack, file)).mtimeMs).toBe(before[index]!.mtime);
      });
    }
  }, 60_000);
});
