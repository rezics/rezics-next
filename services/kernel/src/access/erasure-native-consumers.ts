import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { ErasureDiscoveryPage } from './erasure-progress.ts';
import { routeOf } from '../route/route.ts';
import { readAuthNativeConsumption } from './shared-history-auth.ts';
import { publishedAccountIdentityUndo } from './agent-verification-identity.ts';
import { IdentityEpochStoreError } from '../semantic/identity-epoch-store.ts';
import type { NativeStoreBlocker } from './erasure-native-stores.ts';
import { authConsumerBlocker, isAuthConsumerStore, type AuthConsumerRetirement } from './erasure-auth-consumers.ts';

/** Read only the fixed Auth-native phase, anchored to the original source. An
 * accepted obligation, absent Auth row or later global ACK cannot satisfy it. */
export async function nativeContinuationBlocker(
  tx: PoolClient,
  route: string,
  continuationId: string,
): Promise<NativeStoreBlocker | null> {
  const result = await tx.query<{
    account_id: string;
    barrier_receipt_id: string;
    version: number | null;
    at: string | null;
    deletion: boolean;
    local_pending: boolean;
  }>(
    `SELECT c.account_id,c.barrier_receipt_id,e.version,e.at::text,
       c.allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb AS deletion,
       EXISTS (SELECT 1 FROM jsonb_array_elements(c.allowlist) a
         WHERE a->>'step' NOT IN ('erase-auth-owner','retire-operator','release-operator','redirect-deleted-handle'))
       OR EXISTS (SELECT 1 FROM access.lifecycle_handle_operation h
         WHERE h.route=c.route AND h.account_id=c.account_id AND h.state='published') AS local_pending
     FROM access.committed_continuation c
     LEFT JOIN access.erasure e ON e.route=c.route AND e.account_id=c.account_id
     WHERE c.route=$1 AND c.continuation_id=$2 FOR UPDATE OF c`,
    [route, continuationId],
  );
  const root = result.rows[0];
  if (!root) return null;
  // Historical suspension pages have their own native consumer and cursor
  // cutover. A newer fence is not proof that their published work finished.
  if (!root.deletion || root.local_pending || root.version === null || root.at === null)
    return 'continuation-barrier-consumer';
  if (
    !(await readAuthNativeConsumption(tx, {
      accountId: root.account_id,
      version: root.version,
      at: root.at,
      continuationId,
      receiptId: root.barrier_receipt_id,
    }))
  )
    return 'auth-fence-release-witness-unavailable';
  return null;
}

/** Exact probes after the selected raw key is locked. Missing consumer proof
 * holds that page; independent inventory phases continue. */
