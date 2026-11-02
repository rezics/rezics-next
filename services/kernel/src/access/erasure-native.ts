import { minimizeLiveCopyInventory } from './live-copy-erasure.ts';
import { LiveCopyPendingError } from './live-copy.ts';
import {
  continuationRoleBlocker,
  continuationEffectBlockers,
  foreignTerminalBlockers,
  terminalStoreBlocker,
  CONTINUATION_ARTIFACTS,
  continuationArtifact,
} from './erasure-native-consumers.ts';
import { minimizeDiscoveredAgentIdentitySources } from './erasure-agent-identity.ts';
import {
  authConsumerDeletePredicate,
  isAuthConsumerStore,
  prepareAuthConsumerRetirement,
} from './erasure-auth-consumers.ts';
import type { AgentIdentityRetentionDependencies } from './agent-verification-identity-retention.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { reverseDeletedAccountAgent } from './agent-verification.ts';
import { consumeAccountDiscoveryClaim, deliverAccountDiscoveryIntent } from './account-discovery-work.ts';
import { continueErasureDeletion, ContinuationDeniedError } from './committed-continuations.ts';
import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import {
  ADDITIONAL_NATIVE_ERASURE_GROUPS,
  nativeErasurePageValid,
  nativeMinimization,
  nativeResiduePredicate,
  nativeStoreBlocker,
} from './erasure-native-stores.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import { discoverErasurePage, ERASURE_DISCOVERY_ROLES, type ErasureDiscoveryPage } from './erasure-progress.ts';

/** Delivered native groups only. The rest of the inventory is explicitly pending.
 * Ordering consumes handle effect children before their terminal operation parents.
 * Cursor-bearing groups require their deployed native cutover before mutation.
 */
export const NATIVE_ERASURE_GROUPS = [
  ['account_preferences', 'account_id'],
  ['resource_grant', 'resource_id'],
  ['resource_grant', 'subject_id'],
  ['resource_role_grant', 'resource_id'],
  ['resource_role_grant', 'subject_id'],
  ['resource_denial', 'resource_id'],
  ['resource_denial', 'subject_id'],
  ['standing_parent_installation', 'resource_id'],
  ['handle_claim', 'account_id'],
  ['lifecycle_handle_effect', 'account_id'],
  ['lifecycle_handle_operation', 'account_id'],
  ...ADDITIONAL_NATIVE_ERASURE_GROUPS,
] as const;

type Progress = {
  route: number;
  account_id: string;
  progress_id: string;
  phase: number;
  page: number;
  retry_phase: number;
};
type Work = Progress & { retry: boolean };
export type NativeErasureResult =
  | 'advanced'
  | 'pending-handle-consumer'
  | 'pending-native-consumer'
  | 'pending-native-inventory'
  | 'pending-shared-custody';
