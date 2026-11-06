import type { Pool } from 'pg';
import {
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  emptyWorkflowRetentionInventory,
  retentionPayloadFanoutInventory,
  type WorkflowRetentionPayloadInventory,
} from '../../../src/work/core/index.ts';

export type RetentionPayloadFanout = Readonly<{
  operations: number;
  events: number;
  history: number;
  notifications: number;
  streams: number;
  input: number;
  output: number;
}>;

export const UNIT_RETENTION_PAYLOAD: RetentionPayloadFanout = {
  operations: 1,
  events: 1,
  history: 1,
  notifications: 1,
  streams: 1,
  input: 1,
  output: 1,
};

const familyInsert = {
  workflow_status: { columns: '', values: '', key: 'workflow_uuid' },
  workflow_input: { columns: 'inputs', values: "'[]'", key: 'workflow_uuid' },
  workflow_output: { columns: 'output, error', values: "'null', NULL", key: 'workflow_uuid' },
  operation_outputs: {
    columns: 'function_id, function_name, output',
    values: "ordinal, 'retention.fixture.step', 'null'",
    key: 'workflow_uuid',
  },
  workflow_events: { columns: 'key, value', values: "'event-' || ordinal, 'null'", key: 'workflow_uuid' },
  workflow_events_history: {
    columns: 'function_id, key, value',
    values: "ordinal, 'event-' || ordinal, 'null'",
    key: 'workflow_uuid',
  },
  notifications: {
    columns: 'topic, message, serialization',
    values: "'retention-fixture-' || ordinal, 'null', 'portable_json'",
    key: 'destination_uuid',
  },
  streams: {
    columns: 'key, value, "offset", function_id, serialization',
    values: "'retention-fixture-' || ordinal, 'null', ordinal - 1, 1, 'portable_json'",
    key: 'workflow_uuid',
  },
} as const;

export function expectedRetentionInventory(
  selected: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
): WorkflowRetentionPayloadInventory {
  if (selected === 0) return emptyWorkflowRetentionInventory();
  return retentionPayloadFanoutInventory(selected, fanout);
}

export async function insertRetentionPayload(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
): Promise<void> {
  if (ids.length === 0) return;
  const copies = {
    workflow_status: 0,
    workflow_input: Math.min(1, fanout.input),
    workflow_output: Math.min(1, fanout.output),
    operation_outputs: fanout.operations,
    workflow_events: fanout.events,
    workflow_events_history: fanout.history,
    notifications: fanout.notifications,
    streams: fanout.streams,
  } as const satisfies WorkflowRetentionPayloadInventory;
  for (const family of WORKFLOW_RETENTION_PAYLOAD_FAMILIES) {
    const copiesForTable = copies[family.table];
    const spec = familyInsert[family.table];
    if (copiesForTable === 0) continue;
    const repeating = family.table === 'workflow_input' || family.table === 'workflow_output';
    await pool.query(
      repeating
        ? `INSERT INTO dbos.${family.table} (${spec.key}, ${spec.columns})
           SELECT value, ${spec.values}
             FROM unnest($1::text[]) AS value
           ON CONFLICT (${spec.key}) DO NOTHING`
        : `INSERT INTO dbos.${family.table} (${spec.key}, ${spec.columns})
           SELECT value, ${spec.values}
             FROM unnest($1::text[]) AS value
             CROSS JOIN generate_series(1, $2::integer) AS ordinal`,
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
       FROM unnest($1::text[]) AS value`,
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

/** Payload tables have no status FK; status delete still cascades events, history, notifications and streams. */
export async function deleteOwnedRetentionRows(pool: Pick<Pool, 'query'>, idPattern: string): Promise<void> {
  for (const table of ['workflow_input', 'workflow_output', 'operation_outputs'] as const) {
    await pool.query(`DELETE FROM dbos.${table} WHERE workflow_uuid LIKE $1`, [idPattern]);
  }
  await pool.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [idPattern]);
}
