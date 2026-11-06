import { expect, mock, test } from 'bun:test';
import {
  WORKFLOW_RETENTION_DELETE_CONTROL_STATEMENTS,
  WORKFLOW_RETENTION_FAMILY_LIMITS,
  WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_BATCH_STATEMENTS,
  WORKFLOW_RETENTION_SELECT_TAG,
  WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS,
} from '../../src/work/contract/bounds.ts';
import {
  admitRetentionFamilyCopies,
  classifyRetentionStatement,
  freezeWorkflowRetentionStart,
  isRetentionCascadeDelete,
  retentionAdmittedByteScale,
  retentionBatchWork,
  retentionCompleteBatchWork,
  retentionControlEnvelope,
  retentionEngineEnvelope,
  retentionFamilyCountScale,
  retentionInterruptedBatchWork,
  retentionLoadClass,
  retentionMixedNeighbourhoodFanout,
  retentionNestedFkEnvelope,
  retentionNestedFkStatements,
  retentionObservedMatchesDerived,
  retentionObservedWork,
  retentionPayloadByteInventory,
  retentionPayloadFanoutInventory,
  retentionReplayBatchWork,
  retentionSelectionBinds,
  retentionSelectorPlanProof,
  retentionSingleCopyByteInventory,
  retentionSweepWork,
  WORKFLOW_RETENTION_BYTE_SCALES,
  WORKFLOW_RETENTION_COUNT_SCALES,
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
  expect(classifyRetentionStatement('DELETE FROM ONLY dbos.workflow_events WHERE workflow_uuid = $1')).toBe(
    'cascade-workflow_events',
  );
  expect(classifyRetentionStatement('DELETE FROM ONLY dbos.workflow_events_history WHERE workflow_uuid = $1')).toBe(
    'cascade-workflow_events_history',
  );
  expect(classifyRetentionStatement('DELETE FROM ONLY dbos.notifications WHERE destination_uuid = $1')).toBe(
    'cascade-notifications',
  );
  expect(classifyRetentionStatement('DELETE FROM ONLY dbos.streams WHERE workflow_uuid = $1')).toBe('cascade-streams');
  expect(isRetentionCascadeDelete('cascade-workflow_events')).toBe(true);
  expect(classifyRetentionStatement('SELECT 1')).toBe('other');
});

