import { recordAuthReceivingNativeCompletion } from './receiving-closure.ts';
import type { Pool, PoolClient } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthErasureBarrier, AuthErasureSource } from '@rezics/auth-contract';
import {
  NATIVE_PHASE_VERSION,
  nativePhases,
  NATIVE_V1_END,
  nativeClientPhases,
  NATIVE_CLIENT_CONSENT_PHASE,
  NATIVE_CLIENT_PHASE_END,
  NATIVE_PHASE_END,
  nativeV1RequestRoles,
  requireNativePhaseVersion,
  upgradeNativeCursor,
} from './erasure-role-upgrade.ts';
import { NATIVE_CREATION_PARTY_PRODUCERS } from './creation-party-context.ts';
import { nativeCreationCoverageComplete, nativeCreationRolesAbsent } from './erasure-coverage.ts';
import { requireErasureCursorVersion } from './erasure-cursor-cutover.ts';
import { recoveryCopyRoles, recoveryCopyPendingCode, type RecoveryCopyPending } from './recovery-copy-source.ts';
import { nativeRoleStores, nativeRoleCoverageComplete, reconcileNativeRoleCoveragePage } from './erasure-coverage.ts';
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
export type ErasurePage = {
  id: string;
  state: 'more' | 'consent' | 'pending';
  code: string;
  externalPending?: RecoveryCopyPending;
};
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
  native_phase_version: number;
  consent_due_at: Date | null;
  restore_generation?: string;
  user_replayed?: boolean;
  recovery_copy_pending: RecoveryCopyPending;
};
type Store = { table: string; key: string; roles: string[]; client?: string; children?: string[] };
// Order is the native foreign-key/consumer order. No payload is selected by this manifest.
export const nativeErasureStores: readonly Store[] = [
  {
    table: 'oauthAccessToken',
    key: 'id',
    roles: [
      'userId',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'clientId',
  },
  {
    table: 'verification',
    key: 'id',
    roles: [
      'erasure_account_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'erasure_client_id',
  },
  {
    table: 'auth_recent_oidc_session',
    key: 'session_id',
    roles: [
      'account_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'erasure_client_id',
  },
  {
    table: 'oauthClientAssertion',
    key: 'id',
    roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'],
    client: 'erasure_client_id',
  },
  {
    table: 'oauthRefreshToken',
    key: 'id',
    roles: [
      'userId',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'clientId',
    children: ['SELECT 1 FROM "oauthAccessToken" WHERE "refreshId"=$1 LIMIT 1'],
  },
  {
    table: 'oauthRefreshFamily',
    key: 'id',
    roles: [
      'erasure_account_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'clientId',
    children: [
      'SELECT 1 FROM "oauthAccessToken" WHERE "authorizationCodeId"=$1 LIMIT 1',
      'SELECT 1 FROM "oauthRefreshToken" WHERE "authorizationCodeId"=$1 LIMIT 1',
    ],
  },
  {
    table: 'session',
    key: 'id',
    roles: [
      'userId',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
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
    roles: [
      'subject_account_id',
      'acting_human_id',
      'operator_account_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'erasure_client_id',
    children: ['SELECT 1 FROM session WHERE id=$1 LIMIT 1'],
  },
  {
    table: 'auth_recovery_establishment',
    key: 'reference',
    roles: [
      'account_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'erasure_client_id',
  },
  {
    table: 'auth_barrier_proof',
    key: 'reference',
    roles: [
      'account_id',
      'erasure_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'erasure_client_id',
    children: ['SELECT 1 FROM auth_recovery_establishment WHERE reference=$1 LIMIT 1'],
  },
  {
    table: 'auth_provisioning_receipt',
    key: 'idempotency_key',
    roles: [
      'account_id',
      'erasure_creator_id',
      'erasure_operator_id',
      'erasure_delegate_id',
      'erasure_initiator_id',
      ...NATIVE_CREATION_PARTY_PRODUCERS[1].accountPhases.map((phase) => phase.role),
    ],
    client: 'erasure_client_id',
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
    roles: [
      'account_id',
      'acting_human_id',
      'erasure_operator_id',
      'erasure_client_owner_id',
      'erasure_source_client_owner_id',
    ],
    client: 'client_id',
    children: ['SELECT 1 FROM auth_recovery_establishment WHERE receipt_id=$1 LIMIT 1'],
  },
  {
    table: 'auth_registration_stage',
    key: 'registration_id',
    roles: [
      'account_id',
      'erasure_creator_id',
      'erasure_operator_id',
      'erasure_delegate_id',
      'erasure_initiator_id',
      ...NATIVE_CREATION_PARTY_PRODUCERS[0].accountPhases.map((phase) => phase.role),
    ],
    client: 'erasure_client_id',
  },
  {
    table: 'auth_client_reduction_progress',
    key: 'operation_id',
    roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'],
    client: 'client_id',
  },
  {
    table: 'auth_client_reduction',
    key: 'client_id',
    roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'],
    client: 'client_id',
  },
  {
    table: 'auth_client_coverage',
    key: 'client_id',
    roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'],
    client: 'client_id',
  },
  {
    table: 'oauthClientResource',
    key: 'id',
    roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'],
    client: 'clientId',
  },
  {
    table: 'auth_workflow_request',
    key: 'workflow_id',
    roles: ['erasure_actor_id', 'erasure_principal_id'],
    client: 'erasure_client_id',
  },
  { table: 'auth_consent', key: 'id', roles: ['erasure_client_owner_id', 'erasure_source_client_owner_id'] },
];

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
  ...recoveryCopyRoles.map((role) => ({ table: 'auth_recovery_copy_source', role })),
  ...nativeV1RequestRoles.map((role) => ({ table: 'auth_workflow_request', role })),
];
const initialApplicability = initialRoles
  .map(({ table, role }) => `EXISTS (SELECT 1 FROM ${quote(table)} WHERE ${quote(role)}=$1 LIMIT 1)`)
  .join(' OR ');

async function transaction<T>(pool: Pool, action: (connection: PoolClient) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['auth-kind-consent-frontier']);
    await requireErasureCursorVersion(connection);
    await requireNativePhaseVersion(connection);
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
        `INSERT INTO auth_erasure (account_id,barrier,version,applicable,kernel_version,kernel_at,native_phase_version,native_role_version) VALUES ($1,$2,$3,${initialApplicability},$4,$5,${NATIVE_PHASE_VERSION},
          CASE WHEN EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND armed AND store_index=${nativeRoleStores.length}) THEN 1 ELSE 0 END)
       ON CONFLICT (account_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING id`,
        [accountId, barrier, ERASURE_VERSION, identity?.version ?? null, identity?.at ?? null],
      )
    ).rows[0]!;
    await connection.query('UPDATE auth_erasure SET recovery_copy_pending=$2 WHERE id=$1', [
      row.id,
      await recoveryCopyPendingCode(connection, accountId),
    ]);
    if (source) await acceptErasureSource(connection, row.id, source.identity, source.workflowId);
    return row.id;
  });
}

async function drainStore(connection: PoolClient, store: Store, role: string, owner: string, after: string) {
  const rows = (
    await connection.query<{ key: string | null; client_key: string | null }>(
      `SELECT CASE WHEN octet_length(${quote(store.key)})${store.client ? `+COALESCE(octet_length(${quote(store.client)}),0)` : ''}<=1024 THEN ${quote(store.key)} END AS key,
       ${store.client ? `CASE WHEN octet_length(${quote(store.client)})<=1024 THEN ${quote(store.client)} END` : 'NULL::text'} AS client_key FROM ${quote(store.table)}
     WHERE ${quote(role)}=$1 AND ${quote(store.key)}>$2 ORDER BY ${quote(store.key)} LIMIT $3 ${store.client ? '' : 'FOR UPDATE'}`,
      [
        owner,
        after,
        // Reserve checkpoint/guard keys. Consumer joins and nested continuations
        // admit one locator, including final proof-reader checks; ordinary rows
        // also charge child and client seeks.
        [
          'auth_client_reduction_progress',
          'auth_provisioning_receipt',
          'auth_registration_stage',
          'auth_recovery_establishment',
          'auth_effect_receipt',
          'auth_workflow_request',
        ].includes(store.table)
          ? 1
          : Math.floor((ERASURE_PAGE_SIZE - 10) / (2 + (store.children?.length ?? 0) + (store.client ? 1 : 0))),
      ],
    )
  ).rows;
  let keys = 0;
  if (rows.length)
    await connection.query(
      "UPDATE auth_erasure SET applicable=true WHERE id=current_setting('auth.erasure_obligation',true)::bigint",
    );
  for (const { key, client_key } of rows) {
    if (key === null || Buffer.byteLength(key) > 1024) return { after, keys, blocked: 'locator-size' };
    if (client_key)
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-client:${client_key}`]);
    if (store.client) {
      // Issuance/consumer writes take the client lock before a row lock. Recheck
      // this exact locator under that order, including its original client.
      const locked = await connection.query(
        `SELECT 1 FROM ${quote(store.table)} WHERE ${quote(store.key)}=$1 AND ${quote(role)}=$2
         AND ${quote(store.client)} IS NOT DISTINCT FROM $3 FOR UPDATE`,
        [key, owner, client_key],
      );
      if (!locked.rowCount) return { after, keys, blocked: 'native-row-changed' };
    }
    for (const query of store.children ?? []) {
      if ((await connection.query(query, [key])).rowCount) return { after, keys, blocked: 'native-child' };
    }
    if (store.table === 'auth_registration_stage') {
      if (!(await registrationTerminal(connection, key))) {
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
      // A historical unknown row may be disposed of as a whole only after its
      // actual native reader retires. terminal_at alone is not that witness.
      if (!(await nativeRequestTerminal(connection, key))) return { after, keys, blocked: 'native-request' };
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
           AND EXISTS (SELECT 1 FROM auth_native_consumer_proof p WHERE p.store='registration' AND p.key=s.registration_id
             AND p.result->>'outcome' IN ('activated','expired')
             AND p.binding=jsonb_build_array(s.registration_id,s.consumer_workflow_id,s.activation_key,s.account_id,
               s.handle,s.reservation_id,s.erasure_operator_id,s.operator_reservation_id)))`,
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
    row.restore_generation
      ? `UPDATE auth_restore_replay SET phase=$2,client_phase=$3,after_key=$4,client_id=$5,
         pending_code=$6 WHERE obligation_id=$1 AND generation=$7`
      : `UPDATE auth_erasure SET phase=$2,client_phase=$3,after_key=$4,client_id=$5,
         pending_code=$6,revision=revision+1 WHERE id=$1`,
    [
      row.id,
      update.phase ?? row.phase,
      update.clientPhase ?? row.client_phase,
      update.after ?? '',
      update.client === undefined ? row.client_id : update.client,
      update.code ?? 'native',
      ...(row.restore_generation ? [row.restore_generation] : []),
    ],
  );
}

/** Exactly one native store/role or one client/store page per transaction. The
 * only input/output crossing workflow history is an opaque progress id/code.
 */
export async function nativeErasurePage(
  pool: Pool,
  id: string,
  runtime?: NativeConsumerRuntime,
  restoreGeneration?: string,
  beforePage?: (id: string, restoreGeneration?: string) => Promise<void>,
): Promise<ErasurePage> {
  // Auth's Kind producer closes and verifies its bounded frontier before this
  // native Auth transaction can touch consent/client authority.
  await beforePage?.(id, restoreGeneration);
  let held: NativeConsumerLocator | undefined;
  const result = await transaction(pool, async (connection) => {
    const identity = (
      await connection.query<{ account_id: string }>('SELECT account_id FROM auth_erasure WHERE id=$1', [id])
    ).rows[0];
    if (!identity) throw new Error('Auth erasure obligation missing');
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `auth-erasure:${identity.account_id}`,
    ]);
    const row = (await connection.query<Obligation>('SELECT * FROM auth_erasure WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new Error('Auth erasure obligation missing');
    const upgraded = upgradeNativeCursor(row);
    const oldPlaceholder = row.native_phase_version === 2 && row.phase >= 88;
    const oldEnd = row.native_phase_version === 1 && row.phase === NATIVE_V1_END;
    // The identity adapter retains saved v1 evidence. An old EOF boundary is
    // not a seek into the first new role; preserve it in the immutable snapshot.
    if (oldEnd) upgraded.after_key = '';
    if (
      oldPlaceholder &&
      row.phase >= 89 &&
      (await nativeCreationCoverageComplete(connection)) &&
      (await nativeCreationRolesAbsent(connection, row.account_id))
    ) {
      upgraded.phase =
        NATIVE_V1_END +
        NATIVE_CREATION_PARTY_PRODUCERS.reduce((count, producer) => count + producer.accountPhases.length, 0);
    }
    if (row.native_phase_version !== NATIVE_PHASE_VERSION) {
      // Retain the original cursor once, before translating an unavailable v2
      // slot. T, applicability and consent evidence are never part of this write.
      await connection.query(
        `UPDATE auth_erasure SET native_phase_upgrade=COALESCE(native_phase_upgrade,
          jsonb_build_object('native_phase_version',native_phase_version,'phase',phase,
            'client_phase',client_phase,'after_key',after_key,'client_id',client_id)),
          native_phase_version=$2,phase=$3,after_key=$4,native_completed_at=NULL,revision=revision+1 WHERE id=$1`,
        [id, upgraded.native_phase_version, upgraded.phase, upgraded.after_key],
      );
      Object.assign(row, upgraded);
      // Reserve this page for the bounded independent native coverage probes.
      // No consumer join or role drain shares their examined-key allowance.
      if (oldPlaceholder || oldEnd) return { id, state: 'more' as const, code: 'native-phase-upgrade' };
    }
    if (restoreGeneration) {
      const replay = (
        await connection.query<{
          phase: number;
          after_key: string;
          client_id: string | null;
          client_phase: number;
          user_replayed: boolean;
        }>('SELECT * FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2 FOR UPDATE', [
          restoreGeneration,
          id,
        ])
      ).rows[0];
      if (!replay) throw new Error('Auth restore original progress unavailable');
      // Revisit reintroduced bytes without resetting the original source,
      // approval, immutable proof, native cutoff or ordinary native cursor.
      row.phase = replay.phase;
      row.after_key = replay.after_key;
      row.client_id = replay.client_id;
      row.client_phase = replay.client_phase;
      row.user_replayed = replay.user_replayed;
      row.restore_generation = restoreGeneration;
      upgradeNativeCursor(row);
    }
    // Consent is the caller's durable user-deletion checkpoint, not a one-time
    // edge. Maintenance may have committed it before this caller's next page.
    // The caller must then release its native consumers so post-user request
    // draining can finish. The pending reason remains durable on the obligation.
    const answer = (state: ErasurePage['state'], code: string): ErasurePage => ({
      id,
      state: row.user_deleted_at && !restoreGeneration ? 'consent' : state,
      code,
      ...(state === 'pending' ? { externalPending: row.recovery_copy_pending } : {}),
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
        restoreGeneration
          ? 'UPDATE auth_erasure SET native_role_version=1 WHERE id=$1'
          : `UPDATE auth_erasure SET native_role_version=1,
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
      const clientPhase = nativeClientPhases[row.client_phase];
      const store = clientPhase && {
        ...nativeErasureStores.find((store) => store.table === clientPhase.table)!,
        client: clientPhase.role,
      };
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
      if (row.client_phase !== NATIVE_CLIENT_CONSENT_PHASE && row.client_phase < NATIVE_CLIENT_PHASE_END)
        throw new Error('Auth native client phase cursor unavailable');
      // Client consent is indexed by its independent ordinal after deployed v2.
      const consents =
        row.client_phase === NATIVE_CLIENT_CONSENT_PHASE
          ? (
              await connection.query<{ traversal_ordinal: string }>(
                'SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 ORDER BY traversal_ordinal LIMIT $2 FOR UPDATE',
                [row.client_id, Math.floor((ERASURE_PAGE_SIZE - 10) / 2)],
              )
            ).rows
          : [];
      if (consents.length) {
        for (const consent of consents)
          await connection.query('DELETE FROM auth_consent WHERE client_id=$1 AND traversal_ordinal=$2', [
            row.client_id,
            consent.traversal_ordinal,
          ]);
        await checkpoint(connection, row, {});
        return answer('more', 'client-consent');
      }
      if (row.client_phase === NATIVE_CLIENT_CONSENT_PHASE) {
        await checkpoint(connection, row, { clientPhase: row.client_phase + 1 });
        return answer('more', 'client');
      }
      if (!(await nativeCreationCoverageComplete(connection))) {
        await checkpoint(connection, row, { code: 'native-creation-roles-unavailable' });
        return answer('pending', 'native-creation-roles-unavailable');
      }
      // Every native client child has been drained. The guard checks actual stores,
      // including rows predating typed protocol attribution, before the FK action.
      await connection.query('DELETE FROM auth_client WHERE client_id=$1', [row.client_id]);
      await checkpoint(connection, row, { client: null, clientPhase: 0 });
      return answer('more', 'client');
    }
    const phase = nativePhases[row.phase];
    if (!phase) throw new Error('Auth native phase cursor unavailable');
    if (phase.kind === 'subject') {
      const store = nativeErasureStores.find((store) => store.table === phase.table)!;
      const page = await drainStore(connection, store, phase.role, row.account_id, row.after_key);
      held = page.held;
      if (page.keys) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      if (
        row.phase === NATIVE_V1_END &&
        !page.keys &&
        !page.blocked &&
        !(await nativeCreationCoverageComplete(connection))
      ) {
        if (await nativeCreationRolesAbsent(connection, row.account_id)) {
          await checkpoint(connection, row, { code: 'native-creation-roles-unavailable' });
          return answer('pending', 'native-creation-roles-unavailable');
        }
      }
      await checkpoint(connection, row, {
        phase: row.phase + (page.keys || page.blocked ? 0 : 1),
        after: page.keys || page.blocked ? page.after : '',
        code: page.blocked ?? 'native',
      });
      return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'subject');
    }
    if (phase.kind === 'assertion' || phase.kind === 'public-key') {
      // Composite native subject keys need no personal cursor: remove the first
      // remaining bounded prefix; these producers are permanently fenced.
      const table = phase.kind === 'assertion' ? 'auth_key_assertion' : 'auth_public_key';
      const key = phase.kind === 'assertion' ? 'jti' : 'kid';
      const page = await drainStore(connection, { table, key, roles: [] }, 'account_id', row.account_id, row.after_key);
      if (page.keys) await connection.query('UPDATE auth_erasure SET applicable=true WHERE id=$1', [id]);
      await checkpoint(connection, row, {
        phase: row.phase + (page.keys || page.blocked ? 0 : 1),
        after: page.keys || page.blocked ? page.after : '',
      });
      return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'subject');
    }
    if (phase.kind === 'counter') {
      const counters = (
        await connection.query<{ key: string | null }>(
          'SELECT CASE WHEN octet_length(key)<=1024 THEN key END AS key FROM auth_attempt_account WHERE account_id=$1 ORDER BY auth_attempt_account.key LIMIT $2 FOR UPDATE',
          [row.account_id, Math.floor((ERASURE_PAGE_SIZE - 10) / 3)],
        )
      ).rows;
      for (const { key } of counters) {
        if (key === null) {
          await checkpoint(connection, row, { code: 'locator-size' });
          return answer('pending', 'locator-size');
        }
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
    if (!row.user_deleted_at || (restoreGeneration && !row.user_replayed)) {
      const user = await connection.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [row.account_id]);
      // Upgrade only the proved-empty legacy session range, keeping the native
      // session-erasure trigger and all immutable evidence guards enabled.
      if ((await connection.query('SELECT 1 FROM session WHERE "userId"=$1 LIMIT 1', [row.account_id])).rowCount)
        return answer('pending', 'native-child');
      // A marker beside a live user is stale, not the cutoff of this deletion.
      // Remove it before the native DELETE trigger establishes the real due time.
      // Ordinary retries with user_deleted_at set never enter this branch;
      // a restored generation revisits the DELETE with its original cutoff.
      if (user.rowCount && !row.user_deleted_at)
        await connection.query('DELETE FROM auth_consent_erasure WHERE account_id=$1', [row.account_id]);
      await connection.query('UPDATE "user" SET sessions_bounded=true WHERE id=$1', [row.account_id]);
      await connection.query('DELETE FROM "user" WHERE id=$1', [row.account_id]);
      if (restoreGeneration && row.user_deleted_at) {
        // A restored user DELETE may fire the native trigger again. Restore the
        // genuine first cutoff in this same transaction; no new delay escapes.
        if (!row.consent_due_at) throw new Error('Auth restore original consent cutoff unavailable');
        await connection.query(
          `INSERT INTO auth_consent_erasure(account_id,due_at)
           SELECT account_id,consent_due_at FROM auth_erasure WHERE id=$1
           ON CONFLICT(account_id) DO UPDATE SET due_at=EXCLUDED.due_at,after_client=''`,
          [id],
        );
      } else {
        await connection.query(
          `INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ($1,clock_timestamp()+interval '310 seconds')
           ON CONFLICT (account_id) DO NOTHING`,
          [row.account_id],
        );
      }
      await connection.query(
        `UPDATE auth_erasure SET applicable=applicable OR $2 OR EXISTS (SELECT 1 FROM auth_consent WHERE account_id=$3) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_subject_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_human_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_operator_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_member_id=$3 LIMIT 1) OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_previous_operator_id=$3 LIMIT 1),inventory_completed_at=COALESCE(inventory_completed_at,clock_timestamp()),user_deleted_at=COALESCE(user_deleted_at,clock_timestamp()),
         consent_due_at=COALESCE(consent_due_at,(SELECT due_at FROM auth_consent_erasure WHERE account_id=$3)),pending_code='native-request',revision=revision+1
         WHERE id=$1`,
        [id, !!user.rowCount, row.account_id],
      );
      if (restoreGeneration)
        await connection.query(
          'UPDATE auth_restore_replay SET user_replayed=true WHERE generation=$1 AND obligation_id=$2',
          [restoreGeneration, id],
        );
      return answer('consent', 'consent');
    }
    if (phase.kind === 'request') {
      const store = nativeErasureStores.find((store) => store.table === phase.table)!;
      const page = await drainStore(connection, store, phase.role, row.account_id, row.after_key);
      await checkpoint(connection, row, {
        phase: row.phase + (page.keys || page.blocked ? 0 : 1),
        after: page.keys || page.blocked ? page.after : '',
        code: page.blocked ?? 'native-request',
      });
      return answer(page.blocked ? 'pending' : 'more', page.blocked ?? 'native-request');
    }
    if (phase.kind === 'unavailable') {
      await checkpoint(connection, row, { after: row.after_key, code: phase.code });
      return answer('pending', phase.code);
    }
    const covered = await nativeRoleCoverageComplete(connection);
    if (restoreGeneration) {
      // Same native consent store/client lock and original due evidence. This
      // generation has its own completion even if a snapshot carried an older
      // completed marker; no ordinary source completion is cleared or renewed.
      if (!row.consent_due_at) return answer('pending', 'original-consent-cutoff');
      const due = (
        await connection.query<{ due: boolean }>(
          'SELECT consent_due_at<=statement_timestamp() AS due FROM auth_erasure WHERE id=$1',
          [id],
        )
      ).rows[0]!.due;
      if (!due) return answer('pending', 'consent');
      const consent = (
        await connection.query<{ client_id: string | null }>(
          `SELECT CASE WHEN octet_length(client_id)<=1024 THEN client_id END AS client_id
         FROM auth_consent WHERE account_id=$1 ORDER BY client_id LIMIT 1`,
          [row.account_id],
        )
      ).rows[0];
      if (consent) {
        if (consent.client_id === null) return answer('pending', 'locator-size');
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `auth-client:${consent.client_id}`,
        ]);
        await connection.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
          row.account_id,
          consent.client_id,
        ]);
        return answer('more', 'consent');
      }
      if (!covered || row.native_role_version !== 1) return answer('pending', 'native-role-coverage');
      await connection.query(
        `UPDATE auth_restore_replay SET native_completed_at=COALESCE(native_completed_at,clock_timestamp()),
         consent_completed_at=COALESCE(consent_completed_at,clock_timestamp()),pending_code='shared-copy-custody'
         WHERE generation=$1 AND obligation_id=$2`,
        [restoreGeneration, id],
      );
      await recordAuthReceivingNativeCompletion(connection, id, restoreGeneration);
      return answer('pending', 'shared-copy-custody');
    }
    if (!covered || row.native_role_version !== 1) {
      await checkpoint(connection, row, { code: 'native-role-coverage' });
      return answer('pending', 'native-role-coverage');
    }
    // Native closure is independent of local-copy closure and its trusted proof.
    // The permanent obligation remains the shared-copy continuation anchor.
    await connection.query(
      'UPDATE auth_erasure SET native_completed_at=COALESCE(native_completed_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
    await recordAuthReceivingNativeCompletion(connection, id);
    const external = await recoveryCopyPendingCode(connection, row.account_id);
    await connection.query('UPDATE auth_erasure SET recovery_copy_pending=$2 WHERE id=$1', [id, external]);
    const code = !covered ? 'native-role-coverage' : row.consent_completed_at ? 'shared-copy-custody' : 'consent';
    await checkpoint(connection, row, { code });
    return answer(row.consent_completed_at ? 'pending' : 'consent', code);
  });
  // The source-local page transaction has committed and released its only slot.
  // An interrupted reply resumes this same raw key and original source command.
  if (held && runtime && (await continueNativeConsumer(pool, id, held, runtime)))
    return { ...result, state: result.state === 'consent' ? 'consent' : 'more' };
  return result;
}

/** Native scheduling survives deletion of every DBOS row. A tick does one page;
 * a pending owner cannot starve later owners because the revision rotates it.
 */
export async function redriveNativeErasure(
  pool: Pool,
  runtime?: NativeConsumerRuntime,
  beforePage?: (id: string, restoreGeneration?: string) => Promise<void>,
): Promise<number> {
  // The same default recovery tick completes deployment classification even
  // before the first account deletion and after loss of its initiating caller.
  const coverage = await reconcileNativeRoleCoveragePage(pool);
  if (coverage) return coverage;
  const next = (
    await pool.query<{ id: string }>(
      `SELECT id FROM auth_erasure WHERE native_completed_at IS NULL OR native_role_version=0 OR native_phase_version<${NATIVE_PHASE_VERSION} OR phase<${NATIVE_PHASE_END}
     ORDER BY revision,id LIMIT 1`,
    )
  ).rows[0];
  if (!next) return 0;
  await nativeErasurePage(pool, next.id, runtime, undefined, beforePage);
  return 1;
}
