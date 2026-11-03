import { expect, test } from 'bun:test';
import { COMMON_ACTIONS, GLOBAL, IMPORT_ACTIONS } from '../../../../specs/imports-identity-driver.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { checkGrowth, capture, costOf, assertGrowth, settle, type GrowthSample } from '../support/growth.ts';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport } from './identity-fixture.ts';

test('fixed public bulk grant changes and reduced-scope native Auth/Access remain bounded across actual history growth', async () => {
  const driver = createImportIdentityDriver();
  try {
    const f = await driver.open({ clock: () => new Date() });
    const native = identitySupport(f);
    // Stay beyond the planner's small-table crossover at the first scale. All
    // baseline accounts, keys, openings, sessions and receipts are native effects.
    await native.seedBaseline(256);
    const authSamplesByScale = new Map<number, GrowthSample>();
    const bounds = { statements: 'constant', rows: 'constant', blocks: 'logarithmic' } as const;
    // Registration, credential installation, growing histories and issuance
    // seeding are outside measurement. Measured issuance is captured separately
    // on the real owning Auth pool, alongside the exact application pool capture.
    const report = await checkGrowth(f.database, {
      name: 'identity public grant revoke/restore and reduced Auth scope',
      bounds,
      repetitions: 1,
      grow: async (_db, scale, previous) => {
        for (let i = previous; i < scale; i++) await native.grow(256 + i);
        await native.host.workflows.close();
        for (const table of [
          'access.account',
          'access.resource_grant',
          'access.workflow_approval',
          'access.operator_opening_receipt',
          'core.receipt',
          'core.outbox',
        ])
          await f.database.admin.query(`VACUUM (ANALYZE) ${table}`);
        // checkGrowth settles the application database; Auth owns a separate pool.
        await settle(native.authDatabase, { analyze: true });
        if (scale === 1) {
          for (const table of [
            'public."user"',
            'public.account',
            'public.session',
            'public.auth_consent',
            'public.auth_public_key',
            'public.auth_effect_receipt',
          ]) {
            const result = await native.authDatabase.admin.query<{ rows: string }>(
              `SELECT count(*)::text AS rows FROM ${table}`,
            );
            expect(Number(result.rows[0]?.rows ?? 0), `${table} live row floor`).toBeGreaterThanOrEqual(2_000);
          }
          for (const table of [
            'access.account',
            'access.resource_grant',
            'core.outbox',
            'core.receipt',
            'editorial.write_basis',
          ]) {
            const result = await f.database.admin.query<{ rows: string }>(
              `SELECT count(*)::text AS rows FROM ${table}`,
            );
            expect(Number(result.rows[0]?.rows ?? 0), `${table} live row floor`).toBeGreaterThanOrEqual(2_000);
          }
        }
      },
      operation: async (_db, scale) => {
        const observed = await capture(native.authDatabase, async () => {
          await f.setBulkPermission(false);
          await f.setBulkPermission(true);
          const limited = await driver.issue(f, f.bulk.accountId, COMMON_ACTIONS);
          const context = { pool: f.database.pool, deadline: Date.now() + 10000 };
          const actor = await f.access.authenticate(limited.bearer, context);
          for (const action of [...COMMON_ACTIONS, ...IMPORT_ACTIONS]) {
            const check = await accessCheck(f.access, actor, action, GLOBAL, context);
            expect(await withConnection(f.database.pool, (client) => check(client))).toBe(
              COMMON_ACTIONS.includes(action as (typeof COMMON_ACTIONS)[number]),
            );
          }
        });
        expect(observed.capture.statements.length).toBeGreaterThan(0);
        expect(observed.capture.plans.length).toBeGreaterThan(0);
        // Warm-ups use this same operation; retain only the last run at each scale,
        // which is the measured run because repetitions is one.
        authSamplesByScale.set(scale, { scale, cost: costOf(observed.capture) });
      },
    });
    const authSamples = [...authSamplesByScale.values()];
    expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
    expect(authSamples.map((s) => s.scale)).toEqual([1, 8, 64]);
    for (const sample of report.samples) {
      expect(sample.cost.statements).toBeGreaterThan(0);
      expect(sample.cost.relations?.['access.resource_grant']).toBeDefined();
      // The fixed baseline must not conceal a scan of the growing account set.
      expect(sample.cost.relations?.['access.account']).toBeDefined();
      expect(sample.cost.relations?.['access.account']?.sequentialScans).toBe(0);
    }
    assertGrowth(authSamples, bounds);
    for (const sample of authSamples) {
      expect(sample.cost.relations?.['public.auth_public_key']).toBeDefined();
      expect(sample.cost.relations?.['public.auth_public_key']?.sequentialScans).toBe(0);
    }
    const costs = (samples: readonly GrowthSample[]) =>
      samples.map(({ scale, cost }) => ({ scale, statements: cost.statements, rows: cost.rows, blocks: cost.blocks }));
    console.info(
      'Native identity SQL costs:',
      JSON.stringify({ application: costs(report.samples), auth: costs(authSamples) }),
    );
  } finally {
    await driver.close();
  }
}, 600000);
