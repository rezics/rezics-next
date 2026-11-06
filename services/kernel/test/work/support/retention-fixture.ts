import type { Pool } from 'pg';
import {
  WORKFLOW_RETENTION_FAMILY_LIMITS,
  WORKFLOW_RETENTION_PAYLOAD_BYTES,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_SINGLE_COPY_FAMILIES,
  WORKFLOW_RETENTION_VARIABLE_FAMILIES,
  emptyWorkflowRetentionInventory,
  retentionAdmittedFanout,
  retentionPayloadByteInventory,
  retentionPayloadFanoutInventory,
  type WorkflowRetentionByteInventory,
  type WorkflowRetentionFanout,
  type WorkflowRetentionPayloadFamily,
  type WorkflowRetentionPayloadInventory,
} from '../../../src/work/core/index.ts';

export type RetentionPayloadFanout = {
  readonly operations: number;
  readonly events: number;
  readonly history: number;
  readonly notifications: number;
  readonly streams: number;
  readonly input: number;
  readonly output: number;
};

export const UNIT_RETENTION_PAYLOAD: RetentionPayloadFanout = {
  operations: 1,
  events: 1,
  history: 1,
  notifications: 1,
  streams: 1,
  input: 1,
  output: 1,
};

export const MIXED_MAX_RETENTION_PAYLOAD: RetentionPayloadFanout = {
  operations: WORKFLOW_RETENTION_FAMILY_LIMITS.operation_outputs,
  events: WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events,
  history: WORKFLOW_RETENTION_FAMILY_LIMITS.workflow_events_history,
  notifications: WORKFLOW_RETENTION_FAMILY_LIMITS.notifications,
  streams: WORKFLOW_RETENTION_FAMILY_LIMITS.streams,
  input: 1,
  output: 1,
};

const jsonString = (bytes: number): string => `'${'"'}${'x'.repeat(Math.max(0, bytes - 2))}${'"'}'`;

const familyInsert = {
  workflow_status: { columns: '', values: '', key: 'workflow_uuid', payloadColumn: '' },
  workflow_input: { columns: 'inputs', values: "'[]'", key: 'workflow_uuid', payloadColumn: 'inputs' },
  workflow_output: {
    columns: 'output, error',
    values: "'null', NULL",
    key: 'workflow_uuid',
    payloadColumn: 'output',
  },
  operation_outputs: {
    columns: 'function_id, function_name, output',
    values: "ordinal, 'retention.fixture.step', 'null'",
    key: 'workflow_uuid',
    payloadColumn: 'output',
  },
  workflow_events: {
    columns: 'key, value',
    values: "'event-' || ordinal, 'null'",
    key: 'workflow_uuid',
    payloadColumn: 'value',
  },
  workflow_events_history: {
    columns: 'function_id, key, value',
    values: "ordinal, 'event-' || ordinal, 'null'",
    key: 'workflow_uuid',
    payloadColumn: 'value',
  },
  notifications: {
    columns: 'topic, message, serialization',
    values: "'retention-fixture-' || ordinal, 'null', 'portable_json'",
    key: 'destination_uuid',
    payloadColumn: 'message',
  },
  streams: {
    columns: 'key, value, "offset", function_id, serialization',
    values: "'retention-fixture-' || ordinal, 'null', ordinal - 1, 1, 'portable_json'",
    key: 'workflow_uuid',
    payloadColumn: 'value',
  },
} as const;

export function expectedRetentionInventory(
  selected: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
): WorkflowRetentionPayloadInventory {
  if (selected === 0) return emptyWorkflowRetentionInventory();
  return retentionPayloadFanoutInventory(selected, fanout);
}

export function expectedRetentionBytes(
  selected: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
  bytesPerCopy = 0,
): WorkflowRetentionByteInventory {
  if (selected === 0) return emptyWorkflowRetentionInventory();
  return retentionPayloadByteInventory(selected, fanout, bytesPerCopy);
}

export function familyFanout(
  family: (typeof WORKFLOW_RETENTION_VARIABLE_FAMILIES)[number],
  copies: number,
): RetentionPayloadFanout {
  const admitted = Math.min(copies, WORKFLOW_RETENTION_FAMILY_LIMITS[family]);
  switch (family) {
    case 'operation_outputs':
      return { ...UNIT_RETENTION_PAYLOAD, operations: admitted };
    case 'workflow_events':
      return { ...UNIT_RETENTION_PAYLOAD, events: admitted };
    case 'workflow_events_history':
      return { ...UNIT_RETENTION_PAYLOAD, history: admitted };
    case 'notifications':
      return { ...UNIT_RETENTION_PAYLOAD, notifications: admitted };
    case 'streams':
      return { ...UNIT_RETENTION_PAYLOAD, streams: admitted };
  }
}

