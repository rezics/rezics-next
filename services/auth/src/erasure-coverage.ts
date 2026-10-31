import type { Pool, PoolClient } from 'pg';
import { NATIVE_CREATION_PARTY_PRODUCERS } from './creation-party-context.ts';
import { requireNativePhaseVersion } from './erasure-role-upgrade.ts';
import { copyTransaction } from './erasure-copy.ts';

export const NATIVE_ROLE_VERSION = 1;
// Reserve the native source and fence neighborhoods inside the same raw-key
// budget, including failed/unknown resolutions. This is a deployment page.
export const NATIVE_COVERAGE_PAGE = 4;
// Source order matters: exact native witnesses are reconciled before consumers.
// Composite keys are selected as transaction-local tuple locators, never saved
// as account-bearing traversal cursors.
export const nativeRoleStores = [
  ['user', ['id']],
  ['auth_client', ['client_id']],
  ['auth_session_opening', ['session_id']],
  ['session', ['id']],
  ['verification', ['id']],
  ['oauthRefreshFamily', ['id']],
  ['oauthRefreshToken', ['id']],
  ['oauthAccessToken', ['id']],
  ['oauthClientAssertion', ['id']],
  ['auth_recent_oidc_session', ['session_id']],
  ['auth_barrier_proof', ['reference']],
  ['auth_recovery_establishment', ['reference']],
  ['auth_registration_stage', ['registration_id']],
  ['auth_provisioning_receipt', ['idempotency_key']],
  ['account', ['id']],
  ['passkey', ['id']],
  ['auth_recovery', ['proof_hash']],
  ['auth_effect_receipt', ['receipt_id']],
  ['auth_workflow_request', ['workflow_id']],
  ['auth_public_key', ['account_id', 'kid']],
  ['auth_key_assertion', ['account_id', 'jti']],
  ['auth_attempt_account', ['account_id', 'key']],
  ['auth_consent', ['account_id', 'client_id']],
  ['auth_client_reduction_progress', ['operation_id']],
  ['auth_client_reduction', ['client_id']],
  ['auth_client_coverage', ['client_id']],
  ['oauthClientResource', ['id']],
  ['auth_recovery_copy_source', ['delivery_id']],
] as const;
export const nativeClientStores = [
  ['session', 'id', 'clientId'],
  ['verification', 'id', 'erasure_client_id'],
  ['oauthAccessToken', 'id', 'clientId'],
  ['oauthRefreshToken', 'id', 'clientId'],
  ['oauthRefreshFamily', 'id', 'clientId'],
  ['oauthClientAssertion', 'id', 'erasure_client_id'],
  ['auth_recent_oidc_session', 'session_id', 'erasure_client_id'],
  ['auth_session_opening', 'session_id', 'erasure_client_id'],
  ['auth_barrier_proof', 'reference', 'erasure_client_id'],
  ['auth_recovery_establishment', 'reference', 'erasure_client_id'],
  ['auth_effect_receipt', 'receipt_id', 'client_id'],
  ['auth_workflow_request', 'workflow_id', 'erasure_client_id'],
  ['auth_client_reduction_progress', 'operation_id', 'client_id'],
  ['auth_client_reduction', 'client_id', 'client_id'],
  ['auth_client_coverage', 'client_id', 'client_id'],
  ['oauthClientResource', 'id', 'clientId'],
  ['auth_consent', 'id', 'client_id'],
] as const;
export const nativeAdditionalRoles = [
  ...nativeClientStores.flatMap(([table, key]) => [
    { table, key, role: 'erasure_client_owner_id' },
    { table, key, role: 'erasure_source_client_owner_id' },
  ]),
  ...(['auth_registration_stage', 'auth_provisioning_receipt', 'auth_workflow_request'] as const).flatMap((table) => [
    {
      table,
      key:
        table === 'auth_registration_stage'
          ? 'registration_id'
          : table === 'auth_provisioning_receipt'
            ? 'idempotency_key'
            : 'workflow_id',
      role: 'erasure_delegate_id',
    },
    {
      table,
      key:
        table === 'auth_registration_stage'
          ? 'registration_id'
          : table === 'auth_provisioning_receipt'
            ? 'idempotency_key'
            : 'workflow_id',
      role: 'erasure_initiator_id',
    },
  ]),
] as const;
const quote = (value: string) => `"${value}"`;
const pools = new WeakSet<Pool>();

