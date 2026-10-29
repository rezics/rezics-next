import type { Pool } from 'pg';
import { defineQuery } from 'reylo';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import checkpointStatement from './erasure-page.sql';

// Migration compatibility is verified at deployment; discovery never probes catalogs.
const checkpoint = defineQuery<
  (typeof checkpointStatement)['~reylo']['input'],
  (typeof checkpointStatement)['~reylo']['element'],
  typeof checkpointStatement.cardinality,
  'postgres'
>({
  dialect: checkpointStatement.dialect,
  sql: checkpointStatement.raw,
  params: checkpointStatement.params,
  cardinality: checkpointStatement.cardinality,
});

type Routing = 'owner' | 'zero' | 'partitions';
/** Scalar roles only. Typed JSON/delegation and HMAC associations have separate producer slices.
 * Keys are native primary keys, except the compact unique keys on permission/install stores.
 * No identifier or SQL predicate comes from a caller.
 */
export const ERASURE_DISCOVERY_ROLES: readonly (readonly [string, string, Routing, string, string])[] = [
  ['account', 'account_id', 'owner', 'route:int,account_id:uuid', ''],
  ['account', 'operator_account_id', 'partitions', 'route:int,account_id:uuid', ''],
  ['account', 'controller_id', 'partitions', 'route:int,account_id:uuid', ''],
  ['account_preferences', 'account_id', 'owner', 'route:int,account_id:uuid', ''],
  ['agent_page', 'account_id', 'partitions', 'route:int,subject_id:uuid', ''],
  ['agent_verification_request', 'account_id', 'zero', 'route:int,request_id:uuid', ''],
  ['agent_verification_request', 'requested_by', 'zero', 'route:int,request_id:uuid', ''],
  ['agent_verification_request', 'decided_by', 'zero', 'route:int,request_id:uuid', ''],
  ['committed_continuation', 'account_id', 'owner', 'route:int,continuation_id:uuid', ''],
  ['committed_continuation', 'prior_operator_account_id', 'partitions', 'route:int,continuation_id:uuid', ''],
  ['credential_floor_receipt', 'account_id', 'owner', 'route:int,account_id:uuid,opening_receipt_id:uuid', ''],
  ['erasure', 'account_id', 'owner', 'route:int,account_id:uuid', ''],
  ['erasure_acknowledgement', 'account_id', 'owner', 'route:int,account_id:uuid,participant:text', ''],
  ['governance_bootstrap', 'account_id', 'zero', 'route:int,resource_id:uuid', ''],
  [
    'governance_reach',
    'actor_account_id',
    'partitions',
    'route:int,transaction_id:uuid,action:text,resource_id:uuid',
    '',
  ],
  ['governance_reach', 'resource_id', 'owner', 'route:int,transaction_id:uuid,action:text,resource_id:uuid', ''],
  ['handle_claim', 'account_id', 'partitions', 'route:int,normalized_handle:text', ''],
  ['lifecycle_coordination', 'account_id', 'owner', 'route:int,account_id:uuid,reservation_id:uuid', ''],
  ['lifecycle_coordination', 'related_account_id', 'partitions', 'route:int,account_id:uuid,reservation_id:uuid', ''],
  ['lifecycle_fence_receipt', 'account_id', 'owner', 'route:int,account_id:uuid,receipt_id:uuid', ''],
  [
    'lifecycle_fence_receipt',
    'prior_operator_account_id',
    'partitions',
    'route:int,account_id:uuid,receipt_id:uuid',
    '',
  ],
  ['lifecycle_fence_receipt', 'operator_account_id', 'partitions', 'route:int,account_id:uuid,receipt_id:uuid', ''],
  [
    'lifecycle_handle_effect',
    'account_id',
    'partitions',
    'route:int,normalized_handle:text,account_id:uuid,reservation_id:uuid,operation_id:text,effect:text',
    '',
  ],
  ['lifecycle_handle_operation', 'account_id', 'owner', 'route:int,account_id:uuid,operation_id:text', ''],
  [
    'lifecycle_membership_slot',
    'organization_id',
    'owner',
    'route:int,organization_id:uuid,member_account_id:uuid,reservation_id:uuid',
    '',
  ],
  [
    'lifecycle_membership_slot',
    'member_account_id',
    'partitions',
    'route:int,organization_id:uuid,member_account_id:uuid,reservation_id:uuid',
    '',
  ],
  ['lifecycle_registration_expiry', 'account_id', 'owner', 'route:int,account_id:uuid,reservation_id:uuid', ''],
  ['membership_inverse', 'account_id', 'owner', 'route:int,account_id:uuid,kind:text,group_id:uuid', ''],
  ['membership_inverse', 'group_id', 'partitions', 'route:int,account_id:uuid,kind:text,group_id:uuid', ''],
  [
    'membership_inverse_terminal',
    'account_id',
    'owner',
    'route:int,account_id:uuid,kind:text,group_id:uuid,reservation_id:uuid',
    '',
  ],
  [
    'membership_inverse_terminal',
    'group_id',
    'partitions',
    'route:int,account_id:uuid,kind:text,group_id:uuid,reservation_id:uuid',
    '',
  ],
  [
    'operator_opening_receipt',
    'operator_account_id',
    'owner',
    'route:int,operator_account_id:uuid,receipt_id:uuid',
    '',
  ],
  [
    'operator_opening_receipt',
    'subject_account_id',
    'partitions',
    'route:int,operator_account_id:uuid,receipt_id:uuid',
    '',
  ],
  [
    'operator_opening_receipt',
    'acting_human_id',
    'partitions',
    'route:int,operator_account_id:uuid,receipt_id:uuid',
    '',
  ],
  [
    'operator_relation_slot',
    'subject_account_id',
    'owner',
    'route:int,subject_account_id:uuid,reservation_id:uuid',
    '',
  ],
  [
    'operator_relation_slot',
    'operator_account_id',
    'partitions',
    'route:int,subject_account_id:uuid,reservation_id:uuid',
    '',
  ],
  ['organization_close', 'organization_id', 'owner', 'route:int,organization_id:uuid', ''],
  [
    'organization_member',
    'organization_id',
    'owner',
    'route:int,organization_id:uuid,member_account_id:uuid,valid:tstzrange',
    '',
  ],
  [
    'organization_member',
    'member_account_id',
    'partitions',
    'route:int,organization_id:uuid,member_account_id:uuid,valid:tstzrange',
    '',
  ],
  ['principal_assignment', 'principal_id', 'owner', 'route:int,principal_id:uuid,request_id:uuid', ''],
  ['principal_assignment', 'creator_principal_id', 'owner', 'route:int,principal_id:uuid,request_id:uuid', ''],
  ['principal_assignment', 'assigned_actor_id', 'partitions', 'route:int,principal_id:uuid,request_id:uuid', ''],
  ['rating_counter_controller', 'account_id', 'owner', 'route:int,account_id:uuid,effective_at:timestamptz', ''],
  [
    'rating_counter_controller',
    'controller_id',
    'partitions',
    'route:int,account_id:uuid,effective_at:timestamptz',
    '',
  ],
  ['resource_denial', 'resource_id', 'owner', 'route:int,erasure_key:bigint', ''],
  ['resource_denial', 'subject_id', 'partitions', 'route:int,erasure_key:bigint', ''],
  ['resource_grant', 'resource_id', 'owner', 'route:int,erasure_key:bigint', ''],
  ['resource_grant', 'subject_id', 'partitions', 'route:int,erasure_key:bigint', "subject_kind = 'identity'"],
  ['resource_initialization', 'resource_id', 'owner', 'route:int,resource_id:uuid', ''],
  ['resource_initialization', 'creator_id', 'partitions', 'route:int,resource_id:uuid', ''],
  ['resource_role_grant', 'resource_id', 'owner', 'route:int,erasure_key:bigint', ''],
  ['resource_role_grant', 'subject_id', 'partitions', 'route:int,erasure_key:bigint', "subject_kind = 'identity'"],
  ['standing_parent_installation', 'resource_id', 'owner', 'route:int,erasure_key:bigint', ''],
  ['workflow_approval', 'actor_id', 'owner', 'route:int,approval_id:uuid', ''],
];

