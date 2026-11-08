import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { AUTH_MAINTENANCE_SCHEDULE } from '../src/maintenance.ts';
import { WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';
import { nativeFixture, runNativeRetentionTick } from './support/erasure-native.ts';
import {
  consumableGrowth,
  prepareRetentionPage,
  retentionAxes,
  retentionScales,
  seedRetentionAxes,
} from './support/consumable-growth.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof nativeFixture>>;
const now = Date.now();
beforeAll(async () => {
  f = await nativeFixture({
    openPool: async (url) => {
      db = await openGrowthDatabase(url);
      return db.openPool();
    },
  });
  await DBOS.pauseSchedule(AUTH_MAINTENANCE_SCHEDULE);
  await DBOS.pauseSchedule(WORKFLOW_RETENTION_SCHEDULE);
});
afterAll(async () => {
  await f.close({ keepPool: true });
  await db.close();
});

async function emptyGrowth(drain: boolean) {
  for (const axis of retentionAxes) {
    const pages = drain ? 4 : 1;
    const targets = consumableGrowth({
      name: `retention-empty-${drain ? 'drain' : 'zero'}-${axis}`,
      setup: (current, _scale, id) => prepareRetentionPage(current, id, drain ? 1 : 0, false, now, 1000 * pages),
      async run(current, _scale, id, tag) {
        // Charge the initial drain and every repeated-empty page in this capture.
        // No warm-up consumes any of these raw candidates.
        for (let page = 0; page < pages; page++)
          await runNativeRetentionTick(current.admin, `z:empty-tick:${id}:${page}`);
        return { tag, id };
      },
    });
    const report = await checkGrowth(db, {
      name: `${drain ? 'post-drain repeated-empty' : 'zero-eligible'} Auth retention: ${axis}`,
      scales: retentionScales,
      repetitions: 1,
      captureMode: 'cost-folded',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      indexProbes: 100 * pages,
      grow: (current, scale) => seedRetentionAxes(current, axis, scale, now),
      ...targets.hooks,
      async verify(current, _scale, _repetition, value) {
        const { tag, id } = value as { tag: string; id: string };
        expect(
          (
            await current.admin.query(
              'SELECT count(*)::int AS n FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE $1',
              [`${tag}%`],
            )
          ).rows[0].n,
        ).toBe(1000 * pages - (drain ? 1 : 0));
        expect(
          (
            await current.admin.query(
              'SELECT count(*)::int AS n FROM auth_workflow_request WHERE workflow_id LIKE $1',
              [`${tag}%`],
            )
          ).rows[0].n,
        ).toBe(1000 * pages);
        for (let page = 0; page < pages; page++) {
          const output = (
            await current.admin.query(
              'SELECT output FROM auth_dbos.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id',
              [`z:empty-tick:${id}:${page}`],
            )
          ).rows;
          // The count-only step records one retirement followed by genuine zeros.
          expect(output.map(({ output }) => JSON.parse(output).json)).toEqual([drain && page === 0 ? 1 : 0]);
        }
        const saved = (await current.admin.query('SELECT continuation FROM auth_workflow_retention')).rows[0]
          .continuation;
        if (saved !== null) {
          expect(saved.lastExaminedKey.workflowID).toBe(`${tag}${String(1000 * pages).padStart(6, '0')}`);
          expect(saved.applicationName).toBe('rezics-auth-accounts');
        }
      },
    });
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThanOrEqual(1000 * pages);
      const workflowPlans = Object.values(sample.cost.relations).filter(
        ({ identity }) => identity?.schema === 'auth_dbos' && identity.name === 'workflow_status',
      );
      expect(workflowPlans.length).toBeGreaterThan(0);
      expect(workflowPlans.every(({ sequentialScans }) => sequentialScans === 0)).toBe(true);
      expect(sample.cost.requestBytes).toBeGreaterThan(0);
      expect(sample.cost.responseBytes).toBeGreaterThan(0);
      console.info(
        JSON.stringify({
          revision: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
          axis,
          scale: sample.scale,
          pages,
          cost: sample.cost,
          native: sample.occurrenceRepetitions,
          background: sample.cost.backgroundCosts,
        }),
      );
    }
  }
}

test('zero-eligible Auth retention examines bounded workflow history and preserves recent requests', async () => {
  await emptyGrowth(false);
}, 360000);
test('Auth retention charges the drain and bounds repeated empty batches as request history grows', async () => {
  await emptyGrowth(true);
}, 360000);
