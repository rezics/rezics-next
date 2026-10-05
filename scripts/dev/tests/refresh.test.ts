import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppHostResourceLost, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  type RefreshActions, type RefreshInputs } from '../refresh.ts';
import { inspectRefresh, lostRefreshResources, printRefreshPlan, refreshAspireOutput,
  refreshHeavyLockHeld, refreshProcessAlive } from '../refresh-stack.ts';
import { inspectOfficialZoneApprovals } from '../seed/official-zones-step.ts';
import { officialPackageSlugs, officialSourceDigest } from '../seed/official-theme-step.ts';
import { officialTheme } from '../seed/official-plan.ts';
import { parseOptions } from '../seed/cli.ts';
import { stableId } from '../seed/state.ts';

const root = resolve(import.meta.dir, '../../..');
const current: RefreshInputs = { revision: 'committed-main', previousRevision: 'committed-main',
  imagePresent: true, storageChanged: false, pendingMigrations: [], modelCurrent: true,
  unhealthyResources: [], environmentChanges: [], appHostChanged: false, lostResources: [], zoneApprovals: [] };

describe('shared stack refresh planning', () => {
  test('a second successful run has no mutating steps', () => {
    expect(refreshPlan(current)).toEqual({ steps: [], blockers: [] });
  });

  test('a missing pinned image is built before stopped-writer storage and model maintenance', () => {
    expect(refreshPlan({ ...current, imagePresent: false, storageChanged: true,
      pendingMigrations: ['access/new.sql'], modelCurrent: false }).steps).toEqual([
      'build-image', 'stop-writers', 'prepare-storage', 'align-model',
      'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
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
        'stop-writers', 'prepare-storage', 'align-model', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
      ]);
    });
  }

  test('a stale model generation is aligned without unnecessary storage work', () => {
    expect(refreshPlan({ ...current, modelCurrent: false }).steps).toEqual([
      'stop-writers', 'align-model', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
    ]);
  });

  test('a failed relay is recovered even at an already recorded revision', () => {
    expect(refreshPlan({ ...current, unhealthyResources: ['main-relay'] }).steps).toEqual([
      'stop-writers', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
    ]);
  });

  test('environment drift and changed topology require an AppHost restart', () => {
    const plan = refreshPlan({ ...current, environmentChanges: ['NEW_TOKEN'], appHostChanged: true });
    expect(plan.blockers).toHaveLength(2);
    expect(plan.blockers.join('\n')).toContain('task dev:stop, then task dev');
    expect(plan.blockers.join('\n')).toContain('NEW_TOKEN');
  });

  test('environment comparison ignores ordering and reports only changed names', () => {
    expect(changedEnvironment({ A: '1', PASSWORD: 'old-secret' }, { PASSWORD: 'new-secret', B: '2' }))
      .toEqual(['A', 'B', 'PASSWORD']);
    expect(changedEnvironment({ A: '1', B: '2' }, { B: '2', A: '1' })).toEqual([]);
  });

  test('lost AppHost resources block refresh before writers are stopped', async () => {
    const events: string[] = [];
    const plan = refreshPlan({ ...current, lostResources: ['main-relay'], revision: 'merged' });
    expect(plan.blockers.join('\n')).toContain('main-relay');
    expect(plan.blockers.join('\n')).toContain('task dev:stop, then task dev');
    await expect(executeRefresh(plan, actions(events))).rejects.toThrow('AppHost restart required');
    expect(events).toEqual([]);
  });

  test('only changed Zone approvals require readiness and approval without stopping writers', () => {
    expect(refreshPlan({ ...current, zoneApprovals: [{ slug: 'franchise-wiki', digest: 'new', approvedDigest: 'old' }] }))
      .toEqual({ steps: ['wait-ready', 'approve-zones', 'record-success'], blockers: [] });
  });
});