function copiesFor(fanout: RetentionPayloadFanout): WorkflowRetentionPayloadInventory {
  const admitted = retentionAdmittedFanout(fanout);
  return {
    workflow_status: 0,
    workflow_input: Math.min(1, admitted.input ?? 1),
    workflow_output: Math.min(1, admitted.output ?? 1),
    operation_outputs: admitted.operations ?? 1,
    workflow_events: admitted.events ?? 1,
    workflow_events_history: admitted.history ?? 1,
    notifications: admitted.notifications ?? 1,
    streams: admitted.streams ?? 1,
  };
}

function payloadValues(table: WorkflowRetentionPayloadFamily, bytesPerCopy: number): string {
  const spec = familyInsert[table];
  if (bytesPerCopy <= 0 || spec.payloadColumn === '') return spec.values;
  const payload = jsonString(Math.min(bytesPerCopy, WORKFLOW_RETENTION_PAYLOAD_BYTES));
  switch (table) {
    case 'workflow_input':
      return payload;
    case 'workflow_output':
      return `${payload}, NULL`;
    case 'operation_outputs':
      return `ordinal, 'retention.fixture.step', ${payload}`;
    case 'workflow_events':
      return `'event-' || ordinal, ${payload}`;
    case 'workflow_events_history':
      return `ordinal, 'event-' || ordinal, ${payload}`;
    case 'notifications':
      return `'retention-fixture-' || ordinal, ${payload}, 'portable_json'`;
    case 'streams':
      return `'retention-fixture-' || ordinal, ${payload}, ordinal - 1, 1, 'portable_json'`;
    default:
      return spec.values;
  }
}

export const SINGLE_COPY_BYTE_FAMILIES = WORKFLOW_RETENTION_SINGLE_COPY_FAMILIES.filter(
  (family) => family !== 'workflow_status',
);

export async function insertRetentionPayload(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
  fanout: RetentionPayloadFanout | WorkflowRetentionFanout = UNIT_RETENTION_PAYLOAD,
  bytesPerCopy = 0,
  byteFamilies: readonly WorkflowRetentionPayloadFamily[] = WORKFLOW_RETENTION_PAYLOAD_FAMILIES.map(
    (family) => family.table,
  ),
): Promise<void> {
  if (ids.length === 0) return;
  const copies = copiesFor({ ...UNIT_RETENTION_PAYLOAD, ...fanout });
  const byteTargets = new Set(byteFamilies);
  for (const family of WORKFLOW_RETENTION_PAYLOAD_FAMILIES) {
    const copiesForTable = copies[family.table];
    const spec = familyInsert[family.table];
    if (copiesForTable === 0) continue;
    const repeating = family.table === 'workflow_input' || family.table === 'workflow_output';
    const values = payloadValues(family.table, byteTargets.has(family.table) ? bytesPerCopy : 0);
    await pool.query(
      repeating
        ? `INSERT INTO dbos.${family.table} (${spec.key}, ${spec.columns})
           SELECT value, ${values}
             FROM unnest($1::text[]) WITH ORDINALITY AS ids(value, parent)
           ORDER BY parent
           ON CONFLICT (${spec.key}) DO NOTHING`
        : `INSERT INTO dbos.${family.table} (${spec.key}, ${spec.columns})
           SELECT value, ${values}
             FROM unnest($1::text[]) WITH ORDINALITY AS ids(value, parent)
             CROSS JOIN generate_series(1, $2::integer) AS ordinal
           ORDER BY parent, ordinal`,
      repeating ? [ids] : [ids, copiesForTable],
    );
  }
}

export async function insertRetentionStatus(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
  fields: {
    readonly application: string;
    readonly status: string;
    readonly createdAt: number;
    readonly completedAt: number | null;
  },
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `INSERT INTO dbos.workflow_status
       (workflow_uuid, status, name, authenticated_roles, recovery_attempts,
        created_at, updated_at, completed_at, application_name)
     SELECT value, $2, 'retention.fixture', '[]', 0, $3, $4, $5, $6
       FROM unnest($1::text[]) WITH ORDINALITY AS ids(value, parent)
     ORDER BY parent`,
    [
      ids,
      fields.status,
      fields.createdAt,
      fields.completedAt ?? fields.createdAt,
      fields.completedAt,
      fields.application,
    ],
  );
}

export const RETENTION_OWNED_TABLES = WORKFLOW_RETENTION_PAYLOAD_FAMILIES;
export const RETENTION_VARIABLE_FAMILIES = WORKFLOW_RETENTION_VARIABLE_FAMILIES;

/** Payload tables have no status FK; status delete still cascades events, history, notifications and streams. */
export async function deleteOwnedRetentionRows(pool: Pick<Pool, 'query'>, idPattern: string): Promise<void> {
  for (const table of ['workflow_input', 'workflow_output', 'operation_outputs'] as const) {
    await pool.query(`DELETE FROM dbos.${table} WHERE workflow_uuid LIKE $1`, [idPattern]);
  }
  await pool.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [idPattern]);
}
