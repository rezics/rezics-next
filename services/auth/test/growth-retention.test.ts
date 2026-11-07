import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { copiesAbsent } from '../src/erasure-copy.ts';
import { readAuthSdkFence } from '../src/sdk-retirement-fence.ts';
import { AUTH_MAINTENANCE_SCHEDULE } from '../src/maintenance.ts';
import { WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';
import {
  nativeFixture,
  runNativeRetentionTick,
  unconsumedRegistration,
  consumedRetentionRequest,
} from './support/erasure-native.ts';
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

async function runRetentionGrowth(kind: 'full' | 'short') {
  for (const axis of retentionAxes) {
    const retired = kind === 'full' ? 1000 : 10;
    const targets = consumableGrowth({
      name: `retention-${kind}-${axis}`,
      async setup(current, _scale, id) {
        const personal = await unconsumedRegistration(f, id);
        const source = await consumedRetentionRequest(f, `${id}-request`);
        await current.admin.query(
          'UPDATE auth_dbos.workflow_status SET created_at=$2,completed_at=$2 WHERE workflow_uuid=ANY($1)',
          [[personal, ...source.copies], now - 90 * 86400000],
        );
        const tag = await prepareRetentionPage(current, id, retired, 1 + source.copies.length, now);
        return { personal, tag, source };
      },
      async run(current, _scale, id, target) {
        await runNativeRetentionTick(current.admin, `z:tick:${id}`);
        return target;
      },
    });
    const report = await checkGrowth(db, {
      name: `${kind} Auth workflow retention batch: ${axis}`,
      scales: retentionScales,
      repetitions: 1,
      captureMode: 'cost-folded',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      // Raw selection, upper key, native custody/role/source/artifact probes,
      // SDK closure, every deletion family and the request-retention trigger.
      indexProbes: 200 + 32 * retired,
      grow: (current, scale) => seedRetentionAxes(current, axis, scale, now),
      ...targets.hooks,
      async verify(current, _scale, _repetition, value) {
        const target = value as { personal: string; tag: string; source: { request: string; copies: string[] } };
        expect(await copiesAbsent(f.pool, target.personal)).toBe(true);
        for (const copy of target.source.copies) expect(await copiesAbsent(f.pool, copy)).toBe(true);
        expect(
          (
            await current.admin.query('SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1', [
              target.source.request,
            ])
          ).rowCount,
        ).toBe(0);
        expect(await readAuthSdkFence(target.personal)).toMatchObject({ workflowID: target.personal, generation: '2' });
        expect(
          (
            await current.admin.query(
              'SELECT ready,retired,absent,rows,bytes FROM auth_copy_work WHERE workflow_id=$1',
              [target.personal],
            )
          ).rows[0],
        ).toEqual({ ready: true, retired: true, absent: true, rows: 0, bytes: 0 });
        expect(
          (await current.admin.query('SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1', [target.personal]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await current.admin.query('SELECT 1 FROM auth_copy_artifact WHERE workflow_id=ANY($1)', [
              [target.personal, ...target.source.copies],
            ])
          ).rowCount,
        ).toBe(0);
        const technical = (
          await current.admin.query<{ workflow_uuid: string }>(
            'SELECT workflow_uuid FROM auth_dbos.workflow_writer_fences WHERE workflow_uuid LIKE $1 AND closed_at IS NOT NULL',
            [`${target.tag}%`],
          )
        ).rows;
        expect(technical).toHaveLength(retired - 1 - target.source.copies.length);
        for (const table of [
          'workflow_status',
          'workflow_input',
          'workflow_output',
          'operation_outputs',
          'workflow_events',
          'workflow_events_history',
        ])
          expect(
            (
              await current.admin.query(
                `SELECT count(*)::int AS n FROM auth_dbos.${table} WHERE workflow_uuid LIKE $1`,
                [`${target.tag}%`],
              )
            ).rows[0].n,
          ).toBe(1000 - retired);
      },
    });
    expect(targets.invocations.every(({ outcome }) => outcome === 'succeeded')).toBe(true);
    for (const sample of report.samples) {
      expect(sample.cost.statements).toBeGreaterThan(50);
      expect(sample.cost.rows).toBeGreaterThanOrEqual(1000);
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
          kind,
          axis,
          scale: sample.scale,
          cost: sample.cost,
          native: sample.occurrenceRepetitions,
          background: sample.cost.backgroundCosts,
        }),
      );
    }
  }
}

test('a full Auth retention batch stays constant as workflow and request history grow', async () => {
  await runRetentionGrowth('full');
}, 360000);
test('a short Auth retention batch stays constant as workflow and request history grow', async () => {
  await runRetentionGrowth('short');
}, 360000);
