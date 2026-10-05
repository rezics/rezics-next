import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../config.ts';
import { AppHostResourceLost, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  type RefreshActions, type RefreshInputs } from '../refresh.ts';
import { inspectRefresh, lostRefreshResources, printRefreshPlan, refreshAspireOutput,
  refreshHeavyLockHeld, refreshProcessAlive, rehearseRefreshMigrations } from '../refresh-stack.ts';
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
      'build-image', 'rehearse-migrations', 'stop-writers', 'prepare-storage', 'align-model',
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
        ...('pendingMigrations' in changes ? ['rehearse-migrations'] as const : []),
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
  return { buildImage: step('buildImage'), rehearseMigrations: step('rehearseMigrations'),
    stopWriters: step('stopWriters'), prepareStorage: step('prepareStorage'),
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

  test('a failing pending migration aborts before stopping writers and reports its error', async () => {
    const events: string[] = [];
    const plan = refreshPlan({ ...current, pendingMigrations: ['services/main/migrations/access/broken.sql'] });
    await expect(executeRefresh(plan, actions(events, 'rehearseMigrations')))
      .rejects.toThrow('failed rehearseMigrations');
    expect(events).toEqual(['rehearseMigrations']);
    const retry: string[] = [];
    await executeRefresh(plan, actions(retry));
    expect(retry).toEqual(['rehearseMigrations', 'stopWriters', 'prepareStorage', 'alignModel',
      'restartResources', 'waitReady', 'approveZones', 'recordSuccess']);
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

describe('pending SQL migration rehearsal', () => {
  const env = { ACCESS_DATABASE_URL: 'access-db', MAIN_RELAY_DATABASE_URL: 'relay-db',
    CONTENT_DATABASE_URL: 'content-db', ACCOUNT_DATABASE_URL: 'account-db' };

  function fixture() {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp/refresh-migrations-'));
    for (const owner of ['services/main/migrations/access', 'services/main/migrations/relay',
      'services/content/migrations', 'services/account/migrations']) mkdirSync(join(dir, owner), { recursive: true });
    const first = 'services/main/migrations/access/001_backfill.sql';
    const second = 'services/main/migrations/access/002_constraint.sql';
    const content = 'services/content/migrations/001_content.sql';
    writeFileSync(join(dir, first), 'UPDATE access.event SET epoch = 1;');
    writeFileSync(join(dir, second), 'ALTER TABLE access.event ADD CHECK (epoch > 0);');
    writeFileSync(join(dir, content), 'ALTER TABLE content.event ADD COLUMN epoch bigint;');
    return { dir, first, second, content };
  }

  test('only pending files run in migration order with one rollback per owner database', async () => {
    const { dir, first, second, content } = fixture();
    const events: string[] = [];
    try {
      await rehearseRefreshMigrations(dir, env, [content, second, first], url => ({
        connect: async () => { events.push(`connect:${url}`); },
        query: async sql => { events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql); },
        end: async () => { events.push('end'); },
      }));
      expect(events).toEqual(['connect:access-db', 'BEGIN', 'isolate-sequences',
        readFileSync(join(dir, first), 'utf8'),
        readFileSync(join(dir, second), 'utf8'), 'ROLLBACK', 'end',
        'connect:content-db', 'BEGIN', 'isolate-sequences', readFileSync(join(dir, content), 'utf8'), 'ROLLBACK', 'end']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const fails of [false, true]) {
    test(fails ? 'a failing dependent second migration names that file and leaves writers running'
      : 'a second pending migration can consume the first migration before owner rollback', async () => {
      const { dir, first, second } = fixture();
      const events: string[] = [];
      let tableExists = false;
      writeFileSync(join(dir, first), 'CREATE TABLE dependency(value integer CHECK (value > 0));');
      writeFileSync(join(dir, second), `INSERT INTO dependency VALUES (${fails ? -1 : 1});`);
      const operations = actions(events);
      operations.rehearseMigrations = () => rehearseRefreshMigrations(dir, env, [second, first], () => ({
        connect: async () => { events.push('connect'); },
        query: async sql => {
          events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql);
          if (sql.startsWith('CREATE TABLE')) tableExists = true;
          if (sql.startsWith('INSERT')) {
            if (!tableExists) throw new Error('relation dependency does not exist');
            if (fails) throw new Error('dependency value violates check constraint');
          }
          if (sql === 'ROLLBACK') tableExists = false;
        },
        end: async () => { events.push('end'); },
      }));
      try {
        const run = executeRefresh(refreshPlan({ ...current, pendingMigrations: [second, first] }), operations);
        if (fails) {
          await expect(run).rejects.toThrow(`Migration rehearsal failed: ${second}: dependency value violates check constraint`);
          expect(events).not.toContain('stopWriters');
          expect(events).not.toContain('recordSuccess');
        } else {
          await run;
          expect(events.indexOf('stopWriters')).toBeGreaterThan(events.indexOf('ROLLBACK'));
          expect(events.at(-1)).toBe('recordSuccess');
        }
        expect(events.slice(0, 7)).toEqual(['connect', 'BEGIN', 'isolate-sequences',
          readFileSync(join(dir, first), 'utf8'), readFileSync(join(dir, second), 'utf8'), 'ROLLBACK', 'end']);
        expect(tableExists).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const diagnostic of ['immutable rows cannot be updated', 'canceling statement due to lock timeout',
    'terminating connection due to transaction timeout']) {
    test(`${diagnostic} rolls back, closes the client and preserves writers`, async () => {
      const { dir, first, second, content } = fixture();
      const events: string[] = [];
      const operations = actions(events);
      operations.rehearseMigrations = () => rehearseRefreshMigrations(dir, env, [first, second, content], url => ({
        connect: async () => { events.push(`connect:${url}`); },
        query: async sql => {
          events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql);
          if (sql.startsWith('UPDATE')) throw new Error(diagnostic);
          if (sql === 'ROLLBACK' && diagnostic.includes('transaction timeout')) throw new Error('Connection closed');
        },
        end: async () => { events.push('end'); },
      }));
      try {
        await expect(executeRefresh(refreshPlan({ ...current, pendingMigrations: [first, second, content] }), operations))
          .rejects.toThrow(`Migration rehearsal failed: ${first}: ${diagnostic}. Writers were not stopped`);
        expect(events).toEqual(['connect:access-db', 'BEGIN', 'isolate-sequences',
          readFileSync(join(dir, first), 'utf8'), 'ROLLBACK', 'end']);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('no pending migrations opens no database connections', async () => {
    await rehearseRefreshMigrations(root, env, [], () => { throw new Error('Must not connect'); });
  });

  for (const fails of [false, true]) {
    test.skipIf(process.env.REZICS_REFRESH_SEQUENCE_PROBE !== '1')(`live PostgreSQL dependent migrations ${fails ? 'fail in the second file' : 'pass'} and restore schema, rows and sequences`, async () => {
      const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: root, encoding: 'utf8' });
      if (git.status !== 0) throw new Error('Cannot locate the shared checkout');
      const sharedEnv = readEnv(join(dirname(git.stdout.trim()), '.temp/stack/rezics-dev/dev.env'));
      const { dir, first, second } = fixture();
      const client = new Client({ connectionString: sharedEnv.ACCESS_DATABASE_URL, connectionTimeoutMillis: 5_000,
        lock_timeout: 1_000, statement_timeout: 5_000, options: '-c transaction_timeout=10000' });
      writeFileSync(join(dir, first), 'CREATE TEMP TABLE refresh_probe_dependency(value integer CHECK (value > 0));');
      writeFileSync(join(dir, second), `SELECT nextval('pg_temp.refresh_probe_sequence');
        SELECT setval('pg_temp.refresh_probe_sequence', 900);
        UPDATE refresh_probe_rows SET value = 2;
        INSERT INTO refresh_probe_dependency VALUES (${fails ? -1 : 1});`);
      try {
        const run = rehearseRefreshMigrations(dir, sharedEnv, [second, first], () => ({
          connect: async () => {
            await client.connect();
            await client.query('CREATE TEMP SEQUENCE refresh_probe_sequence START 42');
            await client.query('SELECT nextval(\'pg_temp.refresh_probe_sequence\')');
            await client.query('CREATE TEMP TABLE refresh_probe_rows(value integer)');
            await client.query('INSERT INTO refresh_probe_rows VALUES (1)');
          },
          query: sql => client.query(sql),
          end: async () => {
            try {
              expect((await client.query('SELECT last_value::text, is_called FROM pg_temp.refresh_probe_sequence')).rows)
                .toEqual([{ last_value: '42', is_called: true }]);
              expect((await client.query('SELECT value FROM refresh_probe_rows')).rows).toEqual([{ value: 1 }]);
              expect((await client.query("SELECT to_regclass('pg_temp.refresh_probe_dependency') AS relation")).rows)
                .toEqual([{ relation: null }]);
            } finally { await client.end(); }
          },
        }));
        if (fails) await expect(run).rejects.toThrow(`Migration rehearsal failed: ${second}:`);
        else await run;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);
  }
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
