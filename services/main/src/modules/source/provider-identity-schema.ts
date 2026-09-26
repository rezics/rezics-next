// Row types for Content migration 044. A provider redirect/merge is source evidence;
// it proposes, never performs, a native identity correction or grant transfer.

export interface RecordIdentityChangeRow {
  id: string;
  principal_id: string;
  kind: 'redirect' | 'merge';
  from_record_id: string;
  to_record_id: string;
  observation_id: string;
  created_at: Date;
}

export interface IdentityCorrectionProposalRow {
  id: string;
  principal_id: string;
  change_id: string;
  from_target: string;
  to_target: string;
  effect: 'proposal-only';
  idempotency_key: string;
  request_digest: string;
  created_at: Date;
}