export async function terminalStoreBlocker(
  tx: PoolClient,
  store: string,
  role: string,
  key: readonly string[],
  accountId: string,
  progressId: string,
  phase = -1,
  forwardComplete = true,
  authRetirement: AuthConsumerRetirement | null = null,
): Promise<NativeStoreBlocker | null> {
  if (store === 'membership_inverse') {
    const row = await tx.query(
      `SELECT 1 FROM access.membership_inverse m WHERE route=$1 AND account_id=$2 AND kind=$3 AND group_id=$4
       AND (NOT EXISTS (SELECT 1 FROM access.membership_inverse_terminal t
         WHERE t.route=m.route AND t.account_id=m.account_id AND t.kind=m.kind AND t.group_id=m.group_id
           AND t.reservation_id=m.reservation_id AND t.reservation_transaction_id=m.transaction_id)
         OR EXISTS (SELECT 1 FROM access.lifecycle_coordination c
           WHERE c.route=m.route AND c.account_id=m.account_id AND c.reservation_id=m.reservation_id))`,
      [...key],
    );
    if (row.rowCount) return 'membership-terminal-consumer';
  }
  if (store === 'membership_inverse_terminal') {
    const row = await tx.query(
      `SELECT 1 FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND kind=$3 AND group_id=$4
       AND reservation_id=$5`,
      [...key],
    );
    if (row.rowCount) return 'membership-terminal-consumer';
    const hold = await tx.query(
      'SELECT 1 FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
      [key[0], key[1], key[4]],
    );
    if (hold.rowCount) return 'membership-terminal-consumer';
  }
  if (store === 'lifecycle_membership_slot' || store === 'operator_relation_slot') {
    const membership = store === 'lifecycle_membership_slot';
    const row = await tx.query<{ terminal: boolean }>(
      membership
        ? 'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4 FOR UPDATE'
        : 'SELECT terminal FROM access.operator_relation_slot WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3 FOR UPDATE',
      [...key],
    );
    if (row.rows[0] && !row.rows[0].terminal)
      return membership ? 'membership-terminal-consumer' : 'native-terminal-consumer';
  }
  if (store === 'lifecycle_coordination') {
    // A live hold has no cleanup-only cancellation authority. Its native
    // membership/operator release must run, even if the account is deleted.
    const row = await tx.query(
      'SELECT 1 FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
      [...key],
    );
    if (row.rowCount) return 'native-terminal-consumer';
  }
  if (store === 'lifecycle_registration_expiry') {
    const row = await tx.query(
      `SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2
       AND (state<>'deleted' OR NOT authn_fenced OR registration_id IS NOT NULL)`,
      [key[0], key[1]],
    );
    if (row.rowCount) return 'native-terminal-consumer';
  }
  if (isAuthConsumerStore(store))
    return authConsumerBlocker(tx, store, role, key, accountId, progressId, authRetirement);
  if (
    store === 'committed_continuation' ||
    store === 'committed_continuation_entry' ||
    store === 'committed_continuation_completion' ||
    store === 'operator_fence_page'
  ) {
    const blocker = await nativeContinuationBlocker(tx, key[0]!, key[1]!);
    if (blocker) return blocker;
    if (store === 'operator_fence_page') return 'operator-page-consumer';
    if (store === 'committed_continuation') {
      const children = await tx.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM access.committed_continuation_entry WHERE route=$1 AND continuation_id=$2)
         OR EXISTS (SELECT 1 FROM access.committed_continuation_completion WHERE route=$1 AND continuation_id=$2)
         OR EXISTS (SELECT 1 FROM access.operator_fence_page WHERE route=$1 AND continuation_id=$2)`,
        [...key],
      );
      if (children.rowCount) return 'continuation-child-consumer';
    }
  }
  if (store === 'lifecycle_fence_receipt') {
    // A different discovered role can have committed the same row's purge.
    // Absence clears only this stale page key, never another live dependency.
    const selected = await tx.query(
      'SELECT 1 FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 AND receipt_id=$3 FOR UPDATE',
      [...key],
    );
    if (!selected.rowCount) return null;
    // Source Realm succession still reads the original tombstone fence. First
    // discover its actual roles; Auth consumption discharges only Auth's need.
    if (!forwardComplete) return 'native-terminal-consumer';
    const realm = await tx.query(
      `SELECT 1 FROM access.erasure_native_blocked WHERE progress_id=$1
       AND reason IN ('membership-terminal-consumer','realm-succession-source-custody') LIMIT 1`,
      [progressId],
    );
    // Keep this phase distinct from its prerequisites: a retained fence must
    // never become its own membership-consumer dependency on the next retry.
    if (realm.rowCount) return 'native-terminal-consumer';
    const root = await tx.query<{ continuation_id: string }>(
      `SELECT continuation_id FROM access.committed_continuation
       WHERE route=$1 AND account_id=$2 AND barrier_receipt_id=$3 LIMIT 1`,
      [...key],
    );
    if (root.rows[0])
      return (
        (await nativeContinuationBlocker(tx, key[0]!, root.rows[0].continuation_id)) ?? 'continuation-child-consumer'
      );
    // The source transfer remains historical. Re-lock current receiving custody
    // in THIS destructive transaction; replacement takes the same native fence.
    // Foreign operator-origin fences still require their own exact consumer.
    const proof = await tx.query<{ closure: { sourceReceiptId: string } | null }>(
      `SELECT access.lock_current_auth_receiving_closure(e.route,e.account_id,e.version,e.at) AS closure
       FROM access.erasure e WHERE e.route=$1 AND e.account_id=$2`,
      [key[0], key[1]],
    );
    if (proof.rows[0]?.closure?.sourceReceiptId !== key[2]) return 'auth-fence-release-witness-unavailable';
  }
  if (store === 'account') {
    if (role === 'operator_account_id' || role === 'controller_id') {
      const related = await tx.query(
        `SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 AND ${role}=$3 AND account_id<>$3`,
        [...key, accountId],
      );
      if (related.rowCount) return 'controller-transition-consumer';
    }
    if (role === 'account_id') {
      if (!forwardComplete) return 'terminal-inventory';
      const blocked = await tx.query(
        'SELECT 1 FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase<>$2 LIMIT 1',
        [progressId, phase],
      );
      if (blocked.rowCount) return 'terminal-inventory';
      const account = await tx.query(
        `SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 AND state='deleted' AND authn_fenced
         AND NOT agent_verified AND pending_agent_receipt_id IS NULL AND operator_account_id IS NULL`,
        [...key],
      );
      if (!account.rowCount) return 'native-terminal-consumer';
    }
  }
  return null;
}

/** Released-partition source observations. Terminal proof rows are immutable;
 * native member release inserts the copied proof and removes its inverse/hold
 * atomically. Absence alone is never accepted. No connection crosses a partition.
 */
export async function foreignTerminalBlockers(
  pool: Pool,
  store: string,
  page: ErasureDiscoveryPage,
  erasedAccountId: string,
): Promise<Map<string, NativeStoreBlocker>> {
  const blocked = new Map<string, NativeStoreBlocker>();
  if (store === 'agent_page' && page.keys.length) {
    const account = await withConnection(pool, (tx) =>
      tx.query<{ unfinished: boolean }>(
        `SELECT agent_verified OR pending_agent_receipt_id IS NOT NULL AS unfinished
         FROM access.account WHERE route=$1 AND account_id=$2`,
        [routeOf(erasedAccountId), erasedAccountId],
      ),
    );
    if (!account.rows[0] || account.rows[0].unfinished)
      for (const key of page.keys) blocked.set(JSON.stringify(key), 'verification-reversal-consumer');
  }
  for (const key of page.keys) {
    if (store === 'agent_verification_request') {
      const request = await withConnection(pool, (tx) =>
        tx.query<{ account_id: string; state: string; decision_receipt_id: string | null }>(
          'SELECT account_id,state,decision_receipt_id FROM access.agent_verification_request WHERE route=$1 AND request_id=$2',
          [...key],
        ),
      );
      const decision = request.rows[0];
      if (decision?.state === 'approved') {
        // The approved state precedes final publication in the real workflow.
        // Verify the exact original published job before removing its caller or
        // review attribution. This also works for a fenced verification subject.
        if (!decision.decision_receipt_id) {
          blocked.set(JSON.stringify(key), 'verification-decision-consumer');
        } else {
          try {
            await publishedAccountIdentityUndo(pool, decision.account_id, decision.decision_receipt_id);
          } catch (error) {
            if (!(error instanceof IdentityEpochStoreError)) throw error;
            blocked.set(JSON.stringify(key), 'verification-decision-consumer');
          }
        }
      }
      if (request.rows[0]?.account_id === erasedAccountId) {
        // This is another partition. Observe its monotonic deleted-account
        // reversal witness before opening the Global request purge transaction.
        const account = await withConnection(pool, (tx) =>
          tx.query<{ unfinished: boolean }>(
            `SELECT agent_verified OR pending_agent_receipt_id IS NOT NULL AS unfinished
             FROM access.account WHERE route=$1 AND account_id=$2 AND state='deleted'`,
            [routeOf(erasedAccountId), erasedAccountId],
          ),
        );
        if (!account.rows[0] || account.rows[0].unfinished)
          blocked.set(JSON.stringify(key), 'verification-reversal-consumer');
      }
    }
    if (store === 'lifecycle_membership_slot') {
      const source = await withConnection(pool, (tx) =>
        tx.query<{ transaction_id: string; terminal: boolean }>(
          'SELECT transaction_id,terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4',
          [...key],
        ),
      );
      const slot = source.rows[0];
      if (!slot) continue;
      const consumed =
        slot.terminal &&
        (await withConnection(
          pool,
          async (tx) =>
            (
              await tx.query(
                `SELECT 1 FROM access.membership_inverse_terminal t
         WHERE t.route=$1 AND t.account_id=$2 AND t.kind='organization' AND t.group_id=$3 AND t.reservation_id=$4
         AND t.proof_transaction_id=$5
         AND NOT EXISTS (SELECT 1 FROM access.membership_inverse m
           WHERE m.route=t.route AND m.account_id=t.account_id AND m.kind=t.kind AND m.group_id=t.group_id AND m.reservation_id=t.reservation_id)
         AND NOT EXISTS (SELECT 1 FROM access.lifecycle_coordination c
           WHERE c.route=t.route AND c.account_id=t.account_id AND c.reservation_id=t.reservation_id)`,
                [routeOf(key[2]!), key[2], key[1], key[3], slot.transaction_id],
              )
            ).rowCount === 1,
        ));
      if (!consumed) blocked.set(JSON.stringify(key), 'membership-terminal-consumer');
    }
    if (store === 'membership_inverse_terminal' && key[2] === 'organization') {
      const source = await withConnection(pool, (tx) =>
        tx.query(
          'SELECT 1 FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4',
          [routeOf(key[3]!), key[3], key[1], key[4]],
        ),
      );
      if (source.rowCount) blocked.set(JSON.stringify(key), 'membership-terminal-consumer');
    }
    if (store === 'membership_inverse_terminal' && key[2] === 'realm') {
      // Realm publication/cancellation owns its original terminal proof. No
      // Access-side inverse observation can discharge the source consumer.
      const selected = await withConnection(pool, (tx) =>
        tx.query(
          `SELECT 1 FROM access.membership_inverse_terminal
           WHERE route=$1 AND account_id=$2 AND kind=$3 AND group_id=$4 AND reservation_id=$5`,
          [...key],
        ),
      );
      if (selected.rowCount) blocked.set(JSON.stringify(key), 'membership-terminal-consumer');
    }
    if (store === 'operator_relation_slot') {
      // Retirement is before release. Require the actual original release
      // command, never terminal=true or a missing operator hold by itself.
      const source = await withConnection(pool, (tx) =>
        tx.query<{ operator_account_id: string; command_key_prefix: string | null; terminal: boolean }>(
          `SELECT s.operator_account_id,s.terminal,c.command_key_prefix FROM access.operator_relation_slot s
         LEFT JOIN access.committed_continuation c ON c.route=s.route AND c.account_id=s.subject_account_id
           AND c.prior_reservation_id=s.reservation_id AND c.prior_operator_account_id=s.operator_account_id
         WHERE s.route=$1 AND s.subject_account_id=$2 AND s.reservation_id=$3 LIMIT 1`,
          [...key],
        ),
      );
      const root = source.rows[0];
      if (!root) continue;
      const released =
        root.terminal &&
        root.command_key_prefix !== null &&
        (await withConnection(pool, async (tx) => {
          const route = routeOf(root.operator_account_id)!;
          return (
            (
              await tx.query(
                `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
           AND principal_id='00000000-0000-8000-8000-000000000001'
           AND command_kind='access.operator.responsibility-released' AND idempotency_key=$2`,
                [Math.floor(route / 16), `${route}:${root.command_key_prefix}:release-operator`],
              )
            ).rowCount === 1
          );
        }));
      if (!released) blocked.set(JSON.stringify(key), 'native-terminal-consumer');
    }
  }
  return blocked;
}

export const CONTINUATION_ARTIFACTS = {
  root: 'committed_continuation',
  entry: 'committed_continuation_entry',
  completion: 'committed_continuation_completion',
  page: 'operator_fence_page',
} as const;
type Artifact = keyof typeof CONTINUATION_ARTIFACTS;
export function continuationArtifact(value: string): Artifact {
  if (!Object.hasOwn(CONTINUATION_ARTIFACTS, value)) throw new Error('Unknown native continuation artifact');
  return value as Artifact;
}

export async function continuationRoleBlocker(
  tx: PoolClient,
  key: readonly string[],
): Promise<NativeStoreBlocker | null> {
  const artifact = continuationArtifact(key[1]!);
  const table = CONTINUATION_ARTIFACTS[artifact];
  const source = await tx.query<{ continuation_id: string }>(
    `SELECT continuation_id FROM access.${table} WHERE route=$1 AND erasure_row_id=$2 FOR UPDATE`,
    [key[0], key[2]],
  );
  const row = source.rows[0];
  if (!row) return null;
  if (artifact === 'page') return 'operator-page-consumer';
  const blocker = await nativeContinuationBlocker(tx, key[0]!, row.continuation_id);
  if (blocker) return blocker;
  return artifact === 'root'
    ? terminalStoreBlocker(tx, table, 'account_id', [key[0]!, row.continuation_id], '', '')
    : null;
}

/** One immutable original allowlist, at most four entries, never a graph walk.
 * A completed authorization entry is deliberately insufficient: require the
 * actual business command's committed receipt under its original native key. */
export async function continuationEffectBlockers(
  pool: Pool,
  store: string,
  page: ErasureDiscoveryPage,
): Promise<Map<string, NativeStoreBlocker>> {
  const blockers = new Map<string, NativeStoreBlocker>();
  if (store !== 'committed_continuation' && store !== 'erasure_continuation_role') return blockers;
  for (const key of page.keys) {
    const table = store === 'committed_continuation' ? store : CONTINUATION_ARTIFACTS[continuationArtifact(key[1]!)];
    const root = await withConnection(pool, async (tx) => {
      const located =
        store === 'committed_continuation'
          ? key[1]
          : (
              await tx.query<{ continuation_id: string }>(
                `SELECT continuation_id FROM access.${table} WHERE route=$1 AND erasure_row_id=$2`,
                [key[0], key[2]],
              )
            ).rows[0]?.continuation_id;
      if (!located) return null;
      return (
        (
          await tx.query<{ account_id: string; allowlist: Array<{ step: string; target: string; key: string }> }>(
            'SELECT account_id,allowlist FROM access.committed_continuation WHERE route=$1 AND continuation_id=$2',
            [key[0], located],
          )
        ).rows[0] ?? null
      );
    });
    if (!root) continue;
    for (const entry of root.allowlist) {
      if (entry.step === 'erase-auth-owner') continue;
      const kinds: Record<string, string> = {
        'retire-operator': 'access.operator.responsibility-retired',
        'release-operator': 'access.operator.responsibility-released',
        'redirect-deleted-handle': 'access.handle-redirected',
      };
      const kind = kinds[entry.step];
      if (!kind) {
        blockers.set(JSON.stringify(key), 'continuation-barrier-consumer');
        break;
      }
      const anchor = entry.step === 'release-operator' ? entry.target.split(':')[0]! : root.account_id;
      // Handle commands are anchored to the normalized handle, not its former
      // account's route. Read the original receipt in that physical partition.
      const route =
        entry.step === 'redirect-deleted-handle'
          ? createHash('sha256').update(entry.target).digest().readUInt16BE(0)
          : routeOf(anchor)!;
      const proof = await withConnection(pool, (tx) =>
        tx.query(
          `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
         AND principal_id='00000000-0000-8000-8000-000000000001'
         AND command_kind=$2 AND idempotency_key=$3`,
          [Math.floor(route / 16), kind, `${route}:${entry.key}`],
        ),
      );
      if (!proof.rowCount) {
        blockers.set(JSON.stringify(key), 'native-terminal-consumer');
        break;
      }
    }
  }
  return blockers;
}
