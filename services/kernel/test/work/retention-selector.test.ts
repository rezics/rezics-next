import { expect, mock, test } from 'bun:test';
import {
  WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_SELECT_TAG,
} from '../../src/work/contract/bounds.ts';
import {
  classifyRetentionStatement,
  freezeWorkflowRetentionStart,
  retentionBatchWork,
  retentionPayloadFanoutInventory,
  retentionSelectionBinds,
  retentionSweepWork,
} from '../../src/work/core/index.ts';
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

test('selector binds freeze application, exclusive cutoff and batch limit', () => {
  const now = new Date('2026-11-06T13:00:00Z');
  expect(retentionSelectionBinds(now, 30, 'retention.foreign')).toEqual({
    applicationName: 'retention.foreign',
    statuses: TERMINAL_WORKFLOW_STATUSES,
    completedBefore: now.getTime() - 30 * 86400000,
    limit: 1000,
  });
});

test('a selected workflow count does not bound owned payload or cascade rows', () => {
  const unit = retentionPayloadFanoutInventory(10, {
    operations: 1,
    events: 1,
    history: 1,
    notifications: 1,
    streams: 1,
  });
  const fanout = retentionPayloadFanoutInventory(10, {
    operations: 8,
    events: 8,
    history: 8,
    notifications: 8,
    streams: 8,
  });
  const unitWork = retentionBatchWork(10, unit);
  const fanoutWork = retentionBatchWork(10, fanout);
  expect(unitWork.selected).toBe(10);
  expect(fanoutWork.selected).toBe(10);
  expect(unitWork.applicationStatements).toBe(WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS);
  expect(unitWork.controlStatements).toBe(WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS);
  expect(unitWork.statements).toBe(WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS);
  expect(unitWork.applicationStatements + unitWork.controlStatements).toBe(unitWork.statements);
  expect(fanoutWork.statements).toBe(unitWork.statements);
  expect(fanoutWork.applicationStatements).toBe(unitWork.applicationStatements);
  expect(fanoutWork.payloadRows).toBeGreaterThan(unitWork.payloadRows);
  expect(fanoutWork.deletionRows).toBeGreaterThan(unitWork.deletionRows);
  expect(fanoutWork.examinedRows).toBeGreaterThan(unitWork.examinedRows);
  expect(retentionBatchWork(0, unit).statements).toBe(1);
  expect(retentionBatchWork(0, unit).applicationStatements).toBe(1);
  expect(retentionBatchWork(0, unit).controlStatements).toBe(0);
  expect(retentionBatchWork(0, unit).deletionRows).toBe(0);
});

test('a two-batch sweep charges each nonempty delete plus the empty reselection', () => {
  const inventory = retentionPayloadFanoutInventory(1000, { operations: 2, events: 1, history: 1 });
  const remainder = retentionPayloadFanoutInventory(10, { operations: 2, events: 1, history: 1 });
  const empty = retentionPayloadFanoutInventory(0, {});
  const work = retentionSweepWork([1000, 10, 0], [inventory, remainder, empty]);
  expect(work.batches).toBe(3);
  expect(work.lastBatchSize).toBe(0);
  expect(work.selected).toBe(1010);
  expect(work.statements).toBe(7 + 7 + 1);
  expect(work.applicationStatements).toBe(5 + 5 + 1);
  expect(work.controlStatements).toBe(2 + 2 + 0);
  expect(work.applicationStatements + work.controlStatements).toBe(work.statements);
  expect(work.deletionRows).toBeGreaterThan(1010);
});

test('statement classification names the selector tag and the four exact-ID deletes', () => {
  expect(classifyRetentionStatement(`/* ${WORKFLOW_RETENTION_SELECT_TAG} */ SELECT workflow_uuid`)).toBe('select');
  expect(
    classifyRetentionStatement('SELECT workflow_uuid FROM dbos.workflow_status ORDER BY completed_at, workflow_uuid'),
  ).toBe('select');
  expect(classifyRetentionStatement('BEGIN ISOLATION LEVEL READ COMMITTED')).toBe('begin');
  expect(classifyRetentionStatement('COMMIT')).toBe('commit');
  expect(classifyRetentionStatement('ROLLBACK')).toBe('rollback');
  expect(classifyRetentionStatement('DELETE FROM "dbos".workflow_input WHERE workflow_uuid = ANY($1::text[])')).toBe(
    'delete-workflow_input',
  );
  expect(classifyRetentionStatement('DELETE FROM "dbos".workflow_output WHERE workflow_uuid = ANY($1::text[])')).toBe(
    'delete-workflow_output',
  );
  expect(classifyRetentionStatement('DELETE FROM "dbos".operation_outputs WHERE workflow_uuid = ANY($1::text[])')).toBe(
    'delete-operation_outputs',
  );
  expect(classifyRetentionStatement('DELETE FROM "dbos".workflow_status WHERE workflow_uuid = ANY($1::text[])')).toBe(
    'delete-workflow_status',
  );
  expect(classifyRetentionStatement('SELECT 1')).toBe('other');
});

test('the durable start snapshot freezes days, time and application together', () => {
  const start = freezeWorkflowRetentionStart(30, 1_700_000_000_000, 'retention-recovery:fixture');
  expect(start).toEqual({
    retentionDays: 30,
    now: 1_700_000_000_000,
    applicationName: 'retention-recovery:fixture',
  });
  expect(() => freezeWorkflowRetentionStart(6, 0, 'rezics-kernel')).toThrow('Invalid workflow retention period');
});