function allow(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
async function transaction<T>(pool: Pool, body: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      const result = await body(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

/** Permanent PostgreSQL identity, created before enqueue; nothing personal goes into a workflow argument. */
export async function openNativeErasure(pool: Pool, accountId: string): Promise<string> {
  const route = routeOf(accountId);
  allow(route !== null);
  return transaction(pool, async (tx) => {
    const obligation = await tx.query('SELECT 1 FROM access.erasure WHERE route=$1 AND account_id=$2', [
      route,
      accountId,
    ]);
    allow(obligation.rowCount === 1);
    const row = await tx.query<{ progress_id: string }>(
      `INSERT INTO access.erasure_native_progress(route,account_id,progress_id) VALUES($1,$2,$3)
       ON CONFLICT(route,account_id) DO UPDATE SET account_id=excluded.account_id RETURNING progress_id`,
      [route, accountId, newId(route)],
    );
    return row.rows[0]!.progress_id;
  });
}

/** One discovery page and one committed mutation/checkpoint transaction. Discovery's
 * result is intentionally kept until this transaction commits; a crash replays it.
 * Concurrent deliveries converge under the native progress lock. No account graph,
 * locator, page or native payload is returned to DBOS.
 */
export async function advanceNativeErasure(
  pool: Pool,
  progressId: string,
  identity?: AgentIdentityRetentionDependencies,
): Promise<NativeErasureResult> {
  const initial = await withConnection(pool, (tx) =>
    tx.query<Progress>(
      'SELECT route,account_id,progress_id,phase,page,retry_phase FROM access.erasure_native_progress WHERE progress_id=$1',
      [progressId],
    ),
  );
  const anchor = initial.rows[0];
  allow(anchor);
  let expected: Work = { ...anchor, retry: false };
  if (anchor.phase === NATIVE_ERASURE_GROUPS.length) {
    // Two ordered point-prefix seeks rotate only the fixed inventory's blocked
    // phases. No account graph, workflow enumeration or population scan.
    const blocked = await withConnection(pool, async (tx) => {
      const next = await tx.query<{ phase: number; page: number }>(
        `SELECT phase,page FROM access.erasure_native_blocked
         WHERE progress_id=$1 AND phase>$2 ORDER BY phase LIMIT 1`,
        [progressId, anchor.retry_phase],
      );
      return (
        next.rows[0] ??
        (
          await tx.query<{ phase: number; page: number }>(
            `SELECT phase,page FROM access.erasure_native_blocked WHERE progress_id=$1 ORDER BY phase LIMIT 1`,
            [progressId],
          )
        ).rows[0]
      );
    });
    if (!blocked) {
      await transaction(pool, async (tx) => {
        await tx.query(
          `UPDATE access.erasure_native_progress SET native_complete_at=COALESCE(native_complete_at,statement_timestamp()),
          pending='shared-history-producer' WHERE progress_id=$1 AND phase=$2
          AND NOT EXISTS (SELECT 1 FROM access.erasure_native_blocked WHERE progress_id=$1)`,
          [progressId, NATIVE_ERASURE_GROUPS.length],
        );
      });
      return 'pending-shared-custody';
    }
    expected = { ...anchor, ...blocked, retry: true };
  }
  const group = NATIVE_ERASURE_GROUPS[expected.phase];
  allow(group);
  const [store, role] = group;
  const spec = ERASURE_DISCOVERY_ROLES.find((entry) => entry[0] === store && entry[1] === role);
  allow(spec);
  let page: ErasureDiscoveryPage;
  try {
    page = await discoverErasurePage(pool, {
      accountId: expected.account_id,
      store,
      role,
      page: expected.page,
    });
  } catch (error) {
    if (error instanceof LiveCopyPendingError) {
      return transaction(pool, async (tx) => {
        const locked = (
          await tx.query<Progress>(
            'SELECT route,account_id,progress_id,phase,page,retry_phase FROM access.erasure_native_progress WHERE progress_id=$1 FOR UPDATE',
            [progressId],
          )
        ).rows[0];
        allow(locked);
        if (locked.phase !== anchor.phase || locked.page !== anchor.page) return 'advanced';
        await tx.query(
          `INSERT INTO access.erasure_native_blocked(progress_id,phase,page,reason,consumer_index)
          VALUES($1,$2,$3,'live-copy-original-role-coverage',0)
          ON CONFLICT(progress_id,phase) DO UPDATE SET page=excluded.page,reason=excluded.reason`,
          [progressId, expected.phase, expected.page],
        );
        await tx.query(
          `UPDATE access.erasure_native_progress SET phase=$2,page=0,retry_phase=$3,
          pending='native-inventory',native_complete_at=NULL WHERE progress_id=$1`,
          [
            progressId,
            expected.retry ? locked.phase : expected.phase + 1,
            expected.retry ? expected.phase : locked.retry_phase,
          ],
        );
        return expected.retry ? 'pending-native-consumer' : 'advanced';
      });
    }
    // A concurrent consumer can commit (and remove the copied page) between our
    // initial read and discovery. Only its changed checkpoint makes this stale.
    if (!(error instanceof LifecycleDeniedError)) throw error;
    const latest = await withConnection(pool, (tx) =>
      tx.query<Progress>('SELECT phase,page FROM access.erasure_native_progress WHERE progress_id=$1', [progressId]),
    );
    const row = latest.rows[0];
    if (row && (row.phase !== anchor.phase || row.page !== anchor.page)) return 'advanced';
    if (expected.retry) {
      const blocked = await withConnection(pool, (tx) =>
        tx.query<{ page: number }>('SELECT page FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2', [
          progressId,
          expected.phase,
        ]),
      );
      if (!blocked.rows[0] || blocked.rows[0].page !== expected.page) return 'advanced';
    }
    throw error;
  }
  const columns = spec[3].split(',').map((column) => {
    const [name, type] = column.split(':');
    allow(name && type);
    return { name, type };
  });
  allow(nativeErasurePageValid(page, columns.length, expected.page));
  const authRetirement = page.keys.length
    ? await prepareAuthConsumerRetirement(pool, store, expected.account_id, expected.route, page.partition)
    : null;
  const foreignBlocked = await foreignTerminalBlockers(pool, store, page, expected.account_id);

  let consumerPending: string | null = null;
  let consumerIndex = 0;
  if ((store === 'account_discovery_intent' || store === 'account_discovery_claim_intent') && page.keys.length) {
    const cursor = await withConnection(pool, (tx) =>
      tx.query<{ consumer_index: number }>(
        'SELECT consumer_index FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2',
        [progressId, expected.phase],
      ),
    );
    const index = (cursor.rows[0]?.consumer_index ?? 0) % page.keys.length;
    const key = page.keys[index]!;
    const intent = await withConnection(
      pool,
      async (tx) =>
        (
          await tx.query<{ revision: string }>(
            `SELECT revision::text FROM access.${store} WHERE route=$1 AND account_id=$2`,
            [...key],
          )
        ).rows[0],
    );
    if (intent) {
      const input = {
        route: Number(key[0]),
        accountId: key[1]!,
        revision: intent.revision,
      };
      const deps = { pool };
      if (store === 'account_discovery_intent' || (await consumeAccountDiscoveryClaim(deps, input)))
        await deliverAccountDiscoveryIntent(deps, input, store === 'account_discovery_intent' ? 'account' : 'claim');
    }
    consumerIndex = (index + 1) % page.keys.length;
  }
  if (store === 'committed_continuation' && page.keys.length) {
    const cursor = await withConnection(pool, (tx) =>
      tx.query<{ consumer_index: number }>(
        'SELECT consumer_index FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2',
        [progressId, expected.phase],
      ),
    );
    const index = (cursor.rows[0]?.consumer_index ?? 0) % page.keys.length;
    // Finish one root's at-most-three LOCAL deletion commands per invocation.
    // Their original native receipt keys survive a crash before this checkpoint.
    // No connection remains checked out while another command/partition runs.
    try {
      const exists = await withConnection(pool, (tx) =>
        tx.query(
          'SELECT 1 FROM access.committed_continuation WHERE route=$1 AND continuation_id=$2',
          page.keys[index]!,
        ),
      );
      if (exists.rowCount) await continueErasureDeletion(pool, page.keys[index]![1]!);
    } catch (error) {
      if (error instanceof ContinuationDeniedError) consumerPending = 'continuation-barrier-consumer';
      else if (error instanceof LifecycleDeniedError) consumerPending = 'deletion-local-consumer';
      else throw error;
    }
    consumerIndex = (index + 1) % page.keys.length;
  }
  if (store === 'agent_identity_intent' && page.keys.length && identity) {
    const root = (
      await withConnection(pool, (tx) =>
        tx.query<{ version: number; at: string }>(
          'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
          [expected.route, expected.account_id],
        ),
      )
    ).rows[0];
    const cursor =
      (
        await withConnection(pool, (tx) =>
          tx.query<{ consumer_index: number }>(
            'SELECT consumer_index FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2',
            [progressId, expected.phase],
          ),
        )
      ).rows[0]?.consumer_index ?? 0;
    const start = cursor % page.keys.length;
    const keys = page.keys.slice(start, start + 8);
    if (root && (role === 'account_id' || role === 'requested_by' || role === 'decided_by')) {
      await minimizeDiscoveredAgentIdentitySources(
        pool,
        {
          barrier: {
            accountId: expected.account_id,
            accountRoute: expected.route,
            ...root,
          },
          role,
          keys,
        },
        identity,
      );
    }
    consumerIndex = (start + keys.length) % page.keys.length;
  }
  if (store === 'agent_page' && page.keys.length) {
    // Start the actual receipt-bound reversal. Its registered consumer must
    // finish Semantic unmerge and page removal before the account witness clears.
    // Native erasure never clears that witness or fabricates a reversal result.
    try {
      await reverseDeletedAccountAgent(pool, expected.account_id);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Account agent work is still pending') throw error;
      consumerPending = 'verification-reversal-consumer';
    }
  }
  const effectBlocked = await continuationEffectBlockers(pool, store, page);
  const copyBlocked = new Set<string>();
  if (store === 'live_copy_inventory' || store === 'live_copy_business_inventory') {
    for (const key of page.keys) {
      if (!(await minimizeLiveCopyInventory(pool, store, key, expected.account_id, progressId)))
        copyBlocked.add(JSON.stringify(key));
    }
  }
  return transaction(pool, async (tx) => {
    const locked = await tx.query<Progress>(
      `SELECT route,account_id,progress_id,phase,page,retry_phase FROM access.erasure_native_progress
       WHERE progress_id=$1 FOR UPDATE`,
      [progressId],
    );
    const current = locked.rows[0];
    allow(current);
    const committedPhase = current.phase;
    const committedRetryPhase = current.retry_phase;
    if (current.phase !== anchor.phase || current.page !== anchor.page) return 'advanced';
    if (expected.retry) {
      const blocked = await tx.query<{ page: number }>(
        `SELECT page FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2 FOR UPDATE`,
        [progressId, expected.phase],
      );
      if (!blocked.rows[0] || blocked.rows[0].page !== expected.page) return 'advanced';
    }
    async function pending(reason: string): Promise<NativeErasureResult> {
      // The forward phase is scheduling, not destructive completion. The whole
      // unpurged page and its exact reason remain authoritative in this queue.
      await tx.query(
        `INSERT INTO access.erasure_native_blocked(progress_id,phase,page,reason,consumer_index) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(progress_id,phase) DO UPDATE SET page=excluded.page,reason=excluded.reason,
           consumer_index=excluded.consumer_index`,
        [progressId, expected.phase, expected.page, reason, consumerIndex],
      );
      await tx.query(
        `UPDATE access.erasure_native_progress SET phase=$2,page=0,pending='native-inventory',retry_phase=$3
         WHERE progress_id=$1`,
        [
          progressId,
          expected.retry ? committedPhase : expected.phase + 1,
          expected.retry ? expected.phase : committedRetryPhase,
        ],
      );
      return expected.retry ? 'pending-native-consumer' : 'advanced';
    }
    const obligation = await tx.query(`SELECT 1 FROM access.erasure WHERE route=$1 AND account_id=$2`, [
      current.route,
      current.account_id,
    ]);
    allow(obligation.rowCount === 1);
    if (consumerPending) return pending(consumerPending);
    await tx.query("SELECT set_config('rezics.erasure_progress',$1,true)", [progressId]);
    if (store === 'organization_member' || store === 'organization_close') {
      // This is the installed migration's exact primary key, not a guessed
      // schema shape, empty page or a feature flag standing in for deployment.
      const cutover = await tx.query('SELECT 1 FROM public.schema_migrations WHERE version=$1', ['20261029041713']);
      if (!cutover.rowCount) return pending('organization-cursor-cutover');
    }
    if (store === 'write_rate_counter' || store === 'write_rate_chunk') {
      const coverage = await tx.query<{ covered: boolean }>(
        "SELECT covered FROM access.erasure_native_coverage WHERE name='rate-account-binding'",
      );
      if (!coverage.rows[0]?.covered) return pending('rate-binding-deployment-coverage');
    }
    if (store.startsWith('lifecycle_handle') || store === 'handle_claim') {
      // This indexed partial prefix is independent of completed operation history.
      // A published operation is still a real consumer; do not cancel or TTL it.
      const unfinished = await tx.query(
        `SELECT 1 FROM access.lifecycle_handle_operation
         WHERE account_id=$1 AND route=$2 AND state='published' LIMIT 1`,
        [current.account_id, current.route],
      );
      if (unfinished.rowCount || (store === 'handle_claim' && !(await claimsReady(tx, page)))) {
        return pending('handle-consumer');
      }
    }
    // Readiness precedes ALL mutations: a single live consumer keeps this
    // whole raw page replayable, and cannot leave a partly purged checkpoint.
    for (const key of page.keys) {
      const blocker =
        (copyBlocked.has(JSON.stringify(key)) ? 'native-terminal-consumer' : null) ??
        foreignBlocked.get(JSON.stringify(key)) ??
        effectBlocked.get(JSON.stringify(key)) ??
        (store === 'erasure_continuation_role' ? await continuationRoleBlocker(tx, key) : null) ??
        (await terminalStoreBlocker(
          tx,
          store,
          role,
          key,
          current.account_id,
          progressId,
          expected.phase,
          current.phase === NATIVE_ERASURE_GROUPS.length,
          authRetirement,
        )) ??
        (await nativeStoreBlocker(tx, store, key, current.account_id, role));
      if (blocker) return pending(blocker);
    }
    // No dynamic caller-provided SQL: identifiers/types come only from the adopted manifest.
    for (const key of page.keys) {
      allow(key.length === columns.length && partitionOf(Number(key[0])) === page.partition);
      const params: unknown[] = [...key, current.account_id];
      const where = columns.map(({ name, type }, i) => `${name}=$${i + 1}::${type}`).join(' AND ');
      const owner = `${role}=$${params.length}::uuid ${spec[4] ? `AND ${spec[4]}` : ''}`;
      if (store === 'agent_identity_intent' || store === 'agent_identity_recovery') {
        // Only the dedicated same-Source-frame minimizer can mutate original proof.
        // The blocker above and residue below verify its durable role disposition.
      } else if (store === 'handle_claim') {
        await tx.query(
          `UPDATE access.handle_claim SET state='retired',account_id=NULL,transaction_id=NULL,
           expires_at=NULL,reserved_until=NULL,reservation_id=NULL,hold_operation_id=NULL,
           hold_expected_handle=NULL,former_until=NULL WHERE ${where} AND ${owner}`,
          params,
        );
      } else if (store === 'erasure_continuation_role') {
        const artifact = continuationArtifact(key[1]!);
        const table = CONTINUATION_ARTIFACTS[artifact];
        if (artifact !== 'root') {
          const identity =
            artifact === 'page'
              ? "sha256(convert_to(page_key,'UTF8'))"
              : "sha256(convert_to(concat_ws(':',step,key),'UTF8'))";
          await tx.query(
            `INSERT INTO access.erasure_native_consumed_child(route,continuation_id,artifact,entry_key,progress_id)
            SELECT route,continuation_id,$3,${identity},$4 FROM access.${table} WHERE route=$1 AND erasure_row_id=$2
            ON CONFLICT DO NOTHING`,
            [key[0], key[2], artifact, progressId],
          );
        }
        await tx.query(
          `WITH permit AS MATERIALIZED (SELECT set_config('rezics.erasure_row',$2,true))
          DELETE FROM access.${table} USING permit WHERE route=$1 AND erasure_row_id=$2::uuid`,
          [key[0], key[2]],
        );
        allow(
          (await tx.query(`SELECT 1 FROM access.${table} WHERE route=$1 AND erasure_row_id=$2::uuid`, [key[0], key[2]]))
            .rowCount === 0,
        );
        await tx.query(`DELETE FROM access.erasure_continuation_role WHERE ${where} AND ${owner}`, params);
      } else if (isAuthConsumerStore(store)) {
        await tx.query(
          `DELETE FROM access.${store} WHERE ${where} AND ${owner}
           AND ${authConsumerDeletePredicate(store, role, columns.length)}`,
          [...params, progressId],
        );
      } else {
        const minimize = nativeMinimization(store, role);
        if (store === 'account' && role === 'account_id')
          await tx.query("SELECT set_config('rezics.erasure_terminal',$1,true)", [current.account_id]);
        if (['committed_continuation', 'lifecycle_membership_slot', 'membership_inverse_terminal'].includes(store))
          await tx.query(
            `SELECT set_config('rezics.erasure_row',erasure_row_id::text,true) FROM access.${store} WHERE ${where} AND ${owner}`,
            params,
          );
        await tx.query(
          minimize
            ? `UPDATE access.${store} SET ${minimize} WHERE ${where} AND ${owner}`
            : `DELETE FROM access.${store} WHERE ${where} AND ${owner}`,
          params,
        );
      }
      // Prove the exact selected ownership is absent before advancing destructive progress.
      const residue = await tx.query(
        `SELECT 1 FROM access.${store} WHERE ${where} AND ${owner} AND ${nativeResiduePredicate(store, role)}`,
        params,
      );
      allow(residue.rowCount === 0);
    }
    const nextPhase = expected.phase + (page.done ? 1 : 0);
    if (expected.retry) {
      if (page.done) {
        await tx.query('DELETE FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2', [
          progressId,
          expected.phase,
        ]);
      } else {
        await tx.query('UPDATE access.erasure_native_blocked SET page=$3 WHERE progress_id=$1 AND phase=$2', [
          progressId,
          expected.phase,
          expected.page + 1,
        ]);
      }
      await tx.query('UPDATE access.erasure_native_progress SET retry_phase=$2 WHERE progress_id=$1', [
        progressId,
        expected.phase,
      ]);
    } else {
      await tx.query(`UPDATE access.erasure_native_progress SET phase=$2,page=$3,pending=$4 WHERE progress_id=$1`, [
        progressId,
        nextPhase,
        page.done ? 0 : expected.page + 1,
        nextPhase === NATIVE_ERASURE_GROUPS.length ? 'native-inventory' : null,
      ]);
    }
    // Discovery replay contains account-linked raw keys. Drop each consumed page in
    // the SAME transaction as the purge and destructive checkpoint, never before it.
    await tx.query(
      `UPDATE access.erasure_progress SET result=NULL WHERE route=$1 AND account_id=$2 AND store=$3 AND role=$4`,
      [current.route, current.account_id, store, role],
    );
    return expected.retry ? 'pending-native-consumer' : 'advanced';
  });
}

async function claimsReady(tx: PoolClient, page: ErasureDiscoveryPage): Promise<boolean> {
  for (const [route, handle] of page.keys) {
    const row = await tx.query<{
      state: string;
      hold_operation_id: string | null;
    }>('SELECT state,hold_operation_id FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2 FOR UPDATE', [
      route,
      handle,
    ]);
    const claim = row.rows[0];
    if (claim && (claim.state !== 'reserved' || claim.hold_operation_id !== null)) return false;
  }
  return true;
}

/** Shares the default coordinator module. Pending is a fixed code, not acknowledgement.
 * Re-delivery enqueues the same opaque identity and PostgreSQL remains authoritative
 * even when the completed DBOS attempt is deleted. No fake shared-history handoff.
 */
export function registerNativeErasureWork(context: WorkContext): void {
  const step = DBOS.registerStep((progressId: string) => advanceNativeErasure(context.pool, progressId, context), {
    name: 'access.erasure.native-page',
    retriesAllowed: true,
    maxAttempts: 10,
  });
  DBOS.registerWorkflow(
    async (progressId: string) => {
      for (;;) {
        const result = await step(progressId);
        if (result === 'pending-native-inventory' || result === 'pending-shared-custody') return result;
        if (result === 'pending-handle-consumer' || result === 'pending-native-consumer') await DBOS.sleep(1000);
      }
    },
    { name: 'access.erasure.native' },
  );
  context.addEffects([
    {
      name: 'account_erasure_native',
      types: ['com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const { accountId } = event.data as { accountId: string };
        const progressId = await openNativeErasure(context.pool, accountId);
        await context.client.enqueue(
          {
            workflowName: 'access.erasure.native',
            workflowID: `access-native:${progressId}`,
            workflowIDReusePolicy: 'return-existing',
            queueName: 'maintenance',
          },
          progressId,
        );
      },
    },
  ]);
}
