import { expect, test } from 'bun:test';
import { convertBangumi } from '../../../../packages/conversion/src/bangumi.ts';
import { launchBoundaryProcess } from './media-boundary-driver.ts';
import type { GrowthSample } from '../support/growth.ts';
import type { Capture } from '../support/growth-cost.ts';

test('native public media and registered jobs stay bounded as hot media and unrelated history grow', async () => {
  const host = await launchBoundaryProcess('host');
  try {
    const { containerId } = await host.call<{ containerId: string }>('open');
    // This portable request is fixture input, with its actual public container.
    // Conversion policy and production job outcomes stay outside the driver.
    const request = convertBangumi(
      {
        external_id: '42',
        record_revision: 'native:7',
        record: { id: 42, type: 1, name: 'Book', images: { large: 'https://lain.bgm.tv/pic/cover/l/ab/cd/42.jpg' } },
      },
      { source: 'bangumi', subjectId: containerId },
    ).mediaImportIntents[0]!;
    const report = await host.call<{
      baseline: { executedJobs: number; sourceBytes: number }[];
      application: GrowthSample[];
      worker: GrowthSample[];
      auth: GrowthSample[];
      workflowBaselineRows: number;
      floors: Record<string, number>;
      raw: { worker: Capture; auth: Capture }[];
      sourceBytes: number;
      capture: { executedJobs: number; sourceRequests: { bytes: number }[]; calls: unknown[] };
    }>('growth', { request, minimumRows: 2_000 });
    for (const owner of [report.application, report.worker, report.auth])
      expect(owner.map((s) => s.scale)).toEqual([1, 8, 64]);
    for (const sample of report.application) {
      expect(sample.cost.statements).toBeGreaterThan(0);
      for (const relation of ['content.media', 'content.media_variant', 'core.receipt', 'access.account'])
        expect(sample.cost.relations?.[relation]).toBeDefined();
      for (const relation of [
        'content.media',
        'core.outbox',
        'core.receipt',
        'semantic.subject',
        'access.resource_role_grant',
      ])
        expect(sample.cost.relations?.[relation]?.sequentialScans).toBe(0);
    }
    for (const relation of [
      'content.media',
      'core.outbox',
      'core.receipt',
      'semantic.subject',
      'access.resource_role_grant',
    ])
      expect(
        report.floors[relation],
        `${relation} live row floor after scale 1 VACUUM (ANALYZE)`,
      ).toBeGreaterThanOrEqual(2_000);
    for (const sample of report.worker) {
      expect(sample.cost.relations?.['content.media']).toBeDefined();
      expect(sample.cost.relations?.['dbos.workflow_status']).toBeDefined();
      expect(sample.cost.relations?.['dbos.workflow_status']?.sequentialScans).toBe(0);
    }
    expect(report.workflowBaselineRows).toBeGreaterThanOrEqual(2_000);
    expect(report.raw.every((r) => r.worker.plans.length > 0)).toBe(true);
    expect(report.capture.executedJobs).toBeLessThanOrEqual(16);
    expect(report.capture.sourceRequests.length).toBeLessThanOrEqual(64);
    expect(report.capture.sourceRequests.every((r) => r.bytes === report.sourceBytes)).toBe(true);
    console.info(
      'Native media SQL costs:',
      JSON.stringify(
        Object.fromEntries(
          ['application', 'worker', 'auth'].map((owner) => [
            owner,
            report[owner as 'application' | 'worker' | 'auth'].map(({ scale, cost }) => ({
              scale,
              statements: cost.statements,
              rows: cost.rows,
              blocks: cost.blocks,
            })),
          ]),
        ),
      ),
    );
  } finally {
    await host.close();
  }
}, 600_000);