test('complete nested deletion charges selected IDs, payload copies, FK cascades, fences and replay', () => {
  expect(WORKFLOW_RETENTION_COUNT_SCALES).toEqual([1, 8, 64]);
  expect(WORKFLOW_RETENTION_BYTE_SCALES).toEqual([1_024, 8_192, 65_536]);
  expect(WORKFLOW_RETENTION_COUNT_SCALES.map(retentionAdmittedByteScale)).toEqual([...WORKFLOW_RETENTION_BYTE_SCALES]);
  expect(() => retentionAdmittedByteScale(4_096)).toThrow(RangeError);
  const mixed = retentionPayloadFanoutInventory(10, retentionMixedNeighbourhoodFanout());
  const bytes = retentionPayloadByteInventory(10, retentionMixedNeighbourhoodFanout(), 1024);
  const work = retentionCompleteBatchWork(10, mixed, bytes, 10);
  expect(work.selected).toBe(10);
  expect(work.nestedFkStatements).toBe(WORKFLOW_RETENTION_NESTED_FK_STATEMENTS);
  expect(work.statusDeleteStatements).toBe(WORKFLOW_RETENTION_STATUS_DELETE_STATEMENTS);
  expect(work.cascadeRows).toBeGreaterThan(work.selected);
  expect(work.deletionRows).toBeGreaterThan(work.cascadeRows);
  expect(work.payloadBytes).toBeGreaterThan(0);
  expect(work.fenceRows).toBe(10);
  expect(work.commitStatements).toBe(1);
  expect(work.rollbackStatements).toBe(0);
  expect(work.backgroundStatements).toBe(0);
  expect(work.exactIdDeletes).toBe(4);
  expect(admitRetentionFamilyCopies('workflow_events', 64)).toBe(WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events);
  const interrupted = retentionInterruptedBatchWork(10, mixed, bytes, false);
  expect(interrupted.commitStatements).toBe(0);
  expect(interrupted.rollbackStatements).toBe(1);
  expect(interrupted.controlStatements).toBe(2);
  const replayed = retentionReplayBatchWork(interrupted, work);
  expect(replayed.batches).toBe(2);
  expect(replayed.applicationStatements).toBe(work.applicationStatements * 2);
  expect(replayed.rollbackStatements).toBe(1);
  expect(replayed.commitStatements).toBe(1);
  expect(replayed.replayApplicationStatements).toBe(work.applicationStatements);
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

const nonemptyStatements = [
  '/* work:workflow-retention-select */ SELECT workflow_uuid FROM dbos.workflow_status ORDER BY completed_at, workflow_uuid LIMIT 1000',
  'BEGIN',
  'DELETE FROM dbos.workflow_input WHERE workflow_uuid = ANY($1::text[])',
  'DELETE FROM dbos.workflow_output WHERE workflow_uuid = ANY($1::text[])',
  'DELETE FROM dbos.operation_outputs WHERE workflow_uuid = ANY($1::text[])',
  'DELETE FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])',
  'COMMIT',
];

test('observed nonempty statements match the derived five-plus-two envelope', () => {
  const inventory = retentionPayloadFanoutInventory(10, { operations: 1, events: 1, history: 1 });
  const derived = retentionCompleteBatchWork(10, inventory);
  const observed = retentionObservedWork(nonemptyStatements, inventory);
  expect(observed.applicationStatements).toBe(5);
  expect(observed.controlStatements).toBe(2);
  expect(observed.outcome).toBe('commit');
  expect(observed.exactIdDeletes).toBe(4);
  expect(retentionObservedMatchesDerived(observed, derived)).toBe(true);
  expect(retentionControlEnvelope('commit')).toEqual({ begin: 1, commit: 1, rollback: 0, control: 2 });
});

test('a failed attempt prices BEGIN/ROLLBACK and replay repeats the remaining identities', () => {
  const inventory = retentionPayloadFanoutInventory(10, { operations: 8, events: 1, history: 1 });
  const failed = [nonemptyStatements[0]!, 'BEGIN', ...nonemptyStatements.slice(2, 6), 'ROLLBACK'];
  const observed = retentionObservedWork(failed, inventory);
  expect(observed.outcome).toBe('rollback');
  expect(observed.commitStatements).toBe(0);
  expect(observed.rollbackStatements).toBe(1);
  expect(observed.applicationStatements).toBe(5);
  const replayed = retentionObservedWork(nonemptyStatements, inventory);
  expect(replayed.outcome).toBe('commit');
  expect(retentionReplayBatchWork(observed, replayed).applicationStatements).toBe(10);
  expect(retentionControlEnvelope('rollback')).toEqual({ begin: 1, commit: 0, rollback: 1, control: 2 });
});

test('family count and single-copy byte axes admit owner limits independently of selected IDs', () => {
  expect(WORKFLOW_RETENTION_COUNT_SCALES.map((scale) => retentionFamilyCountScale('operation_outputs', scale))).toEqual(
    [1, 8, 64],
  );
  expect(WORKFLOW_RETENTION_COUNT_SCALES.map((scale) => retentionFamilyCountScale('workflow_events', scale))).toEqual([
    1, 8, 8,
  ]);
  expect(retentionFamilyCountScale('workflow_input', 64)).toBe(1);
  const unit = retentionPayloadFanoutInventory(10, { operations: 1 });
  const bytes = retentionSingleCopyByteInventory(10, 65_536);
  expect(bytes.workflow_input).toBe(10 * 65_536);
  expect(bytes.operation_outputs).toBe(0);
  expect(retentionCompleteBatchWork(10, unit, bytes).payloadBytes).toBeGreaterThan(0);
  expect(retentionCompleteBatchWork(10, unit, bytes).selected).toBe(10);
});

test('nested FK work stays four engine statements for every nonempty neighbourhood', () => {
  const empty = retentionNestedFkEnvelope(0);
  const nonempty = retentionNestedFkEnvelope(10);
  expect(empty).toEqual({ statements: 0, points: 0, parentStatements: 0 });
  expect(nonempty).toEqual({ statements: 4, points: 5, parentStatements: 1 });
  expect(retentionNestedFkStatements(10, retentionPayloadFanoutInventory(10, { operations: 64, events: 0 }))).toBe(4);
});

test('selector plan proof requires the retention index and rejects sequential scans', () => {
  const indexed = {
    'Query Text': '/* work:workflow-retention-select */ SELECT workflow_uuid',
    Plan: {
      'Node Type': 'Index Only Scan',
      'Index Name': 'workflow_retention_selector',
      'Relation Name': 'workflow_status',
    },
  };
  const proof = retentionSelectorPlanProof([indexed]);
  expect(proof.indexed).toBe(true);
  expect(proof.indexOnly).toBe(true);
  expect(proof.sequential).toBe(false);
  const sequential = retentionSelectorPlanProof([
    {
      'Query Text': 'SELECT workflow_uuid FROM dbos.workflow_status ORDER BY completed_at, workflow_uuid',
      Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'workflow_status' },
    },
  ]);
  expect(sequential.sequential).toBe(true);
  expect(sequential.indexed).toBe(false);
});

test('the engine envelope is intercept plus slope; packing is a residual not a new family', () => {
  const envelope = retentionEngineEnvelope(10, 64, 2, 3);
  expect(envelope.intercept).toBe(retentionEngineEnvelope(10, 1).indexProbes);
  expect(envelope.slope).toBe(2);
  expect(envelope.predictedBlocks).toBe(envelope.intercept + 128);
  expect(envelope.packingResidual).toBe(3);
  expect(
    retentionLoadClass({ packingResidual: 3, sequentialScanChanged: false, backgroundGrew: false, affineResidual: 1 }),
  ).toBe('packing');
  expect(
    retentionLoadClass({ packingResidual: 0, sequentialScanChanged: true, backgroundGrew: false, affineResidual: 0 }),
  ).toBe('plan-transition');
  expect(
    retentionLoadClass({ packingResidual: 0, sequentialScanChanged: false, backgroundGrew: true, affineResidual: 0 }),
  ).toBe('background');
  expect(
    retentionLoadClass({ packingResidual: 0, sequentialScanChanged: false, backgroundGrew: false, affineResidual: 0 }),
  ).toBe('affine');
});
