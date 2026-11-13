import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import type { Actor } from '../request/access.ts';
import type { ContentCommandDependencies } from './commands.ts';
import type { RequestContext } from './model.ts';
import type { ContentReadDependencies } from './reads.ts';

/** Exact selected source. Digest is lowercase SHA-256 hex of canonical bytes. */
export type RevisionDisclosureTarget = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;

/** Intended Book catalogue. Catalogue home may differ from the source home. */
export type RevisionDisclosureCatalogue = Readonly<{
  catalogueId: string;
  catalogueRoute: number;
}>;

/** Source incarnation at issue time. A replaced post identity fails currentness. */
export type RevisionDisclosureIncarnation = Readonly<{
  postTransactionId: string;
  threadTransactionId: string;
  postSecurityRevision: string;
  threadSecurityRevision: string;
}>;

export const REVISION_DISCLOSURE_AUDIENCE = 'book-publication' as const;
export const REVISION_DISCLOSURE_POLICY_VERSION = '1' as const;
export const REVISION_DISCLOSURE_ISSUE = 'content.revision-disclosure.issue';
export const REVISION_DISCLOSURE_REVOKE = 'content.revision-disclosure.revoke';
export const REVISION_DISCLOSURE_ERASURE_PAGE = 50;
export type RevisionDisclosureAudience = typeof REVISION_DISCLOSURE_AUDIENCE;
export type RevisionDisclosurePolicyVersion = typeof REVISION_DISCLOSURE_POLICY_VERSION;
export type RevisionDisclosureState = 'issued' | 'revoked';

export type RevisionDisclosureSource = RevisionDisclosureTarget &
  Readonly<{
    licence: string;
    creatorAccountId: string;
    incarnation: RevisionDisclosureIncarnation;
  }>;

export type RevisionDisclosureIssueInput = Readonly<{
  catalogueId: string;
  target: RevisionDisclosureTarget;
}>;

export type RevisionDisclosureRevokeInput = Readonly<{
  disclosureId: string;
}>;

export type RevisionDisclosureCommandContext = RequestContext;

export type RevisionDisclosureCommandValue = Readonly<{
  disclosureId: string;
  state: RevisionDisclosureState;
  catalogueId: string;
  reused: boolean;
  durableInitiator?: string;
}>;

export type RevisionDisclosureObservation = Readonly<{
  disclosureId: string;
  state: RevisionDisclosureState;
  catalogue: RevisionDisclosureCatalogue;
  target: RevisionDisclosureTarget;
  licence: string;
  incarnation: RevisionDisclosureIncarnation;
  issuerAccountId: string;
  issuedAt: string;
  audienceKind: RevisionDisclosureAudience;
  policyVersion: RevisionDisclosurePolicyVersion;
  revokedAt: string | null;
}>;

/** Book-owned membership facts. Callers cannot write this proof. */
export type RevisionDisclosureMembership = Readonly<{
  catalogueId: string;
  publicationId: string;
  occurrenceId: string;
  sourceRevisionId: string;
}>;

/**
 * Reader-side seam for a later Book owner. Membership is proved internally by
 * Book; this object is never accepted as a writable request field.
 */
export type RevisionDisclosureReaderIntent = Readonly<{
  disclosureId: string;
  target: RevisionDisclosureTarget;
  catalogueId: string;
  membership: RevisionDisclosureMembership;
}>;

/** Consent observation plus Book membership, still not a byte grant. */
export type RevisionDisclosureReaderGate = Readonly<{
  observation: RevisionDisclosureObservation;
  membership: RevisionDisclosureMembership;
}>;

export type RevisionDisclosureErasureLocator = Readonly<{
  kind: 'post' | 'thread';
  id: string;
}>;

export type RevisionDisclosureErasureItem = Readonly<{
  disclosureId: string;
  threadId: string;
  postId: string;
  revisionId: string;
  catalogueId: string;
  revoked: boolean;
}>;

export type RevisionDisclosureErasurePage = Readonly<{
  items: readonly RevisionDisclosureErasureItem[];
  next: string | null;
}>;

export type RevisionDisclosureErasureContext = Readonly<{
  deadline: number;
  afterDisclosureId?: string | null;
  limit?: number;
}>;

export type RevisionDisclosureLookupInput = Readonly<{
  catalogueId: string;
  target: RevisionDisclosureTarget;
}>;

export type RevisionDisclosureDependencies = ContentCommandDependencies;
export type RevisionDisclosureReadDependencies = Pick<ContentReadDependencies, 'pool' | 'access' | 'clock'>;

export type RevisionDisclosureActor = Extract<Actor, { kind: 'account' }>;

export type RevisionDisclosureInitiatorCapture = Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'>;

export type RevisionDisclosureRow = Readonly<{
  route: number;
  disclosure_id: string;
  operation_id: string;
  thread_id: string;
  post_id: string;
  revision_id: string;
  sha256: string;
  licence: string;
  catalogue_id: string;
  catalogue_route: number;
  source_post_transaction_id: string;
  source_thread_transaction_id: string;
  source_post_security_revision: string;
  source_thread_security_revision: string;
  issuer_account_id: string;
  issued_transaction_id: string;
  issued_at: string;
  audience_kind: string;
  policy_version: string;
  actor_client_id: string;
  actor_scopes: string[];
  actor_requested_by: string | null;
  actor_authn_epoch: string;
  original_minimum_authn_epoch: string;
  original_operator_account_id: string | null;
  original_delegation_transaction_id: string | null;
  original_delegation_issued_valid: string | null;
  source_digest: string;
  creation_idempotency_key: string;
  creation_request_digest: string;
  revoked_at: string | null;
  revocation_transaction_id: string | null;
  revoker_account_id: string | null;
}>;

export type RevisionDisclosureSourceRow = Readonly<{
  thread_id: string;
  post_id: string;
  revision_id: string;
  sha256: string;
  licence: string;
  creator_account_id: string;
  post_visibility: string;
  thread_visibility: string;
  post_availability: string;
  thread_availability: string;
  revision_availability: string;
  source_post_transaction_id: string;
  source_thread_transaction_id: string;
  source_post_security_revision: string;
  source_thread_security_revision: string;
  author_erased: boolean;
  reply_to_post_id: string | null;
  first_post_id: string;
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRevisionDisclosureDigest(value: string): boolean {
  return SHA256.test(value);
}

export function isRevisionDisclosureUuid(value: string): boolean {
  return UUID.test(value);
}

export function revisionDisclosureState(row: Pick<RevisionDisclosureRow, 'revoked_at'>): RevisionDisclosureState {
  return row.revoked_at === null ? 'issued' : 'revoked';
}

/** Public sources keep Access public eligibility and need no consent row. */
export function revisionDisclosureRequiredFor(visibility: string): boolean {
  return visibility === 'draft';
}
