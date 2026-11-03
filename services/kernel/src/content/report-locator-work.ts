import { DBOS } from '@dbos-inc/dbos-sdk';
import { PARTITIONS } from '../route/route.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import type { WorkContext } from '../work/registry.ts';
import { createReportLocatorInstallationEffect, installReportLocatorPage } from './report-locator-installation.ts';

export const REPORT_LOCATOR_INSTALL_WORKFLOW = 'content.report-locator.install';

/** The default supervisor resumes a single finite migration journal. Runtime
 * history requests never scan historical reports or drive maintenance themselves. */
export function registerReportLocatorWork(context: WorkContext): void {
  const page = DBOS.registerStep((partition: number) => installReportLocatorPage(context.pool, partition), {
    name: 'content.report-locator.install-page', retriesAllowed: true, maxAttempts: 11, intervalSeconds: 1, backoffRate: 2,
  });
  DBOS.registerWorkflow(async () => {
    for (let partition = 0; partition < PARTITIONS; partition++) {
      while (!(await page(partition)).complete) { /* Each step checkpoints one acknowledged journal page. */ }
    }
  }, { name: REPORT_LOCATOR_INSTALL_WORKFLOW });
  context.addEffects([createReportLocatorInstallationEffect(context.pool)]);
  context.addService(async () => {
    await context.client.enqueue({
      applicationName: WORK_APPLICATION,
      workflowName: REPORT_LOCATOR_INSTALL_WORKFLOW,
      workflowID: `${REPORT_LOCATOR_INSTALL_WORKFLOW}:v1`,
      workflowIDReusePolicy: 'return-existing',
      queueName: 'maintenance',
    });
    return { async stop() {} };
  });
}