/** A producer version belongs to a leased connection, never to public input or
 * an idle shared socket. Reset completes BEFORE the real pool release. Existing
 * leases and other pools remain old writers and are refused after the cut.
 * Install only on the Auth-owned pool, before composing its native producers. */
export function installNativeRoleProducer(pool: Pool): void {
  if (pools.has(pool)) return;
  pools.add(pool);
  const connect = pool.connect.bind(pool);
  const lease = async (): Promise<PoolClient> => {
    const client = await connect();
    const release = client.release.bind(client);
    try {
      await client.query(
        "SELECT set_config('auth.native_role_producer','1',false),set_config('auth.native_phase_producer','3',false)",
      );
    } catch (error) {
      release(error as Error);
      throw error;
    }
    let released = false;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'release')
          return (error?: Error | boolean) => {
            if (released) return;
            released = true;
            if (error) return release(error);
            return client.query('RESET auth.native_role_producer; RESET auth.native_phase_producer').then(
              () => release(),
              (failure: Error) => release(failure),
            );
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  pool.connect = ((
    callback?: (error: Error | undefined, client?: PoolClient, release?: PoolClient['release']) => void,
  ) => {
    if (!callback) return lease();
    void lease().then(
      (client) => callback(undefined, client, client.release),
      (error: Error) => callback(error),
    );
  }) as Pool['connect'];
}

/** Locks drain old in-flight writes. The durable armed bit plus BEFORE triggers
 * fence old transactions that were queued behind the deployment lock. Coverage
 * never follows from a momentary empty-table probe or an ordinal cutover. */
export async function installNativeRoleCoverage(pool: Pool): Promise<void> {
  await copyTransaction(pool, async (client) => {
    await requireNativePhaseVersion(client);
    await client.query("SELECT set_config('auth.native_phase_producer','3',true)");
    // Recovery holds this row before touching a native store. Take it first on
    // restart too, so a concurrent deployment page cannot invert the lock order.
    const deployment = await client.query(
      'SELECT 1 FROM auth_native_role_deployment WHERE singleton AND version=1 FOR UPDATE',
    );
    if (!deployment.rowCount) throw new Error('Auth native role deployment unavailable');
    await client.query(
      `LOCK TABLE ${nativeRoleStores
        .map(([table]) => quote(table))
        .sort()
        .join(',')} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const state = await client.query(
      'UPDATE auth_native_role_deployment SET armed=true WHERE singleton AND version=1 RETURNING singleton',
    );
    if (!state.rowCount) throw new Error('Auth native role deployment unavailable');
    // This empty-install fast path is under the drained writer cut, backed by
    // permanent old-writer refusal and unknown-source custody, never a probe of
    // an unlocked table. Existing covered producers cannot create version zero.
    let pending = false;
    for (const [table] of nativeRoleStores) {
      if ((await client.query(`SELECT 1 FROM ${quote(table)} WHERE erasure_role_version=0 LIMIT 1`)).rowCount) {
        pending = true;
        break;
      }
    }
    if (!pending) {
      await client.query('UPDATE auth_native_role_deployment SET store_index=$1 WHERE singleton', [
        nativeRoleStores.length,
      ]);
      await client.query(`UPDATE auth_copy_coverage SET native_covered=true AND NOT EXISTS(
        SELECT 1 FROM auth_native_role_unknown LIMIT 1) WHERE singleton AND version=1`);
    }
  });
}

/** One store, <=48 raw tuple keys, no personal cursor. Classification and the
 * store checkpoint commit together. Unknown is sticky even if an expiry worker
 * subsequently removes a historical row; expiry is not recovered custody. */
export async function reconcileNativeRoleCoveragePage(pool: Pool): Promise<number> {
  return copyTransaction(pool, async (client) => {
    await requireNativePhaseVersion(client);
    await client.query("SELECT set_config('auth.native_phase_producer','3',true)");
    const state = (
      await client.query<{ store_index: number; armed: boolean }>(
        'SELECT store_index,armed FROM auth_native_role_deployment WHERE singleton AND version=1 FOR UPDATE',
      )
    ).rows[0];
    if (!state?.armed) return 0;
    const store = nativeRoleStores[state.store_index];
    if (!store) return 0;
    const [table, columns] = store;
    await client.query("SELECT set_config('auth.native_role_reconcile','1',true)");
    await client.query('SET LOCAL enable_seqscan=off');
    const rows = (
      await client.query<{ locator: string }>(
        `SELECT ctid::text AS locator FROM ${quote(table)} WHERE erasure_role_version=0
       ORDER BY ${columns.map(quote).join(',')} LIMIT ${NATIVE_COVERAGE_PAGE} FOR UPDATE`,
      )
    ).rows;
    for (const row of rows)
      // The native trigger resolves only declared typed columns and exact source
      // keys. It never decodes a historical payload or returns one to this page.
      await client.query(`UPDATE ${quote(table)} SET erasure_role_version=0 WHERE ctid=$1::tid`, [row.locator]);
    if (!rows.length) {
      await client.query('UPDATE auth_native_role_deployment SET store_index=store_index+1 WHERE singleton');
      if (state.store_index + 1 === nativeRoleStores.length)
        await client.query(`UPDATE auth_copy_coverage SET native_covered=true AND NOT EXISTS(
          SELECT 1 FROM auth_native_role_unknown LIMIT 1) WHERE singleton AND version=1`);
    }
    return rows.length || 1;
  });
}

/** Complete deployment coverage is necessary only for a coverage claim. Known
 * role cleanup keeps making progress even when a historical store is unknown. */
export async function nativeRoleCoverageComplete(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  return Boolean(
    (
      await client.query(`SELECT 1 FROM auth_copy_coverage
    WHERE singleton AND version=1 AND native_covered`)
    ).rowCount,
  );
}

export async function nativeRoleDeploymentComplete(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        'SELECT 1 FROM auth_native_role_deployment WHERE singleton AND version=1 AND armed AND store_index=$1',
        [nativeRoleStores.length],
      )
    ).rowCount,
  );
}

/** Original creation guards record unclassified history and the supported generic
 * no-stage receipt as sticky unknown custody. Only the drained native deployment
 * plus those source witnesses can cover this boundary. */
export async function nativeCreationCoverageComplete(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        `SELECT 1 FROM auth_native_role_deployment
    WHERE singleton AND armed AND store_index=$1 AND NOT EXISTS (
      SELECT 1 FROM auth_native_role_unknown WHERE store IN ('auth_registration_stage','auth_provisioning_receipt'))`,
        [nativeRoleStores.length],
      )
    ).rowCount,
  );
}

/** At most twelve leading-role seeks, under the account fence. Used only on
 * an otherwise empty boundary/upgrade page; never a population or payload scan. */
export async function nativeCreationRolesAbsent(
  client: Pick<PoolClient, 'query'>,
  accountId: string,
): Promise<boolean> {
  for (const producer of NATIVE_CREATION_PARTY_PRODUCERS) {
    for (const phase of producer.accountPhases) {
      if (
        (await client.query(`SELECT 1 FROM ${quote(phase.table)} WHERE ${quote(phase.role)}=$1 LIMIT 1`, [accountId]))
          .rowCount
      )
        return false;
    }
  }
  return true;
}
