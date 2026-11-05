import type { PoolClient } from 'pg';
import { partitionOf } from '../route/route.ts';
import type { ErasureDiscoveryPage } from './erasure-progress.ts';

/** Append only: these positions are durable scheduling identities. */
export const TERMINAL_NATIVE_ERASURE_GROUPS = [
  ['lifecycle_registration_expiry', 'account_id'],
  ['membership_inverse', 'account_id'],
  ['membership_inverse', 'group_id'],
  ['operator_relation_slot', 'subject_account_id'],
  ['operator_relation_slot', 'operator_account_id'],
  ['lifecycle_coordination', 'account_id'],
  ['lifecycle_coordination', 'related_account_id'],
  ['lifecycle_membership_slot', 'organization_id'],
  ['lifecycle_membership_slot', 'member_account_id'],
  ['membership_inverse_terminal', 'account_id'],
  ['membership_inverse_terminal', 'group_id'],
  ['workflow_approval', 'actor_id'],
  ['workflow_approval', 'erasure_subject_id'],
  ['workflow_approval', 'erasure_operator_id'],
  ['workflow_approval', 'erasure_member_id'],
  ['workflow_approval', 'erasure_previous_operator_id'],
  ['workflow_approval', 'erasure_previous_subject_id'],
  ['workflow_approval', 'erasure_principal_id'],
  ['operator_opening_receipt', 'operator_account_id'],
  ['operator_opening_receipt', 'subject_account_id'],
  ['operator_opening_receipt', 'acting_human_id'],
  ['operator_opening_receipt', 'erasure_principal_id'],
  ['credential_floor_receipt', 'account_id'],
  ['erasure_continuation_role', 'account_id'],
  ['lifecycle_fence_receipt', 'account_id'],
  ['lifecycle_fence_receipt', 'prior_operator_account_id'],
  ['lifecycle_fence_receipt', 'operator_account_id'],
  ['account', 'operator_account_id'],
  ['account', 'controller_id'],
  // The identity skeleton is always last, including retries of blocked phases.
  ['account', 'account_id'],
] as const;

/** These append to the original phase numbers. Never reorder persisted phases. */
export const ADDITIONAL_NATIVE_ERASURE_GROUPS = [
  ['principal_assignment', 'principal_id'],
  ['principal_assignment', 'creator_principal_id'],
  ['principal_assignment', 'assigned_actor_id'],
  ['governance_reach', 'resource_id'],
  ['governance_reach', 'actor_account_id'],
  ['resource_initialization', 'resource_id'],
  ['resource_initialization', 'creator_id'],
  ['governance_bootstrap', 'account_id'],
  ['rating_counter_controller', 'account_id'],
  ['rating_counter_controller', 'controller_id'],
  ['organization_member', 'organization_id'],
  ['organization_member', 'member_account_id'],
  ['organization_close', 'organization_id'],
  ['agent_verification_request', 'account_id'],
  ['agent_verification_request', 'requested_by'],
  ['agent_verification_request', 'decided_by'],
  ['write_rate_chunk', 'account_id'],
  ['write_rate_counter', 'account_id'],
  ['committed_continuation', 'account_id'],
  ['committed_continuation', 'prior_operator_account_id'],
  ['agent_page', 'account_id'],
  ...TERMINAL_NATIVE_ERASURE_GROUPS,
  // New source stores append after the original scheduling identities. The
  // terminal account page waits for this forward pass and all blocked pages.
  ['account_discovery_intent', 'account_id'],
  ['account_discovery_claim_intent', 'account_id'],
  ['account_discovery_claim_cursor', 'account_id'],
  ['agent_identity_intent', 'account_id'],
  ['agent_identity_intent', 'requested_by'],
  ['agent_identity_intent', 'decided_by'],
  ['agent_identity_recovery', 'account_id'],
  ['agent_identity_recovery', 'requested_by'],
  ['agent_identity_recovery', 'decided_by'],
  ['realm_erasure_succession', 'account_id'],
  ['realm_erasure_succession', 'best_account_id'],
  ['realm_erasure_succession', 'cursor_subject_id'],
  ['agent_identity_technical_source', 'account_id'],
  ['agent_identity_technical_role', 'account_id'],
  ['agent_identity_technical_role', 'role_account_id'],
  ['agent_identity_reversal_settlement', 'account_id'],
  ['live_copy_inventory', 'account_id'],
  ['live_copy_business_inventory', 'account_id'],
] as const;

