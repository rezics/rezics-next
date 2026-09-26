// Row declarations for migration 043. One row revokes one source; a strong request
// fixes its drain list at the fence and completes only after that work is terminal.

export const REVOCATION_AFFECTED_WORK_LIMIT = 256;

export type RevocationTargetKind = 'representation' | 'permission_grant'
  | 'principal_permission_grant' | 'group_permission_grant' | 'role_binding'
  | 'private_role_binding';

export type RevocationRow = {
  id: string; principal_id: string; issuer_subject: string; mode: 'ordinary' | 'strong';
  target_kind: RevocationTargetKind; representation_id: string | null;
  permission_grant_id: string | null; principal_permission_grant_id: string | null;
  group_permission_grant_id: string | null; role_binding_id: string | null;
  private_role_binding_id: string | null; target_generation: string; scope_id: string;
  fence_authority_epoch: string; recovery_generation: string; affected_work: number;
  state: 'draining' | 'completed'; requested_at: Date; completed_at: Date | null;
};

export type RevocationAffectedWorkRow = {
  revocation_id: string; ordinal: number;
  admission_id: string | null; search_read_lease_id: string | null; download_read_lease_id: string | null;
};

export type RevocationReceiptRow = {
  principal_id: string; idempotency_key: string; request_digest: string;
  revocation_id: string; result_authority_epoch: string; created_at: Date;
};
