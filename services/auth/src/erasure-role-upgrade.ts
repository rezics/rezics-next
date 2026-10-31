import type { PoolClient } from 'pg';
import { NATIVE_CREATION_PARTY_PRODUCERS } from './creation-party-context.ts';
import { NATIVE_REQUEST_PARTY_PRODUCER } from './workflow-request-parties.ts';

// Saved numeric identities. Never derive this inventory from a producer's mutable roles.
export const NATIVE_PHASE_VERSION = 3;
export type NativePhase =
  | { kind: 'clients' | 'assertion' | 'public-key' | 'counter' | 'done' }
  | { kind: 'subject' | 'request'; table: string; role: string }
  | { kind: 'unavailable'; source: 'creation' | 'request'; code: string };
export const nativeV1Phases: readonly NativePhase[] = [
  { kind: 'clients' }, // 0
  { kind: 'subject', table: 'oauthAccessToken', role: 'userId' }, // 1
  { kind: 'subject', table: 'oauthAccessToken', role: 'erasure_human_id' }, // 2
  { kind: 'subject', table: 'oauthAccessToken', role: 'erasure_operator_id' }, // 3
  { kind: 'subject', table: 'oauthAccessToken', role: 'erasure_client_owner_id' }, // 4
  { kind: 'subject', table: 'oauthAccessToken', role: 'erasure_source_client_owner_id' }, // 5
  { kind: 'subject', table: 'verification', role: 'erasure_account_id' }, // 6
  { kind: 'subject', table: 'verification', role: 'erasure_human_id' }, // 7
  { kind: 'subject', table: 'verification', role: 'erasure_operator_id' }, // 8
  { kind: 'subject', table: 'verification', role: 'erasure_client_owner_id' }, // 9
  { kind: 'subject', table: 'verification', role: 'erasure_source_client_owner_id' }, // 10
  { kind: 'subject', table: 'auth_recent_oidc_session', role: 'account_id' }, // 11
  { kind: 'subject', table: 'auth_recent_oidc_session', role: 'erasure_human_id' }, // 12
  { kind: 'subject', table: 'auth_recent_oidc_session', role: 'erasure_operator_id' }, // 13
  { kind: 'subject', table: 'auth_recent_oidc_session', role: 'erasure_client_owner_id' }, // 14
  { kind: 'subject', table: 'auth_recent_oidc_session', role: 'erasure_source_client_owner_id' }, // 15
  { kind: 'subject', table: 'oauthClientAssertion', role: 'erasure_client_owner_id' }, // 16
  { kind: 'subject', table: 'oauthClientAssertion', role: 'erasure_source_client_owner_id' }, // 17
  { kind: 'subject', table: 'oauthRefreshToken', role: 'userId' }, // 18
  { kind: 'subject', table: 'oauthRefreshToken', role: 'erasure_human_id' }, // 19
  { kind: 'subject', table: 'oauthRefreshToken', role: 'erasure_operator_id' }, // 20
  { kind: 'subject', table: 'oauthRefreshToken', role: 'erasure_client_owner_id' }, // 21
  { kind: 'subject', table: 'oauthRefreshToken', role: 'erasure_source_client_owner_id' }, // 22
  { kind: 'subject', table: 'oauthRefreshFamily', role: 'erasure_account_id' }, // 23
  { kind: 'subject', table: 'oauthRefreshFamily', role: 'erasure_human_id' }, // 24
  { kind: 'subject', table: 'oauthRefreshFamily', role: 'erasure_operator_id' }, // 25
  { kind: 'subject', table: 'oauthRefreshFamily', role: 'erasure_client_owner_id' }, // 26
  { kind: 'subject', table: 'oauthRefreshFamily', role: 'erasure_source_client_owner_id' }, // 27
  { kind: 'subject', table: 'session', role: 'userId' }, // 28
  { kind: 'subject', table: 'session', role: 'erasure_human_id' }, // 29
  { kind: 'subject', table: 'session', role: 'erasure_operator_id' }, // 30
  { kind: 'subject', table: 'session', role: 'erasure_client_owner_id' }, // 31
  { kind: 'subject', table: 'session', role: 'erasure_source_client_owner_id' }, // 32
  { kind: 'subject', table: 'auth_session_opening', role: 'subject_account_id' }, // 33
  { kind: 'subject', table: 'auth_session_opening', role: 'acting_human_id' }, // 34
  { kind: 'subject', table: 'auth_session_opening', role: 'operator_account_id' }, // 35
  { kind: 'subject', table: 'auth_session_opening', role: 'erasure_client_owner_id' }, // 36
  { kind: 'subject', table: 'auth_session_opening', role: 'erasure_source_client_owner_id' }, // 37
  { kind: 'subject', table: 'auth_recovery_establishment', role: 'account_id' }, // 38
  { kind: 'subject', table: 'auth_recovery_establishment', role: 'erasure_human_id' }, // 39
  { kind: 'subject', table: 'auth_recovery_establishment', role: 'erasure_operator_id' }, // 40
  { kind: 'subject', table: 'auth_recovery_establishment', role: 'erasure_client_owner_id' }, // 41
  { kind: 'subject', table: 'auth_recovery_establishment', role: 'erasure_source_client_owner_id' }, // 42
  { kind: 'subject', table: 'auth_barrier_proof', role: 'account_id' }, // 43
  { kind: 'subject', table: 'auth_barrier_proof', role: 'erasure_human_id' }, // 44
  { kind: 'subject', table: 'auth_barrier_proof', role: 'erasure_operator_id' }, // 45
  { kind: 'subject', table: 'auth_barrier_proof', role: 'erasure_client_owner_id' }, // 46
  { kind: 'subject', table: 'auth_barrier_proof', role: 'erasure_source_client_owner_id' }, // 47
  { kind: 'subject', table: 'auth_provisioning_receipt', role: 'account_id' }, // 48
  { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_creator_id' }, // 49
  { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_operator_id' }, // 50
  { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_delegate_id' }, // 51
  { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_initiator_id' }, // 52
  { kind: 'subject', table: 'account', role: 'userId' }, // 53
  { kind: 'subject', table: 'passkey', role: 'userId' }, // 54
  { kind: 'subject', table: 'auth_recovery', role: 'account_id' }, // 55
  { kind: 'subject', table: 'auth_effect_receipt', role: 'account_id' }, // 56
  { kind: 'subject', table: 'auth_effect_receipt', role: 'acting_human_id' }, // 57
  { kind: 'subject', table: 'auth_effect_receipt', role: 'erasure_operator_id' }, // 58
  { kind: 'subject', table: 'auth_effect_receipt', role: 'erasure_client_owner_id' }, // 59
  { kind: 'subject', table: 'auth_effect_receipt', role: 'erasure_source_client_owner_id' }, // 60
  { kind: 'subject', table: 'auth_registration_stage', role: 'account_id' }, // 61
  { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_creator_id' }, // 62
  { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_operator_id' }, // 63
  { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_delegate_id' }, // 64
  { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_initiator_id' }, // 65
  { kind: 'subject', table: 'auth_client_reduction_progress', role: 'erasure_client_owner_id' }, // 66
  { kind: 'subject', table: 'auth_client_reduction_progress', role: 'erasure_source_client_owner_id' }, // 67
  { kind: 'subject', table: 'auth_client_reduction', role: 'erasure_client_owner_id' }, // 68
  { kind: 'subject', table: 'auth_client_reduction', role: 'erasure_source_client_owner_id' }, // 69
  { kind: 'subject', table: 'auth_client_coverage', role: 'erasure_client_owner_id' }, // 70
  { kind: 'subject', table: 'auth_client_coverage', role: 'erasure_source_client_owner_id' }, // 71
  { kind: 'subject', table: 'oauthClientResource', role: 'erasure_client_owner_id' }, // 72
  { kind: 'subject', table: 'oauthClientResource', role: 'erasure_source_client_owner_id' }, // 73
  { kind: 'subject', table: 'auth_consent', role: 'erasure_client_owner_id' }, // 74
  { kind: 'subject', table: 'auth_consent', role: 'erasure_source_client_owner_id' }, // 75
  { kind: 'assertion' }, // 76
  { kind: 'public-key' }, // 77
  { kind: 'counter' }, // 78
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_subject_id' }, // 79
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_human_id' }, // 80
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_operator_id' }, // 81
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_member_id' }, // 82
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_previous_operator_id' }, // 83
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_client_owner_id' }, // 84
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_source_client_owner_id' }, // 85
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_delegate_id' }, // 86
  { kind: 'request', table: 'auth_workflow_request', role: 'erasure_initiator_id' }, // 87
  { kind: 'done' }, // 88
];
export const NATIVE_V1_END = 88;
export const nativeV1ClientPhases = [
  { table: 'oauthAccessToken', role: 'clientId' }, // 0
  { table: 'oauthAccessToken', role: 'erasure_source_client_id' }, // 1
  { table: 'verification', role: 'erasure_client_id' }, // 2
  { table: 'verification', role: 'erasure_source_client_id' }, // 3
  { table: 'auth_recent_oidc_session', role: 'erasure_client_id' }, // 4
  { table: 'oauthClientAssertion', role: 'erasure_client_id' }, // 5
  { table: 'oauthRefreshToken', role: 'clientId' }, // 6
  { table: 'oauthRefreshToken', role: 'erasure_source_client_id' }, // 7
  { table: 'oauthRefreshFamily', role: 'clientId' }, // 8
  { table: 'oauthRefreshFamily', role: 'erasure_source_client_id' }, // 9
  { table: 'session', role: 'clientId' }, // 10
  { table: 'auth_session_opening', role: 'erasure_client_id' }, // 11
  { table: 'auth_recovery_establishment', role: 'erasure_client_id' }, // 12
  { table: 'auth_recovery_establishment', role: 'erasure_source_client_id' }, // 13
  { table: 'auth_barrier_proof', role: 'erasure_client_id' }, // 14
  { table: 'auth_barrier_proof', role: 'erasure_source_client_id' }, // 15
  { table: 'auth_effect_receipt', role: 'client_id' }, // 16
  { table: 'auth_client_reduction_progress', role: 'client_id' }, // 17
  { table: 'auth_client_reduction', role: 'client_id' }, // 18
  { table: 'auth_client_coverage', role: 'client_id' }, // 19
  { table: 'oauthClientResource', role: 'clientId' }, // 20
  { table: 'auth_workflow_request', role: 'erasure_client_id' }, // 21
] as const;
export const nativeV1RequestRoles = [
  'erasure_subject_id',
  'erasure_human_id',
  'erasure_operator_id',
  'erasure_member_id',
  'erasure_previous_operator_id',
  'erasure_client_owner_id',
  'erasure_source_client_owner_id',
  'erasure_delegate_id',
  'erasure_initiator_id',
] as const;
// V2 is a saved inventory in its own right. Its unavailable slots are not
// raw-key seeks and cannot be reused as the boundaries of a delivered role.
export const nativeV2Phases: readonly NativePhase[] = [
  ...nativeV1Phases.slice(0, NATIVE_V1_END),
  { kind: 'unavailable', source: 'creation', code: 'native-creation-roles-unavailable' },
  { kind: 'unavailable', source: 'request', code: 'native-request-roles-unavailable' },
  { kind: 'done' },
];
export const NATIVE_V2_END = 90;
// Bound to the original native producers, not a descriptor or guessed schema.
export const nativePhaseExtensions: readonly NativePhase[] = [
  ...NATIVE_CREATION_PARTY_PRODUCERS[0].accountPhases,
  ...NATIVE_CREATION_PARTY_PRODUCERS[1].accountPhases,
  ...NATIVE_REQUEST_PARTY_PRODUCER.accountPhases,
];
export const nativePhases: readonly NativePhase[] = [
  ...nativeV1Phases.slice(0, NATIVE_V1_END),
  ...nativePhaseExtensions,
  { kind: 'done' },
];
export const NATIVE_PHASE_END = NATIVE_V1_END + nativePhaseExtensions.length;
// Preserve the old consent position (22), including its pending deadline.
// Newly delivered client roles start after it, never reinterpret that boundary.
export const NATIVE_CLIENT_CONSENT_PHASE = 22;
export const NATIVE_REQUEST_SOURCE_CLIENT_PHASE = 23;
export const NATIVE_CLIENT_PHASE_END = 28;
export const nativeClientPhases = [
  ...nativeV1ClientPhases,
  null, // Original consent page.
  NATIVE_REQUEST_PARTY_PRODUCER.clientPhase,
  ...NATIVE_CREATION_PARTY_PRODUCERS[0].clientPhases,
  ...NATIVE_CREATION_PARTY_PRODUCERS[1].clientPhases,
] as const;

export type NativeCursor = {
  native_phase_version: number;
  phase: number;
  client_phase: number;
  after_key: string;
  client_id: string | null;
};
/** Closed identity adapter: completed old phases stay completed, and old EOF
 * becomes the first appended phase. Raw keys and the in-flight client subphase
 * are preserved exactly; all other versions and out-of-inventory numbers fail. */
export function upgradeNativeCursor<T extends NativeCursor>(
  cursor: T,
): Omit<T, 'native_phase_version'> & { native_phase_version: typeof NATIVE_PHASE_VERSION } {
  const end =
    cursor.native_phase_version === 1
      ? NATIVE_V1_END
      : cursor.native_phase_version === 2
        ? NATIVE_V2_END
        : NATIVE_PHASE_END;
  const clientEnd =
    cursor.native_phase_version === NATIVE_PHASE_VERSION ? NATIVE_CLIENT_PHASE_END : nativeV1ClientPhases.length;
  if (
    ![1, 2, NATIVE_PHASE_VERSION].includes(cursor.native_phase_version) ||
    !Number.isInteger(cursor.phase) ||
    cursor.phase < 0 ||
    cursor.phase > end ||
    !Number.isInteger(cursor.client_phase) ||
    cursor.client_phase < 0 ||
    cursor.client_phase > clientEnd ||
    Buffer.byteLength(cursor.after_key) > 1024 ||
    (cursor.client_id !== null && Buffer.byteLength(cursor.client_id) > 1024)
  )
    throw new Error('Auth native phase cursor unavailable');
  // No v2 cursor contains independent completion evidence for the delivered
  // creation roles. Both placeholders and done revisit the first required role. No old done marker
  // can certify a newly delivered role. Save the immutable old cursor separately
  // in the transaction that persists this translation.
  if (cursor.native_phase_version === 2 && cursor.phase >= NATIVE_V1_END)
    return { ...cursor, phase: NATIVE_V1_END, after_key: '', native_phase_version: NATIVE_PHASE_VERSION };
  return { ...cursor, native_phase_version: NATIVE_PHASE_VERSION };
}

/** Acquire before touching stores. The durable marker and database triggers
 * refuse old leases/pages even in other processes after activation commits. */
export async function requireNativePhaseVersion(client: PoolClient): Promise<void> {
  const marker = await client.query(
    'SELECT 1 FROM auth_native_phase_deployment WHERE singleton AND version=$1 FOR SHARE',
    [NATIVE_PHASE_VERSION],
  );
  if (!marker.rowCount) throw new Error('Auth native phase deployment unavailable');
  await client.query("SELECT set_config('auth.native_phase_worker','3',true)");
}

export function nativePhaseComplete(cursor: { native_phase_version: number; phase: number }): boolean {
  return cursor.native_phase_version === NATIVE_PHASE_VERSION && cursor.phase === NATIVE_PHASE_END;
}