export type NativeStoreBlocker =
  | 'membership-terminal-consumer'
  | 'organization-close-consumer'
  | 'verification-decision-consumer'
  | 'verification-reversal-consumer'
  | 'controller-transition-consumer'
  | 'rating-controller-projection-custody'
  | 'native-terminal-consumer'
  | 'approval-consumer-proof-unavailable'
  | 'opening-consumer-proof-unavailable'
  | 'credential-consumer-proof-unavailable'
  | 'continuation-child-consumer'
  | 'continuation-barrier-consumer'
  | 'auth-fence-release-witness-unavailable'
  | 'operator-page-consumer'
  | 'account-discovery-consumer'
  | 'verification-source-custody'
  | 'realm-succession-source-custody'
  | 'terminal-inventory';

/** Validate even a durable replay before its raw keys reach a proof consumer. */
export function nativeErasurePageValid(page: ErasureDiscoveryPage, keyLength: number, expectedPage: number): boolean {
  return (
    page.page === expectedPage &&
    Number.isSafeInteger(page.page) &&
    page.page >= 0 &&
    Number.isInteger(page.partition) &&
    page.partition >= 0 &&
    page.partition < 4096 &&
    typeof page.done === 'boolean' &&
    Array.isArray(page.keys) &&
    page.keys.length <= 100 &&
    Buffer.byteLength(JSON.stringify(page)) <= 65536 &&
    page.keys.every(
      (key) =>
        Array.isArray(key) &&
        key.length === keyLength &&
        key.every((part) => typeof part === 'string') &&
        /^(0|[1-9][0-9]{0,4})$/.test(key[0]!) &&
        Number(key[0]) <= 65535 &&
        partitionOf(Number(key[0])) === page.partition &&
        Buffer.byteLength(JSON.stringify(key)) <= 1024,
    )
  );
}

/** A fixed, typed decision: pending and approving requests still have a real
 * decision consumer. TTL and a deleted reviewer do not make it terminal. */
export function verificationErasureReady(state: string): boolean {
  return ['approved', 'rejected', 'withdrawn', 'failed'].includes(state);
}

/** Only point probes in the selected store's partition. This is not discovery;
 * the keys have already come from discoverErasurePage's committed raw page.
 * A blocked page is retained whole, so none of its rows can be mistaken for a
 * committed purge. Other independent phases can proceed in the meantime.
 */
