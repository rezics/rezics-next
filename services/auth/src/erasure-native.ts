import type { Pool, PoolClient } from 'pg';
import { requireErasureCursorVersion } from './erasure-cursor-cutover.ts';

// 48 locators of at most 1 KiB leave room for the progress anchor under 64 KiB.
export const ERASURE_PAGE_SIZE = 48;
export const ERASURE_VERSION = 1;
export type ErasurePage = { id: string; state: 'more' | 'consent' | 'pending'; code: string };
type Obligation = {
  id: string;
  account_id: string;
  barrier: number;
  applicable: boolean;
  phase: number;
  after_key: string;
  client_id: string | null;
  client_phase: number;
  user_deleted_at: Date | null;
  consent_completed_at: Date | null;
};
type Store = { table: string; key: string; roles: string[]; client?: string; children?: string[] };
// Order is the native foreign-key/consumer order. No payload is selected by this manifest.
export const nativeErasureStores: readonly Store[] = [
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
  { table: 'auth_provisioning_receipt', key: 'idempotency_key', roles: ['account_id'] },
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

/** Called only after the existing trusted deleted/fenced read. The accepted floor
 * is the barrier identity available on that port; replay cannot replace it.
 * The account lock also fences every native producer transaction.
 */
export async function startNativeErasure(pool: Pool, accountId: string, barrier: number): Promise<string> {
  return transaction(pool, async (connection) => {
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${accountId}`]);
    const row = (
      await connection.query<{ id: string }>(
        `INSERT INTO auth_erasure (account_id,barrier,version,applicable) VALUES ($1,$2,$3,${initialApplicability})
       ON CONFLICT (account_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING id`,
        [accountId, barrier, ERASURE_VERSION],
      )
    ).rows[0]!;
    return row.id;
  });
}

async function drainStore(connection: PoolClient, store: Store, role: string, owner: string, after: string) {
  const rows = (
    await connection.query<{ key: string }>(
      `SELECT CASE WHEN octet_length(${quote(store.key)})<=1024 THEN ${quote(store.key)} END AS key FROM ${quote(store.table)}
     WHERE ${quote(role)}=$1 AND ${quote(store.key)}>$2 ORDER BY ${quote(store.key)} LIMIT $3 FOR UPDATE`,
      [owner, after, ERASURE_PAGE_SIZE],
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
        AND completed_at IS NULL AND expired_at IS NULL AND erasure_release_at IS NULL`,
        [key],
      );
      if (held.rowCount) return { after, keys, blocked: 'native-stage' };
    }
    if (store.table === 'auth_workflow_request') {
      const held = await connection.query(
        'SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1 AND terminal_at IS NULL',
        [key],
      );
      if (held.rowCount) return { after, keys, blocked: 'native-request' };
    }
    // A surviving subject's live recovery release still owns its witness. Expiry
    // makes this native verifier unusable; no shared-history completion is inferred.
    if (store.table === 'auth_recovery_establishment') {
      const held = await connection.query(
        `SELECT 1 FROM auth_barrier_proof p WHERE p.reference=$1 AND p.expires_at>statement_timestamp()
         AND NOT EXISTS (SELECT 1 FROM auth_erasure e WHERE e.account_id=p.account_id)`,
        [key],
      );
      if (held.rowCount) return { after, keys, blocked: 'native-release' };
    }
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
export async function nativeErasurePage(pool: Pool, id: string): Promise<ErasurePage> {
  return transaction(pool, async (connection) => {
    const row = (await connection.query<Obligation>('SELECT * FROM auth_erasure WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new Error('Auth erasure obligation missing');
    const answer = (state: ErasurePage['state'], code: string): ErasurePage => ({ id, state, code });
    await connection.query("SELECT set_config('auth.erasure_obligation',$1,true)", [id]);
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
        if (!request.terminal_at) {
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
    // No supported shared-history copy recorder/closure or trusted fixed-Auth
    // acknowledgement is composed. Keep the native obligation, never fabricate
    // handoff or translate absence of the user into NoData.
    await connection.query(
      'UPDATE auth_erasure SET native_completed_at=COALESCE(native_completed_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
    await checkpoint(connection, row, { code: row.consent_completed_at ? 'shared-copy-custody' : 'consent' });
    return answer(
      row.consent_completed_at ? 'pending' : 'consent',
      row.consent_completed_at ? 'shared-copy-custody' : 'consent',
    );
  });
}

/** Native scheduling survives deletion of every DBOS row. A tick does one page;
 * a pending owner cannot starve later owners because the revision rotates it.
 */
export async function redriveNativeErasure(pool: Pool): Promise<number> {
  const next = (
    await pool.query<{ id: string }>(
      `SELECT id FROM auth_erasure WHERE native_completed_at IS NULL
     ORDER BY revision,id LIMIT 1`,
    )
  ).rows[0];
  if (!next) return 0;
  await nativeErasurePage(pool, next.id);
  return 1;
}
