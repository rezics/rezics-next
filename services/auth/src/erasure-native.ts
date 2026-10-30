import type { Pool, PoolClient } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthErasureBarrier, AuthErasureSource } from '@rezics/auth-contract';
import { requireErasureCursorVersion } from './erasure-cursor-cutover.ts';
import {
  nativeAdditionalRoles,
  nativeRoleStores,
  nativeRoleCoverageComplete,
  reconcileNativeRoleCoveragePage,
} from './erasure-coverage.ts';
import {
  closeCredentialConsumer,
  registrationTerminal,
  recoveryTerminal,
  nativeRequestTerminal,
  continueNativeConsumer,
  type NativeConsumerRuntime,
  type NativeConsumerLocator,
} from './erasure-consumers.ts';

// 48 locators of at most 1 KiB leave room for the progress anchor under 64 KiB.
export const ERASURE_PAGE_SIZE = 48;
export const ERASURE_VERSION = 1;
export type ErasurePage = { id: string; state: 'more' | 'consent' | 'pending'; code: string };
type Obligation = {
  id: string;
  account_id: string;
  barrier: number;
  applicable: boolean;
  kernel_at: string | null;
  source_discharged_at: Date | null;
  phase: number;
  after_key: string;
  client_id: string | null;
  client_phase: number;
  user_deleted_at: Date | null;
  consent_completed_at: Date | null;
  native_role_version: number;
};
type Store = { table: string; key: string; roles: string[]; client?: string; children?: string[] };
// Order is the native foreign-key/consumer order. No payload is selected by this manifest.
const baseErasureStores: readonly Store[] = [
  {
    table: 'oauthAccessToken',
    key: 'id',
    roles: ['userId', 'erasure_human_id', 'erasure_operator_id'],
    client: 'clientId',
  },
  {
    table: 'verification',
    key: 'id',
    roles: ['erasure_account_id', 'erasure_human_id', 'erasure_operator_id'],
    client: 'erasure_client_id',
  },
  {
    table: 'auth_recent_oidc_session',
    key: 'session_id',
    roles: ['account_id', 'erasure_human_id', 'erasure_operator_id'],
    client: 'erasure_client_id',
  },
  { table: 'oauthClientAssertion', key: 'id', roles: [], client: 'erasure_client_id' },
  {
    table: 'oauthRefreshToken',
    key: 'id',
    roles: ['userId', 'erasure_human_id', 'erasure_operator_id'],
    client: 'clientId',
    children: ['SELECT 1 FROM "oauthAccessToken" WHERE "refreshId"=$1 LIMIT 1'],
  },
  {
    table: 'oauthRefreshFamily',
    key: 'id',
    roles: ['erasure_account_id', 'erasure_human_id', 'erasure_operator_id'],
    client: 'clientId',
    children: [
      'SELECT 1 FROM "oauthAccessToken" WHERE "authorizationCodeId"=$1 LIMIT 1',
      'SELECT 1 FROM "oauthRefreshToken" WHERE "authorizationCodeId"=$1 LIMIT 1',
    ],
  },
  {
    table: 'session',
    key: 'id',
    roles: ['userId', 'erasure_human_id', 'erasure_operator_id'],
    client: 'clientId',
    children: [
      'SELECT 1 FROM "oauthAccessToken" WHERE "sessionId"=$1 LIMIT 1',
      'SELECT 1 FROM "oauthRefreshToken" WHERE "sessionId"=$1 LIMIT 1',
      'SELECT 1 FROM verification WHERE erasure_session_id=$1 LIMIT 1',
    ],
  },
  {
    table: 'auth_session_opening',
    key: 'session_id',
    roles: ['subject_account_id', 'acting_human_id', 'operator_account_id'],
    client: 'erasure_client_id',
    children: ['SELECT 1 FROM session WHERE id=$1 LIMIT 1'],
  },
  {
    table: 'auth_recovery_establishment',
    key: 'reference',
    roles: ['account_id', 'erasure_human_id', 'erasure_operator_id'],
    client: 'erasure_client_id',
  },
  {
    table: 'auth_barrier_proof',
    key: 'reference',
    roles: ['account_id', 'erasure_human_id', 'erasure_operator_id'],
    client: 'erasure_client_id',
    children: ['SELECT 1 FROM auth_recovery_establishment WHERE reference=$1 LIMIT 1'],
  },
  {
    table: 'auth_provisioning_receipt',
    key: 'idempotency_key',
    roles: ['account_id', 'erasure_creator_id', 'erasure_operator_id'],
  },
  {
    table: 'account',
    key: 'id',
    roles: ['userId'],
    children: ['SELECT 1 FROM auth_provisioning_receipt WHERE credential_id=$1 LIMIT 1'],
  },
  { table: 'passkey', key: 'id', roles: ['userId'] },
  { table: 'auth_recovery', key: 'proof_hash', roles: ['account_id'] },
  {
    table: 'auth_effect_receipt',
    key: 'receipt_id',
    roles: ['account_id', 'acting_human_id', 'erasure_operator_id'],
    client: 'client_id',
    children: ['SELECT 1 FROM auth_recovery_establishment WHERE receipt_id=$1 LIMIT 1'],
  },
  {
    table: 'auth_registration_stage',
    key: 'registration_id',
    roles: ['account_id', 'erasure_creator_id', 'erasure_operator_id'],
  },
  { table: 'auth_client_reduction_progress', key: 'operation_id', roles: [], client: 'client_id' },
  { table: 'auth_client_reduction', key: 'client_id', roles: [], client: 'client_id' },
  { table: 'auth_client_coverage', key: 'client_id', roles: [], client: 'client_id' },
  { table: 'oauthClientResource', key: 'id', roles: [], client: 'clientId' },
  { table: 'auth_workflow_request', key: 'workflow_id', roles: [], client: 'erasure_client_id' },
];
// Consume the producer inventory in the existing native engine, retaining its
// consumer/child order. Requests drain after user deletion so the deletion's
// own source consumer can finish without a caller/consumer dependency cycle.
export const nativeErasureStores: readonly Store[] = baseErasureStores
  .map((store) => ({
    ...store,
    roles:
      store.table === 'auth_workflow_request'
        ? store.roles
        : [
            ...store.roles,
            ...nativeAdditionalRoles.filter((role) => role.table === store.table).map((role) => role.role),
          ],
  }))
  .concat([{ table: 'auth_consent', key: 'id', roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'] }]);
const sourceClientStores = new Set([
  'oauthAccessToken',
  'verification',
  'oauthRefreshToken',
  'oauthRefreshFamily',
  'auth_recovery_establishment',
  'auth_barrier_proof',
]);
const subjectPhases = nativeErasureStores.flatMap((store) => store.roles.map((role) => ({ store, role })));
const clientPhases = nativeErasureStores
  .filter((store) => store.client)
  .flatMap((store) =>
    sourceClientStores.has(store.table)
      ? [store, { ...store, roles: [], client: 'erasure_source_client_id' }]
      : [store],
  );
const quote = (key: string) => `"${key}"`;
// A fixed adopted role inventory, not a walk over owners or protocol payloads.
// Capture positive applicability at acceptance, before any native page or
// independent expiry worker can remove its last applicable row.
const initialRoles = [
  ...nativeErasureStores.flatMap((store) => store.roles.map((role) => ({ table: store.table, role }))),
  { table: 'user', role: 'id' },
  { table: 'auth_client', role: 'userId' },
  { table: 'auth_public_key', role: 'account_id' },
  { table: 'auth_key_assertion', role: 'account_id' },
  { table: 'auth_attempt_account', role: 'account_id' },
  { table: 'auth_consent', role: 'account_id' },
  { table: 'auth_copy_role', role: 'account_id' },
  ...nativeAdditionalRoles
    .filter(({ table }) => table === 'auth_workflow_request')
    .map(({ table, role }) => ({ table, role })),
  ...[
    'erasure_subject_id',
    'erasure_human_id',
    'erasure_operator_id',
    'erasure_member_id',
    'erasure_previous_operator_id',
  ].map((role) => ({ table: 'auth_workflow_request', role })),
];
const initialApplicability = initialRoles
  .map(({ table, role }) => `EXISTS (SELECT 1 FROM ${quote(table)} WHERE ${quote(role)}=$1 LIMIT 1)`)
  .join(' OR ');

async function transaction<T>(pool: Pool, action: (connection: PoolClient) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await requireErasureCursorVersion(connection);
    const result = await action(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** Accepted only by the real deletion consumer, after its exact continuation has
 * been authorized. This commit alone NEVER supplies a consumption witness. */
async function acceptErasureSource(client: PoolClient, id: string, value: AuthErasureSource, workflowId: string) {
  if (DBOS.workflowID !== workflowId) throw new Error('Auth native source consumer missing');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${value.accountId}`]);
  const source = await client.query(
    `SELECT 1 FROM auth_workflow_request r JOIN auth_copy_work w USING(workflow_id)
      WHERE r.workflow_id=$1 AND r.erasure_subject_id=$2 AND r.request->>'kind'='delete'
      AND r.terminal_at IS NULL AND w.name='accounts.operation' AND NOT w.retired
      AND EXISTS(SELECT 1 FROM auth_copy_role s WHERE s.workflow_id=$1 AND s.account_id=$2 AND s.role='subject')`,
    [workflowId, value.accountId],
  );
  if (!source.rowCount) throw new Error('Auth native source consumer missing');
  const row = (
    await client.query<{
      account_id: string;
      kernel_at: string | null;
      kernel_version: number | null;
      source_continuation_id: string | null;
      source_receipt_id: string | null;
    }>('SELECT * FROM auth_erasure WHERE id=$1 FOR UPDATE', [id])
  ).rows[0];
  if (
    !row ||
    row.account_id !== value.accountId ||
    row.kernel_at !== value.at ||
    row.kernel_version !== value.version ||
    (row.source_continuation_id &&
      (row.source_continuation_id !== value.continuationId || row.source_receipt_id !== value.receiptId))
  )
    throw new Error('Auth erasure source mismatch');
  await client.query(
    `UPDATE auth_erasure SET source_continuation_id=$2,source_receipt_id=$3,
      source_workflow_id=$4,source_accepted_at=COALESCE(source_accepted_at,clock_timestamp()) WHERE id=$1`,
    [id, value.continuationId, value.receiptId, workflowId],
  );
}

/** Called only after the existing trusted deleted/fenced read. The native floor
 * and actual immutable kernel version/T are distinct; replay cannot replace either.
 * The account lock also fences every native producer transaction.
 */
export async function startNativeErasure(
  pool: Pool,
  accountId: string,
  barrier: number,
  identity?: AuthErasureBarrier,
  source?: { identity: AuthErasureSource; workflowId: string },
): Promise<string> {
  if (
    source &&
    (source.identity.accountId !== accountId ||
      identity?.accountId !== accountId ||
      source.identity.version !== identity.version ||
      source.identity.at !== identity.at)
  )
    throw new Error('Auth erasure source mismatch');
  return transaction(pool, async (connection) => {
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${accountId}`]);
    const row = (
      await connection.query<{ id: string }>(
        `INSERT INTO auth_erasure (account_id,barrier,version,applicable,kernel_version,kernel_at,native_role_version) VALUES ($1,$2,$3,${initialApplicability},$4,$5,
          CASE WHEN EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND armed AND store_index=${nativeRoleStores.length}) THEN 1 ELSE 0 END)
       ON CONFLICT (account_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING id`,
        [accountId, barrier, ERASURE_VERSION, identity?.version ?? null, identity?.at ?? null],
      )
    ).rows[0]!;
    if (source) await acceptErasureSource(connection, row.id, source.identity, source.workflowId);
    return row.id;
  });
}

async function drainStore(connection: PoolClient, store: Store, role: string, owner: string, after: string) {
  const rows = (
    await connection.query<{ key: string }>(
      `SELECT CASE WHEN octet_length(${quote(store.key)})<=1024 THEN ${quote(store.key)} END AS key FROM ${quote(store.table)}
     WHERE ${quote(role)}=$1 AND ${quote(store.key)}>$2 ORDER BY ${quote(store.key)} LIMIT $3 FOR UPDATE`,
      [
        owner,
        after,
        // Reserve the native consumer's source neighborhood as well as its
        // locator. Reduction's existing ordinal reader admits an eight-row
        // batch, even when the consumer requests only one delivered owner.
        store.table === 'auth_client_reduction_progress'
          ? ERASURE_PAGE_SIZE - 10
          : ['auth_provisioning_receipt', 'auth_registration_stage', 'auth_recovery_establishment'].includes(
                store.table,
              )
            ? ERASURE_PAGE_SIZE - 4
            : ERASURE_PAGE_SIZE,
      ],
    )
  ).rows;
  let keys = 0;
  if (rows.length)
    await connection.query(
      "UPDATE auth_erasure SET applicable=true WHERE id=current_setting('auth.erasure_obligation',true)::bigint",
    );
  for (const { key } of rows) {
    if (key === null || Buffer.byteLength(key) > 1024) return { after, keys, blocked: 'locator-size' };
    for (const query of store.children ?? []) {
      if ((await connection.query(query, [key])).rowCount) return { after, keys, blocked: 'native-child' };
    }
    if (store.table === 'auth_registration_stage') {
      const held = await connection.query(
        `SELECT 1 FROM auth_registration_stage WHERE registration_id=$1
        AND completed_at IS NULL AND expired_at IS NULL`,
        [key],
      );
      if (held.rowCount && !(await registrationTerminal(connection, key))) {
        // The release consumer needs the native reservation witness, not the
        // encrypted credential. A fenced producer cannot install it again.
        await connection.query(
          'UPDATE auth_registration_stage SET ciphertext=NULL,credential_digest=NULL WHERE registration_id=$1',
          [key],
        );
        return { after, keys, blocked: 'native-stage', held: { store: store.table, key } };
      }
    }
    if (store.table === 'auth_workflow_request') {
      const held = await connection.query(
        'SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1 AND terminal_at IS NULL',
        [key],
      );
      if (held.rowCount && !(await nativeRequestTerminal(connection, key)))
        return { after, keys, blocked: 'native-request' };
    }
    if (store.table === 'auth_client_reduction_progress') {
      const held = await connection.query(
        'SELECT 1 FROM auth_client_reduction_progress WHERE operation_id=$1 AND NOT completed',
        [key],
      );
      if (held.rowCount) return { after, keys, blocked: 'native-release', held: { store: store.table, key } };
    }
    if (store.table === 'auth_effect_receipt') {
      const staged = await connection.query(
        'SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1 AND stage_version IS NOT NULL',
        [key],
      );
      if (staged.rowCount && !(await closeCredentialConsumer(connection, key)))
        return { after, keys, blocked: 'native-release' };
    }
    if (store.table === 'auth_provisioning_receipt') {
      // A surviving subject's activation/release can still consume the immutable
      // provisioning witness. Its exact native stage supplies the terminal proof.
      const held = await connection.query(
        `SELECT 1 FROM auth_provisioning_receipt r WHERE idempotency_key=$1
         AND NOT EXISTS (SELECT 1 FROM auth_registration_stage s WHERE s.registration_id=r.erasure_stage_id
           AND (s.completed_at IS NOT NULL OR s.expired_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM auth_native_consumer_proof p WHERE p.store='registration' AND p.key=s.registration_id
               AND p.binding=jsonb_build_array(s.registration_id,s.consumer_workflow_id,s.activation_key,s.account_id,
                 s.handle,s.reservation_id,s.erasure_operator_id,s.operator_reservation_id))))`,
        [key],
      );
      if (held.rowCount) return { after, keys, blocked: 'native-release', held: { store: store.table, key } };
    }
    // A verifier's expiry is not the source consumer's completion. Keep the
    // exact establishment until its actual source release or terminal refusal.
    if (store.table === 'auth_recovery_establishment' && !(await recoveryTerminal(connection, key)))
      return { after, keys, blocked: 'native-release', held: { store: store.table, key } };
    await connection.query(`DELETE FROM ${quote(store.table)} WHERE ${quote(store.key)}=$1 AND ${quote(role)}=$2`, [
      key,
      owner,
    ]);
    after = key;
    keys++;
  }
  return { after, keys, blocked: null };
}

async function checkpoint(
  connection: PoolClient,
  row: Obligation,
  update: { phase?: number; clientPhase?: number; after?: string; client?: string | null; code?: string },
) {
  await connection.query(
    `UPDATE auth_erasure SET phase=$2,client_phase=$3,after_key=$4,client_id=$5,
     pending_code=$6,revision=revision+1 WHERE id=$1`,
    [
      row.id,
      update.phase ?? row.phase,
      update.clientPhase ?? row.client_phase,
      update.after ?? '',
      update.client === undefined ? row.client_id : update.client,
      update.code ?? 'native',
    ],
  );
}

/** Exactly one native store/role or one client/store page per transaction. The
 * only input/output crossing workflow history is an opaque progress id/code.
 */
export async function nativeErasurePage(pool: Pool, id: string, runtime?: NativeConsumerRuntime): Promise<ErasurePage> {
  let held: NativeConsumerLocator | undefined;
  const result = await transaction(pool, async (connection) => {
    const row = (await connection.query<Obligation>('SELECT * FROM auth_erasure WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new Error('Auth erasure obligation missing');
    // Consent is the caller's durable user-deletion checkpoint, not a one-time
    // edge. Maintenance may have committed it before this caller's next page.
    // The caller must then release its native consumers so post-user request
    // draining can finish. The pending reason remains durable on the obligation.
    const answer = (state: ErasurePage['state'], code: string): ErasurePage => ({
      id,
      state: row.user_deleted_at ? 'consent' : state,
      code,
    });
    if (row.kernel_at && !row.source_discharged_at) return answer('pending', 'native-source');
    await connection.query("SELECT set_config('auth.erasure_obligation',$1,true)", [id]);
    const deployment = (
      await connection.query<{ armed: boolean; store_index: number }>(
        'SELECT armed,store_index FROM auth_native_role_deployment WHERE singleton AND version=1',
      )
    ).rows[0];
    if (deployment?.armed && deployment.store_index < nativeRoleStores.length) {
      await checkpoint(connection, row, { code: 'native-role-deployment' });
      return answer('pending', 'native-role-deployment');
    }
    if (row.native_role_version === 0 && deployment?.armed) {
      // Discovery may have added a role behind an older phase cursor. Revisit
      // the existing engine once, preserving T, applicability, source handoff,
      // user deletion and the original consent cutoff. No second erasure root.
      await connection.query(
        `UPDATE auth_erasure SET native_role_version=1,
        phase=0,after_key='',client_id=NULL,client_phase=0,native_completed_at=NULL WHERE id=$1`,
        [id],
      );
      row.native_role_version = 1;
      row.phase = row.client_phase = 0;
      row.after_key = '';
      row.client_id = null;
    }
    if (row.phase === 0) {
      // Discover one owned client, retaining neither an owner list nor a connection
      // across client boundaries. Its existing lock excludes in-flight issuance.
      if (!row.client_id) {
        const client = (
          await connection.query<{ client_id: string | null }>(
            'SELECT CASE WHEN octet_length(client_id)<=1024 THEN client_id END AS client_id FROM auth_client WHERE "userId"=$1 ORDER BY auth_client.client_id LIMIT 1',
            [row.account_id],
          )
        ).rows[0];
        if (!client) {
          await checkpoint(connection, row, { phase: 1, clientPhase: 0 });
          return answer('more', 'subject');
        }
        if (client.client_id === null) {
          await checkpoint(connection, row, { code: 'locator-size' });
          return answer('pending', 'locator-size');
        }
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `auth-client:${client.client_id}`,
        ]);
        await connection.query(
          'INSERT INTO auth_erased_client (client_id,obligation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [client.client_id, id],
        );
        await connection.query('UPDATE auth_client SET disabled=true,erasure_fenced=true WHERE client_id=$1', [
          client.client_id,
        ]);
        await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
        await checkpoint(connection, row, { client: client.client_id, clientPhase: 0 });
        return answer('more', 'client');
      }
      await requireErasureCursorVersion(connection, undefined, row.client_id);
      const store = clientPhases[row.client_phase];
      if (store) {
        const page = await drainStore(connection, store, store.client!, row.client_id, row.after_key);
        held = page.held;
        await checkpoint(connection, row, {
          after: page.keys || page.blocked ? page.after : '',
          clientPhase: row.client_phase + (page.keys || page.blocked ? 0 : 1),
          code: page.blocked ?? 'native',
        });
        return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'client');
      }
      // Client consent is indexed by its independent ordinal after deployed v2.
      const consents = (
        await connection.query<{ traversal_ordinal: string }>(
          'SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 ORDER BY traversal_ordinal LIMIT $2 FOR UPDATE',
          [row.client_id, ERASURE_PAGE_SIZE],
        )
      ).rows;
      if (consents.length) {
        for (const consent of consents)
          await connection.query('DELETE FROM auth_consent WHERE client_id=$1 AND traversal_ordinal=$2', [
            row.client_id,
            consent.traversal_ordinal,
          ]);
        await checkpoint(connection, row, {});
        return answer('more', 'client-consent');
      }
      // Every native client child has been drained. The guard checks actual stores,
      // including rows predating typed protocol attribution, before the FK action.
      await connection.query('DELETE FROM auth_client WHERE client_id=$1', [row.client_id]);
      await checkpoint(connection, row, { client: null, clientPhase: 0 });
      return answer('more', 'client');
    }
    const phase = subjectPhases[row.phase - 1];
    if (phase) {
      const page = await drainStore(connection, phase.store, phase.role, row.account_id, row.after_key);
      held = page.held;
      if (page.keys) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      await checkpoint(connection, row, {
        phase: row.phase + (page.keys || page.blocked ? 0 : 1),
        after: page.keys || page.blocked ? page.after : '',
        code: page.blocked ?? 'native',
      });
      return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'subject');
    }
    const tail = row.phase - subjectPhases.length - 1;
    if (tail < 2) {
      // Composite native subject keys need no personal cursor: remove the first
      // remaining bounded prefix; these producers are permanently fenced.
      const table = tail === 0 ? 'auth_key_assertion' : 'auth_public_key';
      const key = tail === 0 ? 'jti' : 'kid';
      const page = await drainStore(connection, { table, key, roles: [] }, 'account_id', row.account_id, row.after_key);
      if (page.keys) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      await checkpoint(connection, row, {
        phase: row.phase + (page.keys || page.blocked ? 0 : 1),
        after: page.keys || page.blocked ? page.after : '',
      });
      return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'subject');
    }
    if (tail === 2) {
      const counters = (
        await connection.query<{ key: string }>(
          'SELECT key FROM auth_attempt_account WHERE account_id=$1 ORDER BY key LIMIT $2 FOR UPDATE',
          [row.account_id, ERASURE_PAGE_SIZE],
        )
      ).rows;
      for (const { key } of counters) {
        await connection.query('DELETE FROM auth_attempt_counter WHERE key=$1', [key]);
        await connection.query('DELETE FROM auth_attempt_account WHERE account_id=$1 AND key=$2', [
          row.account_id,
          key,
        ]);
      }
      if (counters.length) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      await checkpoint(connection, row, { phase: row.phase + (counters.length ? 0 : 1) });
      return answer('more', 'counter');
    }
    if (!row.user_deleted_at) {
      const user = await connection.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [row.account_id]);
      // Upgrade only the proved-empty legacy session range, keeping the native
      // session-erasure trigger and all immutable evidence guards enabled.
      if ((await connection.query('SELECT 1 FROM session WHERE "userId"=$1 LIMIT 1', [row.account_id])).rowCount)
        return answer('pending', 'native-child');
      // A marker beside a live user is stale, not the cutoff of this deletion.
      // Remove it before the native DELETE trigger establishes the real due time.
      // Replays with user_deleted_at set never enter this branch.
      if (user.rowCount)
        await connection.query('DELETE FROM auth_consent_erasure WHERE account_id=$1', [row.account_id]);
      await connection.query('UPDATE "user" SET sessions_bounded=true WHERE id=$1', [row.account_id]);
      await connection.query('DELETE FROM "user" WHERE id=$1', [row.account_id]);
      await connection.query(
        `INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ($1,clock_timestamp()+interval '310 seconds')
         ON CONFLICT (account_id) DO NOTHING`,
        [row.account_id],
      );
      await connection.query(
        `UPDATE auth_erasure SET applicable=applicable OR $2 OR EXISTS (SELECT 1 FROM auth_consent WHERE account_id=$3) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_subject_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_human_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_operator_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_member_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_previous_operator_id=$3 LIMIT 1),inventory_completed_at=clock_timestamp(),user_deleted_at=clock_timestamp(),
         consent_due_at=(SELECT due_at FROM auth_consent_erasure WHERE account_id=$3),pending_code='native-request',revision=revision+1
         WHERE id=$1`,
        [id, !!user.rowCount, row.account_id],
      );
      return answer('consent', 'consent');
    }
    const requestRoles = [
      'erasure_subject_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_member_id',
      'erasure_previous_operator_id',
      ...nativeAdditionalRoles.filter(({ table }) => table === 'auth_workflow_request').map(({ role }) => role),
    ];
    const requestRole = requestRoles[tail - 3];
    if (requestRole) {
      const requests = (
        await connection.query<{ workflow_id: string | null; terminal_at: Date | null }>(
          `SELECT CASE WHEN octet_length(workflow_id)<=1024 THEN workflow_id END AS workflow_id,terminal_at FROM auth_workflow_request WHERE ${quote(requestRole)}=$1
         ORDER BY auth_workflow_request.workflow_id LIMIT $2 FOR UPDATE`,
          [row.account_id, ERASURE_PAGE_SIZE],
        )
      ).rows;
      if (requests.length) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      for (const request of requests) {
        if (
          !request.terminal_at &&
          !(request.workflow_id && (await nativeRequestTerminal(connection, request.workflow_id)))
        ) {
          await checkpoint(connection, row, { code: 'native-request' });
          return answer('pending', 'native-request');
        }
        if (request.workflow_id === null) {
          await checkpoint(connection, row, { code: 'locator-size' });
          return answer('pending', 'locator-size');
        }
        await connection.query('DELETE FROM auth_workflow_request WHERE workflow_id=$1', [request.workflow_id]);
      }
      await checkpoint(connection, row, { phase: row.phase + (requests.length ? 0 : 1) });
      return answer('more', 'native-request');
    }
    const covered = await nativeRoleCoverageComplete(connection);
    // Native closure is independent of local-copy closure and its trusted proof.
    // The permanent obligation remains the shared-copy continuation anchor.
    await connection.query(
      'UPDATE auth_erasure SET native_completed_at=COALESCE(native_completed_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
    const code = !covered ? 'native-role-coverage' : row.consent_completed_at ? 'shared-copy-custody' : 'consent';
    await checkpoint(connection, row, { code });
    return answer(row.consent_completed_at ? 'pending' : 'consent', code);
  });
  // The source-local page transaction has committed and released its only slot.
  // An interrupted reply resumes this same raw key and original source command.
  if (held && runtime && (await continueNativeConsumer(pool, id, held, runtime)))
    return { id, state: result.state === 'consent' ? 'consent' : 'more', code: result.code };
  return result;
}

/** Native scheduling survives deletion of every DBOS row. A tick does one page;
 * a pending owner cannot starve later owners because the revision rotates it.
 */
export async function redriveNativeErasure(pool: Pool, runtime?: NativeConsumerRuntime): Promise<number> {
  // The same default recovery tick completes deployment classification even
  // before the first account deletion and after loss of its initiating caller.
  const coverage = await reconcileNativeRoleCoveragePage(pool);
  if (coverage) return coverage;
  const next = (
    await pool.query<{ id: string }>(
      `SELECT id FROM auth_erasure WHERE native_completed_at IS NULL OR native_role_version=0
     ORDER BY revision,id LIMIT 1`,
    )
  ).rows[0];
  if (!next) return 0;
  await nativeErasurePage(pool, next.id, runtime);
  return 1;
}