function actions(events: string[], fail?: keyof RefreshActions): RefreshActions {
  const step = (name: keyof RefreshActions) => async () => {
    events.push(name);
    if (name === fail) throw new Error(`failed ${name}`);
  };
  return { buildImage: step('buildImage'), stopWriters: step('stopWriters'), prepareStorage: step('prepareStorage'),
    alignModel: step('alignModel'), restartResources: step('restartResources'), waitReady: step('waitReady'),
    approveZones: step('approveZones'), stopAppHost: step('stopAppHost'), recordSuccess: step('recordSuccess') };
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
      actions(events))).rejects.toThrow('task dev:stop');
    expect(events).toEqual([]);
  });

  test('success is recorded only after ordered maintenance and readiness', async () => {
    const events: string[] = [];
    await executeRefresh(refreshPlan({ ...current, imagePresent: false }), actions(events));
    expect(events).toEqual(['buildImage', 'stopWriters', 'prepareStorage', 'alignModel',
      'restartResources', 'waitReady', 'approveZones', 'recordSuccess']);
    events.length = 0;
    await executeRefresh(refreshPlan(current), actions(events));
    expect(events).toEqual([]);
  });

  for (const failure of ['prepareStorage', 'alignModel', 'restartResources', 'waitReady', 'approveZones'] as const) {
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

  for (const failure of ['stopWriters', 'restartResources', 'waitReady'] as const) {
    test(`lost executable during ${failure} stops the AppHost and records no checkpoint`, async () => {
      const events: string[] = [];
      const operations = actions(events);
      operations[failure] = async () => { events.push(failure); throw new AppHostResourceLost('main-relay', failure); };
      await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged' }), operations))
        .rejects.toThrow('This AppHost was stopped; data volumes were retained');
      expect(events.at(-1)).toBe('stopAppHost');
      expect(events).not.toContain('recordSuccess');
      expect(events).not.toContain('approveZones');
    });
  }

  test('failed AppHost shutdown reports the required recovery instead of claiming a safe stop', async () => {
    const operations = actions([], 'stopAppHost');
    operations.stopWriters = async () => { throw new AppHostResourceLost('main', 'stop'); };
    await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged' }), operations))
      .rejects.toThrow('Automatic AppHost shutdown failed');
  });

  test('resource inspection distinguishes unhealthy live processes from stale Running state', () => {
    const resources = { account: { name: 'account', state: 'Running', properties: { 'executable.pid': 11 } },
      main: { name: 'main', state: 'Running', healthStatus: 'Unhealthy', properties: { 'executable.pid': 12 } },
      'main-relay': { name: 'main-relay', state: 'Running', properties: { 'executable.pid': 13 } } };
    expect(lostRefreshResources(resources, pid => pid !== 13)).toEqual(['main-relay']);
    expect(lostRefreshResources({ ...resources, 'main-relay': undefined }, () => true)).toEqual(['main-relay']);
    expect(lostRefreshResources({ ...resources, 'main-relay': { name: 'main-relay', state: 'Exited' } }, () => true)).toEqual([]);
    expect(lostRefreshResources({ ...resources, 'main-relay': { name: 'main-relay', state: 'Running' } }, pid => pid > 0)).toEqual(['main-relay']);
    expect(refreshProcessAlive(process.pid)).toBe(true);
    expect(refreshProcessAlive(-1)).toBe(false);
    expect(refreshProcessAlive(99999999)).toBe(false);
  });

  for (const [args, status, stderr] of [
    [['resource', 'main-relay', 'stop'], 17, 'DCP NotFound: executable missing secret-value'],
    [['resource', 'main-relay', 'restart'], 16, ''],
    [['wait', 'main-relay'], 16, ''],
    [['wait', 'main-relay'], 1, 'resource not found'],
  ] as const) {
    test(`Aspire ${args.join(' ')} exit ${status} retains resource loss without diagnostics`, () => {
      expect(() => refreshAspireOutput([...args], { status, stdout: '', stderr })).toThrow(AppHostResourceLost);
      try { refreshAspireOutput([...args], { status, stdout: '', stderr }); }
      catch (error) { expect((error as Error).message).not.toContain('secret-value'); }
    });
  }

  test('other Aspire errors remain ordinary failures without exposing output', () => {
    expect(() => refreshAspireOutput(['resource', 'main', 'stop'], { status: 17, stdout: '', stderr: 'secret-value' }))
      .toThrow('Aspire resource failed (exit 17)');
    expect(refreshAspireOutput(['describe'], { status: 0, stdout: ' {}\n', stderr: '' })).toBe('{}');
  });

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
      const snapshot = await inspectRefresh(root, shared);
      printRefreshPlan(snapshot);
      expect(snapshot.input.lostResources).toEqual([]);
      expect(snapshot.plan.blockers).toEqual([]);
    } finally {
      files.forEach((file, index) => {
        expect(readFileSync(join(stack, file), 'utf8')).toBe(before[index]!.bytes);
        expect(statSync(join(stack, file)).mtimeMs).toBe(before[index]!.mtime);
      });
    }
  }, 60_000);
});

