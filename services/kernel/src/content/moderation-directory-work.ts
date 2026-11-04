import { DBOS } from "@dbos-inc/dbos-sdk";
import type { WorkContext } from "../work/registry.ts";
import { WORK_APPLICATION } from "../work/client.ts";
import {
  createModerationDirectoryProjectionEffect,
  maintainModerationDirectoryPage,
} from "./moderation-directory-projection.ts";

export const MODERATION_DIRECTORY_WORKFLOW =
  "content.moderation-directory.install";

/** Additive upkeep in the existing Content supervisor, never a new runner.
 * The finite baseline advances in committed steps; process memory has no cursor.
 */
export function registerModerationDirectoryWork(context: WorkContext): void {
  const page = DBOS.registerStep(
    () => maintainModerationDirectoryPage(context.pool),
    {
      name: "content.moderation-directory.install-page",
      retriesAllowed: true,
      intervalSeconds: 1,
      backoffRate: 2,
      maxAttempts: 11,
    },
  );
  DBOS.registerWorkflow(
    async () => {
      for (let pages = 0; pages < 16; pages++) {
        const result = await page();
        if (result.state !== "progress") return;
      }
    },
    { name: MODERATION_DIRECTORY_WORKFLOW },
  );
  context.addEffects([createModerationDirectoryProjectionEffect(context.pool)]);
  context.addService(async () => {
    await context.client.enqueue({
      applicationName: WORK_APPLICATION,
      workflowName: MODERATION_DIRECTORY_WORKFLOW,
      workflowID: `${MODERATION_DIRECTORY_WORKFLOW}:${context.clock().toISOString()}`,
      workflowIDReusePolicy: "return-existing",
      queueName: "maintenance",
    });
    await context.client.applySchedules([
      {
        scheduleName: "content.moderation-directory.each-minute",
        workflowName: MODERATION_DIRECTORY_WORKFLOW,
        schedule: "* * * * *",
        queueName: "maintenance",
        cronTimezone: "UTC",
        automaticBackfill: false,
      },
    ]);
    return { async stop() {} };
  });
}
