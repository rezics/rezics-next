import { DBOS } from '@dbos-inc/dbos-sdk';
import { ConfigError } from '../commerce/config.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import {
  createNativeEconomyTestFunding,
  readEconomyTestFundingConfig,
  type EconomyTestFundingBinding,
} from './economy-test-funding.ts';

export const ECONOMY_TEST_FUNDING_WORK = {
  scheduleName: 'economy.testFunding.every-10-seconds',
  workflowName: 'economy.testFunding.dispatch',
} as const;

function binding(env: WorkContext['env']): EconomyTestFundingBinding | undefined {
  if (process.env.NODE_ENV !== 'development') return;
  const rail = readEconomyTestFundingConfig(env);
  if (!rail) return;
  const bookId = env.KERNEL_ECONOMY_BOOK_ID;
  if (bookId === undefined || !isEconomyBookId(bookId)) throw new ConfigError('KERNEL_ECONOMY_BOOK_ID');
  const node = env.KERNEL_ECONOMY_NODE;
  if (node === undefined || !node.trim() || node.length > 255) throw new ConfigError('KERNEL_ECONOMY_NODE');
  return { ...rail, bookId, node };
}

function matchesBinding(value: unknown, expected: EconomyTestFundingBinding): boolean {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<EconomyTestFundingBinding>;
  return (
    target.bookId === expected.bookId &&
    target.node === expected.node &&
    target.assetId === expected.assetId &&
    target.namespace === expected.namespace &&
    target.mode === expected.mode
  );
}

export const economyTestFundingWorkModule: WorkModule = {
  name: 'economy-test-funding',
  async register(context) {
    const target = binding(context.env);
    const client = context.client;
    const { scheduleName, workflowName } = ECONOMY_TEST_FUNDING_WORK;
    const prior = await client.getSchedule(scheduleName);
    if (prior && (prior.workflowName !== workflowName || prior.applicationName !== WORK_APPLICATION))
      throw new Error(`Unexpected owner of Economy schedule ${scheduleName}`);
    if (!target) {
      DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: workflowName });
      if (prior) await client.deleteSchedule(scheduleName);
      return;
    }
    const native = createNativeEconomyTestFunding(context.pool, target);
    const sweep = DBOS.registerStep(native.sweep, { name: 'economy.testFunding.sweep' });
    DBOS.registerWorkflow(
      async (_fire?: Date, scheduled?: unknown) => {
        if (!matchesBinding(scheduled, target)) return { kind: 'disabled' };
        return sweep();
      },
      { name: workflowName },
    );
    await client.applySchedules([
      {
        scheduleName,
        workflowName,
        schedule: '*/10 * * * * *',
        cronTimezone: 'UTC',
        automaticBackfill: false,
        queueName: 'maintenance',
        context: target,
      },
    ]);
  },
};
