import { expect, mock, test } from 'bun:test';
import {
  runWorkflowRetentionBatch,
  runWorkflowRetentionSweep,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRetentionSelector,
  type WorkflowRetentionSdk,
} from '../../src/work/retention.ts';

for (const size of [0, 10, 1000]) {
  test(`a supplied retention selector deletes only its ${size} selected identities without descendants`, async () => {
    const ids = Array.from({ length: size }, (_, index) => `selected:${index}`);
    const select = mock(async (_input: Parameters<WorkflowRetentionSelector>[0]) => ids);
    const remove = mock(async (_ids: string[], _deleteChildren?: boolean) => {});
    const sdk: WorkflowRetentionSdk = {
      deleteWorkflows: remove,
    };
    const now = new Date('2026-11-03T00:00:00Z');
    expect(await runWorkflowRetentionBatch(30, sdk, now, select)).toBe(size);
    expect(select).toHaveBeenCalledWith({
      applicationName: 'rezics-kernel',
      statuses: TERMINAL_WORKFLOW_STATUSES,
      completedBefore: now.getTime() - 30 * 86400000,
      limit: 1000,
    });
    expect(remove.mock.calls).toEqual(size ? [[ids, false]] : []);
  });
}

test('supplied selection preserves the sweep cap and separate batch checkpoints', async () => {
  const select = mock(async (_input: Parameters<WorkflowRetentionSelector>[0]) =>
    Array.from({ length: 1000 }, (_, index) => `selected:${index}`),
  );
  const sdk: WorkflowRetentionSdk = { deleteWorkflows: mock(async () => {}) };
  const step = mock(async (batch: () => Promise<number>) => batch());
  expect(await runWorkflowRetentionSweep(30, sdk, new Date(0), step, select)).toBe(60_000);
  expect(step).toHaveBeenCalledTimes(60);
  expect(select).toHaveBeenCalledTimes(60);
  expect(sdk.deleteWorkflows).toHaveBeenCalledTimes(60);
  expect(new Set(select.mock.calls.map(([input]) => input.completedBefore)).size).toBe(1);
});