export type ErasureDiscoveryPage = {
  page: number;
  partition: number;
  keys: string[][];
  done: boolean;
};

/** Trusted platform discovery. A caller supplies a monotonically increasing page number;
 * retrying the most recently committed page returns its durable result, even after a lost response.
 * Advancing commits only the checkpoint: native rows and coordinator state are never modified.
 * Cost: one obligation probe, one checkpoint, one partition range seek (101 keys including lookahead),
 * at most 100 returned keys and 64 KiB; at most 8 statements, with O(log N) index height.
 */
export async function discoverErasurePage(
  pool: Pool,
  input: { accountId: string; store: string; role: string; page: number },
): Promise<ErasureDiscoveryPage> {
  const { accountId, store, role, page } = input;
  const route = routeOf(accountId);
  const spec = ERASURE_DISCOVERY_ROLES.find((entry) => entry[0] === store && entry[1] === role);
  if (route === null || !spec || !Number.isSafeInteger(page) || page < 0 || page > 2147483647)
    throw new LifecycleDeniedError();
  const [, , routing, rawKey, predicate] = spec;
  const columns = rawKey.split(',').map((entry) => {
    const [name, type] = entry.split(':');
    return { name: name!, type: type! };
  });
  const seekColumns = columns.filter(({ name }) => name !== role);
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      // Require an ordered seek even when tiny or stale statistics make scanning and sorting look cheaper.
      await tx.query(`SELECT set_config('enable_seqscan','off',true),
        set_config('enable_bitmapscan','off',true), set_config('enable_sort','off',true),
        set_config('enable_incremental_sort','off',true)`);
      // The obligation is immutable and permanent. Never restore or consult an initiating actor.
      const obligation = await tx.query('SELECT version FROM access.erasure WHERE route=$1 AND account_id=$2', [
        route,
        accountId,
      ]);
      if (!obligation.rowCount) throw new LifecycleDeniedError();
      const progress = await checkpoint.run(tx, {
        route,
        account_id: accountId,
        store,
        role,
        partition_no: routing === 'owner' ? partitionOf(route) : 0,
      });
      if (!progress) throw new LifecycleDeniedError();
      if (page === progress.last_page && progress.result) {
        await tx.query('COMMIT');
        return progress.result as ErasureDiscoveryPage;
      }
      if (page !== progress.last_page + 1 || progress.state === 'discovered') throw new LifecycleDeniedError();
      const partition = progress.partition_no;
      const low = routing === 'owner' ? route : partition * 16;
      const high = routing === 'owner' || routing === 'zero' ? low : low + 15;
      const values: unknown[] = [accountId, low, high];
      const cursor = progress.cursor;
      const after = cursor
        ? `AND (${seekColumns.map(({ name }) => name).join(',')}) > (${seekColumns
            .map(({ name, type }) => {
              values.push(cursor[columns.findIndex((column) => column.name === name)]);
              return `$${values.length}::${type}`;
            })
            .join(',')})`
        : '';
      const selected = await tx.query<{ key: string[] }>(
        `SELECT ARRAY[${columns.map(({ name }) => `${name}::text`).join(',')}] AS key
         FROM access.${store}
         WHERE ${role}=$1::uuid AND route >= $2::integer AND route <= $3::integer
         ${predicate ? `AND ${predicate}` : ''} ${after}
         ORDER BY ${seekColumns.map(({ name }) => name).join(',')} LIMIT 101`,
        values,
      );
      const keys = selected.rows.slice(0, 100).map(({ key }) => key);
      const more = selected.rows.length > 100;
      const done = !more && (routing !== 'partitions' || partition === 4095);
      const result: ErasureDiscoveryPage = { page, partition, keys, done };
      if (
        selected.rows.some(({ key }) => Buffer.byteLength(JSON.stringify(key)) > 1024) ||
        Buffer.byteLength(JSON.stringify(result)) > 65536
      )
        throw new RangeError('Erasure discovery page exceeds its byte bound');
      await tx.query(
        `UPDATE access.erasure_progress SET partition_no=$5,cursor=$6,state=$7,last_page=$8,result=$9
         WHERE route=$1 AND account_id=$2 AND store=$3 AND role=$4`,
        [
          route,
          accountId,
          store,
          role,
          more || done ? partition : partition + 1,
          more ? keys.at(-1) : null,
          done ? 'discovered' : 'discovering',
          page,
          JSON.stringify(result),
        ],
      );
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}
