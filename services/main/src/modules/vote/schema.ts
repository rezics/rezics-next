/**
 * Governance vote owner schema (GOV11-GOV23). Jena owns charters, electorate
 * snapshots, source entitlements, allocation plans, openings, proxy routes,
 * ballot revisions, mandate approvals and resolutions through the
 * `model/definitions/{charter,poll,ballot}-*-v1.ts` profiles. Access migrations
 * 070-073 own the private state below: voting mandates (ordinary
 * `access.representation` rows), the holder's protected representative policy
 * and one immutable proof per admitted vote command. The SQL files remain the
 * DDL owner; these are the typed row shapes that adapters read and write.
 */

/** Graph profiles owned by this module, in command-dependency order. */
export const voteGraphProfiles = [
  'charter-revision-v1', 'poll-snapshot-v1', 'poll-allocation-v1', 'ballot-proxy-v1',
  'ballot-mandate-approval-v1', 'ballot-v1', 'poll-resolution-v1',
] as const;

/** A voting mandate is a representation with this action; it never carries weight. */
export const votingMandateAction = 'governance.ballot.operate';

export const voteOperationAction = {
  'ballot.cast': 'governance.ballot.operate',
  'ballot.withdraw': 'governance.ballot.operate',
  'ballot.approve': 'governance.ballot.operate',
  'allocation.activate': 'governance.seat.manage',
  'holder-charter.set': 'governance.seat.manage',
  'proxy.designate': 'governance.seat.manage',
  'proxy.revoke': 'governance.seat.manage',
  'ballot.invalidate': 'governance.ballot.invalidate',
  'poll.prepare': 'governance.poll.administer',
  'poll.open': 'governance.poll.administer',
  'poll.close': 'governance.poll.administer',
  'resolution.finalize': 'governance.poll.administer',
} as const;
export type VoteOperation = keyof typeof voteOperationAction;
type VoteAuthorityPath = 'holder-mandate' | 'proxy-mandate' | 'body-grant';
type RepresentativeRole = 'designated' | 'backup' | 'approver';

const pollIri = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The Access scope gate that fences every admission for one poll. */
export function pollScopeId(poll: string): string {
  const id = pollIri.exec(poll)?.[1];
  if (!id) throw new Error('poll must be a canonical REZICS UUID IRI');
  return `vote:poll:${id}`;
}

/** PostgreSQL bigint columns are read as decimal strings. */
type Int8 = string;

export interface VoteRepresentativePolicyRow {
  id: string;
  holder_subject: string;
  body_subject: string;
  head_revision: Int8;
  created_at: Date;
}

export interface VoteRepresentativePolicyRevisionRow {
  policy_id: string;
  revision: Int8;
  holder_charter_revision: string;
  holder_charter_digest: string;
  authority_epoch: Int8;
  created_at: Date;
}

export interface VoteRepresentativePolicyMemberRow {
  policy_id: string;
  revision: Int8;
  role: RepresentativeRole;
  representation_id: string;
  representation_generation: Int8;
  principal_id: string;
}

export interface VoteRepresentativePolicyReceiptRow {
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  policy_id: string;
  revision: Int8;
  authority_proof: Record<string, unknown>;
  result_authority_epoch: Int8;
  created_at: Date;
}

export interface VoteAdmissionRow {
  admission_id: string;
  operation: VoteOperation;
  poll: string;
  body_subject: string;
  holder_subject: string | null;
  proxy_subject: string | null;
  seat: string | null;
  source_entitlement: string | null;
  authority_path: VoteAuthorityPath;
  representation_id: string;
  representation_generation: Int8;
  grant_id: string | null;
  grant_generation: Int8 | null;
  policy_id: string | null;
  policy_revision: Int8 | null;
  principal_epoch: Int8;
  acting_subject_generation: Int8;
  candidate_digest: string;
  expected_head: string | null;
  created_at: Date;
}

/** Exact column sets; the migration test compares them with the installed DDL. */
export const voteAccessTables = {
  vote_representative_policy: {
    id: true, holder_subject: true, body_subject: true, head_revision: true, created_at: true,
  } satisfies Record<keyof VoteRepresentativePolicyRow, true>,
  vote_representative_policy_revision: {
    policy_id: true, revision: true, holder_charter_revision: true, holder_charter_digest: true,
    authority_epoch: true, created_at: true,
  } satisfies Record<keyof VoteRepresentativePolicyRevisionRow, true>,
  vote_representative_policy_member: {
    policy_id: true, revision: true, role: true, representation_id: true,
    representation_generation: true, principal_id: true,
  } satisfies Record<keyof VoteRepresentativePolicyMemberRow, true>,
  vote_representative_policy_receipt: {
    principal_id: true, idempotency_key: true, request_digest: true, policy_id: true, revision: true,
    authority_proof: true, result_authority_epoch: true, created_at: true,
  } satisfies Record<keyof VoteRepresentativePolicyReceiptRow, true>,
  vote_admission: {
    admission_id: true, operation: true, poll: true, body_subject: true, holder_subject: true,
    proxy_subject: true, seat: true, source_entitlement: true, authority_path: true,
    representation_id: true, representation_generation: true, grant_id: true, grant_generation: true,
    policy_id: true, policy_revision: true, principal_epoch: true, acting_subject_generation: true,
    candidate_digest: true, expected_head: true, created_at: true,
  } satisfies Record<keyof VoteAdmissionRow, true>,
} as const;