export async function nativeStoreBlocker(
  tx: PoolClient,
  store: string,
  key: readonly string[],
  accountId: string,
  role?: string,
): Promise<NativeStoreBlocker | null> {
  if (store === 'account_discovery_intent' || store === 'account_discovery_claim_intent') {
    // Source notifications must commit their actual outbox delivery. Deleting an
    // intent alone would suppress Search's tombstone/revision invalidation.
    const row = await tx.query(`SELECT 1 FROM access.${store} WHERE route=$1 AND account_id=$2`, [...key]);
    if (row.rowCount) return 'account-discovery-consumer';
  }
  if (store === 'agent_identity_reversal_settlement') {
    // A settlement transfers native inputs; it does not authorize deleting its
    // retained Account subject or replace independent source/copy/root custody.
    const row = await tx.query(
      `SELECT 1 FROM access.agent_identity_reversal_settlement
      WHERE route=$1 AND account_id=$2 AND reversal_receipt_id=$3`,
      [...key],
    );
    return row.rowCount ? 'verification-source-custody' : null;
  }
  if (store === 'agent_identity_technical_source' || store === 'agent_identity_technical_role') {
    // Saved pages can still name role rows physically removed by the privacy migration.
    // Only a remaining genuine technical locator is a pending custody obligation.
    const row = await tx.query(
      `SELECT 1 FROM access.${store} WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4${
        store === 'agent_identity_technical_role' ? ' AND role_account_id=$5' : ''
      }`,
      [...key],
    );
    return row.rowCount ? 'verification-source-custody' : null;
  }
  if (store === 'agent_identity_intent' && ['account_id', 'requested_by', 'decided_by'].includes(role ?? '')) {
    const row = await tx.query(
      `SELECT 1 FROM access.agent_identity_intent WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4
       AND ${role}=$5 ${role === 'account_id' ? 'AND NOT minimized' : ''}`,
      [...key, accountId],
    );
    return row.rowCount ? 'verification-source-custody' : null;
  }
  if (store === 'agent_identity_intent' || store === 'agent_identity_recovery') {
    const row = await tx.query(
      `SELECT 1 FROM access.${store} WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [...key],
    );
    if (row.rowCount) return 'verification-source-custody';
  }
  if (store === 'realm_erasure_succession') {
    const row = await tx.query(
      'SELECT 1 FROM access.realm_erasure_succession WHERE route=$1 AND resource_id=$2 AND account_id=$3',
      [...key],
    );
    if (row.rowCount) return 'realm-succession-source-custody';
  }
  if (store === 'organization_member') {
    const row = await tx.query<{
      live: boolean;
      held: boolean;
      closing: boolean;
    }>(
      `SELECT (upper_inf(m.valid) OR m.valid @> statement_timestamp()) AS live,
         EXISTS (SELECT 1 FROM access.lifecycle_membership_slot s
           WHERE s.route=m.route AND s.organization_id=m.organization_id AND s.member_account_id=m.member_account_id
             AND NOT s.terminal) AS held,
         EXISTS (SELECT 1 FROM access.organization_close c
           WHERE c.route=m.route AND c.organization_id=m.organization_id AND NOT c.complete) AS closing
       FROM access.organization_member m
       WHERE m.route=$1 AND m.organization_id=$2 AND m.member_account_id=$3 AND m.valid=$4::tstzrange
       FOR UPDATE OF m`,
      [...key],
    );
    if (row.rows[0]?.closing) return 'organization-close-consumer';
    if (row.rows[0]?.live || row.rows[0]?.held) return 'membership-terminal-consumer';
  }
  if (store === 'organization_close') {
    const row = await tx.query<{ complete: boolean }>(
      'SELECT complete FROM access.organization_close WHERE route=$1 AND organization_id=$2 FOR UPDATE',
      [...key],
    );
    if (row.rows[0] && !row.rows[0].complete) return 'organization-close-consumer';
  }
  if (store === 'agent_verification_request') {
    const row = await tx.query<{ state: string }>(
      'SELECT state FROM access.agent_verification_request WHERE route=$1 AND request_id=$2 FOR UPDATE',
      [...key],
    );
    if (row.rows[0] && !verificationErasureReady(row.rows[0].state)) return 'verification-decision-consumer';
  }
  if (store === 'rating_counter_controller') {
    // A surviving account's current controller must first finish its real
    // operator transition. Even ended history remains input to delayed Rating
    // vote events/recounts at event T; a current controller change alone is not
    // a projection-consumption witness.
    const row = await tx.query<{ current_controller: boolean | null }>(
      `SELECT a.account_id<>$4 AND a.controller_id=$4 AS current_controller
       FROM access.rating_counter_controller h LEFT JOIN access.account a
         ON a.route=h.route AND a.account_id=h.account_id
       WHERE h.route=$1 AND h.account_id=$2 AND h.effective_at=$3::timestamptz FOR SHARE OF h`,
      [...key, accountId],
    );
    if (!row.rowCount) return null;
    if (row.rows[0]!.current_controller) return 'controller-transition-consumer';
    return 'rating-controller-projection-custody';
  }
  return null;
}

/** Refusal markers survive without creator/bootstrap attribution. Resource ids
 * and resource types are native identity; deleting a marker would permit a
 * second initialization and reissue its first-owner grants.
 */
export function nativeMinimization(store: string, role?: string): string | null {
  if (store === 'agent_verification_request' && role === 'requested_by') return 'requested_by=NULL';
  if (store === 'agent_verification_request' && role === 'decided_by')
    return 'decided_by=NULL,reason=NULL,problem_type=NULL,problem_detail=NULL';
  if (store === 'account' && role === 'controller_id')
    return 'controller_id=CASE WHEN account_id=controller_id THEN controller_id ELSE NULL END';
  if (store === 'account' && role === 'account_id') return TERMINAL_ACCOUNT_MINIMIZATION;
  if (store === 'resource_initialization') return 'creator_id=NULL,initialized_at=NULL';
  if (store === 'governance_bootstrap') return 'account_id=NULL,transaction_id=NULL';
  return null;
}

export function nativeResiduePredicate(store: string, role?: string): string {
  // Self attribution belongs to the subject's final skeleton page. Foreign
  // current relationships require their real controller transition first.
  if (store === 'account' && role === 'controller_id') return 'account_id<>controller_id';
  if (store === 'account' && role === 'account_id')
    return `NOT (handle IS NULL AND display_name IS NULL AND avatar_url IS NULL AND avatar IS NULL
    AND biography IS NULL AND birth_date IS NULL AND content_preferences='{}'::jsonb AND suspension_reason IS NULL
    AND registration_id IS NULL AND registration_expires_at IS NULL AND operator_account_id IS NULL AND controller_id IS NULL
    AND operator_reservation_id IS NULL AND handle_operation_id IS NULL AND handle_change_times='{}'::timestamptz[]
    AND links='[]'::jsonb AND public_views='{"posts":false,"reviews":false,"collections":false,"realms":false}'::jsonb
    AND NOT speakers_listed AND NOT agent_verified AND agent_subject_id IS NULL AND agent_verification_receipt_id IS NULL
    AND pending_agent_subject_id IS NULL AND pending_agent_receipt_id IS NULL AND created_at IS NULL
    AND public_changed_at IS NULL AND membership_time IS NULL AND rate_tier='ordinary' AND operator_relation_version=0)`;

  if (store === 'agent_identity_intent' && role === 'account_id') return 'NOT minimized';
  if (store === 'resource_initialization') return '(creator_id IS NOT NULL OR initialized_at IS NOT NULL)';
  return 'true';
}

/** Constants retain schema shape, not the erased person's former choices. The
 * authentication floor and current fence/transaction remain refusal evidence. */
export const TERMINAL_ACCOUNT_MINIMIZATION = `handle=NULL,display_name=NULL,avatar_url=NULL,avatar=NULL,
  biography=NULL,birth_date=NULL,content_preferences='{}'::jsonb,suspension_reason=NULL,
  registration_id=NULL,registration_expires_at=NULL,operator_account_id=NULL,controller_id=NULL,
  operator_reservation_id=NULL,handle_operation_id=NULL,handle_change_times='{}'::timestamptz[],
  links='[]'::jsonb,public_views='{"posts":false,"reviews":false,"collections":false,"realms":false}'::jsonb,
  speakers_listed=false,agent_verified=false,agent_subject_id=NULL,agent_verification_receipt_id=NULL,
  pending_agent_subject_id=NULL,pending_agent_receipt_id=NULL,created_at=NULL,public_changed_at=NULL,
  membership_time=NULL,rate_tier='ordinary',operator_relation_version=0`;