describe('official Zone approval refresh', () => {
  const presentation = (slug: typeof officialPackageSlugs[number], digest: string | null) => Response.json({
    presentation: { official: { theme: officialTheme(slug) } },
    execution: digest ? { state: 'package', packageDigest: digest } : { state: 'fallback', reason: 'expired' },
  });

  test('each installed official package, including franchise-wiki, compares its source against active approval', async () => {
    const requested: string[] = [];
    const changes = await inspectOfficialZoneApprovals(async path => {
      requested.push(path);
      const slug = officialPackageSlugs.find(item => path.includes(stableId(`zone:${item}`)))!;
      return presentation(slug, slug === 'franchise-wiki' ? 'old' : 'current');
    }, async () => 'current');
    expect(requested).toHaveLength(officialPackageSlugs.length);
    expect(changes).toEqual([{ slug: 'franchise-wiki', digest: 'current', approvedDigest: 'old' }]);
  });

  test('missing demo Zones do not create approvals and expired approvals are renewed', async () => {
    const changes = await inspectOfficialZoneApprovals(async path => path.includes(stableId('zone:fiction'))
      ? presentation('fiction', null) : new Response(null, { status: 404 }), async () => 'source');
    expect(changes).toEqual([{ slug: 'fiction', digest: 'source', approvedDigest: null }]);
  });

  test('custom themes are preserved and transient reads cannot be mistaken for absent approvals', async () => {
    expect(await inspectOfficialZoneApprovals(async () => Response.json({ presentation: {}, execution: {} }),
      async () => { throw new Error('custom theme must not be inspected'); })).toEqual([]);
    await expect(inspectOfficialZoneApprovals(async () => new Response(null, { status: 503 }), async () => 'source'))
      .rejects.toThrow('HTTP 503');
  });

  for (const reason of ['revoked', 'globally_disabled']) {
    test(`${reason} theme control is preserved`, async () => {
      await expect(inspectOfficialZoneApprovals(async () => Response.json({
        presentation: { official: { theme: officialTheme('fiction') } }, execution: { state: 'fallback', reason },
      }), async () => 'source')).rejects.toThrow(reason);
    });
  }

  test('approval selection is bounded to known packages and does not expand to other seed steps', () => {
    expect(parseOptions(['--themes-only', '--packages=franchise-wiki,fiction']).packages).toEqual(['franchise-wiki', 'fiction']);
    expect(() => parseOptions(['--packages=fiction'])).toThrow('--themes-only');
    expect(() => parseOptions(['--themes-only', '--packages=unknown'])).toThrow('installed official packages');
    expect(() => parseOptions(['--themes-only', '--packages=fiction,fiction'])).toThrow('installed official packages');
    expect(() => parseOptions(['--themes-only', '--packages=fiction', '--packages=fiction'])).toThrow('installed official packages');
  });

  test('approval comparison uses the same source digest as task zones:digest', async () => {
    const command = spawnSync('task', ['zones:digest', '--', 'franchise-wiki'], { cwd: root, encoding: 'utf8' });
    expect(command.status).toBe(0);
    expect(await officialSourceDigest('franchise-wiki')).toBe(command.stdout.trim());
  });
});
