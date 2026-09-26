// Row declarations for the erasure journal and per-store retention. The SQL
// migrations (relay 010-011, Content 120) remain the DDL owner; these types
// mirror their columns as node-postgres returns them (bigint/numeric as strings).

/** Workflow track from the erasure runbook; `blocked` needs an explicit reason. */
export const ERASURE_STAGES = ['requested', 'fenced', 'inventory_complete', 'deleting',
  'reconciling', 'verified', 'blocked'] as const;
export const ERASURE_KINDS = ['account', 'resource', 'revision'] as const;
export const ERASURE_AUTHORITIES = ['account_deletion', 'access_admission'] as const;
/** Disclosure suppression and physical destruction are reported separately. */
export const SUPPRESSION_STATUSES = ['pending', 'suppressed'] as const;
export const DESTRUCTION_STATUSES = ['pending', 'in_progress', 'retained', 'destroyed',
  'blocked'] as const;

/** `relay.erasure`: one journal entry per erasure, retained outside restored owners. */
export interface ErasureRow {
  id: string;
  /** Gap-free, commit-ordered; allocate only through `relay.next_erasure_epoch()`. */
  erasure_epoch: string;
  operation_id: string;
  request_digest: string;
  kind: typeof ERASURE_KINDS[number];
  authority: typeof ERASURE_AUTHORITIES[number];
  principal_id: string | null;
  admission_id: string | null;
  authority_epoch: string | null;
  /** Account erasures reference the retained `relay.account_subject_deletion` tombstone. */
  account_issuer: string | null;
  account_subject: string | null;
  /** Optional link to the retained `relay.account_deletion_intent` of the same Account. */
  deleted_principal_id: string | null;
  stage: typeof ERASURE_STAGES[number];
  suppression_status: typeof SUPPRESSION_STATUSES[number];
  destruction_status: typeof DESTRUCTION_STATUSES[number];
  blocked_reason: string | null;
  requested_at: Date;
  suppressed_at: Date | null;
  verified_at: Date | null;
}

/** Each exact target kind belongs to one owner; `relay.erasure_target` enforces the pair. */
export const ERASURE_TARGET_OWNERS = {
  principal: 'access',
  content_revision: 'content',
  content_variant: 'content',
  semantic_revision: 'graph',
  resource: 'graph',
  source_observation: 'source',
  object: 'object',
} as const;
export type ErasureTargetKind = keyof typeof ERASURE_TARGET_OWNERS;

/** `relay.erasure_target`: at most 256 exact references per erasure. */
export interface ErasureTargetRow {
  erasure_id: string;
  ordinal: number;
  owner: typeof ERASURE_TARGET_OWNERS[ErasureTargetKind];
  target_kind: ErasureTargetKind;
  target_ref: string;
}

export const RETENTION_OWNERS = ['account', 'access', 'content', 'source', 'graph', 'object',
  'relay'] as const;
export const RETENTION_STORES = ['postgresql', 'postgresql_wal', 'tdb2', 'tdb2_generation',
  'lucene', 'object_store', 'cache', 'delivery', 'log', 'audit', 'export_artifact'] as const;
/** Backup, archive and retired custody require an expiry or an explicit hold. */
export const RETENTION_CUSTODY = ['live', 'derived', 'backup', 'archive', 'retired'] as const;
export const RETENTION_DOMAIN_STATES = ['active', 'expired', 'destroyed'] as const;

/** `relay.retention_domain`: one copy location with its custody, expiry and hold. */
export interface RetentionDomainRow {
  id: string;
  label: string;
  owner: typeof RETENTION_OWNERS[number];
  store: typeof RETENTION_STORES[number];
  custody: typeof RETENTION_CUSTODY[number];
  expires_at: Date | null;
  hold_reason: string | null;
  state: typeof RETENTION_DOMAIN_STATES[number];
  created_at: Date;
  retired_at: Date | null;
}

export const DISPOSITION_SUPPRESSION = ['not_applicable', 'pending', 'suppressed'] as const;
/** Terminal values need evidence; `retained` needs an expiry or a hold reason. */
export const DISPOSITION_DESTRUCTION = ['pending', 'not_present', 'destroyed', 'sanitized',
  'expired', 'retained', 'blocked'] as const;

/** `relay.erasure_disposition`: per-erasure, per-domain suppression and destruction. */
export interface ErasureDispositionRow {
  erasure_id: string;
  domain_id: string;
  suppression: typeof DISPOSITION_SUPPRESSION[number];
  destruction: typeof DISPOSITION_DESTRUCTION[number];
  retained_until: Date | null;
  reason: string | null;
  evidence_digest: string | null;
  updated_at: Date;
}

/** `relay.recovery_coverage_head` after relay 010; NULL epoch means no journal coverage. */
export interface RecoveryCoverageHeadRow {
  consumer: string;
  coverage_digest: string;
  generation: string;
  captured_at: Date;
  erasure_epoch: string | null;
}

/** Relay 014 points to the latest retained signed head across consumers. */
export interface CurrentAuthorityCoverageRow {
  id: boolean;
  consumer: string;
  coverage_digest: string;
  coverage_generation: string;
  captured_at: Date;
  revision: string;
}

/** `content.revision_erasure`: commits only with the revision's transition to erased. */
export interface ContentRevisionErasureRow {
  revision_id: string;
  erasure_id: string;
  erasure_epoch: string;
  recorded_at: Date;
}

/** `content.publication_erasure_supersession`: historical active pin's exact erasure proof. */
export interface ContentPublicationErasureSupersessionRow {
  operation_id: string;
  revision_id: string;
  erasure_id: string;
  erasure_epoch: string;
  graph_receipt: string;
  graph_data_epoch: string;
  graph_sequence: string;
  recorded_at: Date;
}

export const erasureTables = {
  'relay.erasure': {
    id: true, erasure_epoch: true, operation_id: true, request_digest: true, kind: true,
    authority: true, principal_id: true, admission_id: true, authority_epoch: true,
    account_issuer: true, account_subject: true, deleted_principal_id: true, stage: true,
    suppression_status: true, destruction_status: true, blocked_reason: true,
    requested_at: true, suppressed_at: true, verified_at: true,
  } satisfies Record<keyof ErasureRow, true>,
  'relay.erasure_target': {
    erasure_id: true, ordinal: true, owner: true, target_kind: true, target_ref: true,
  } satisfies Record<keyof ErasureTargetRow, true>,
  'relay.retention_domain': {
    id: true, label: true, owner: true, store: true, custody: true, expires_at: true,
    hold_reason: true, state: true, created_at: true, retired_at: true,
  } satisfies Record<keyof RetentionDomainRow, true>,
  'relay.erasure_disposition': {
    erasure_id: true, domain_id: true, suppression: true, destruction: true,
    retained_until: true, reason: true, evidence_digest: true, updated_at: true,
  } satisfies Record<keyof ErasureDispositionRow, true>,
  'relay.recovery_coverage_head': {
    consumer: true, coverage_digest: true, generation: true, captured_at: true,
    erasure_epoch: true,
  } satisfies Record<keyof RecoveryCoverageHeadRow, true>,
  'relay.current_authority_coverage': {
    id: true, consumer: true, coverage_digest: true, coverage_generation: true,
    captured_at: true, revision: true,
  } satisfies Record<keyof CurrentAuthorityCoverageRow, true>,
} as const;

export const contentErasureTables = {
  'content.revision_erasure': {
    revision_id: true, erasure_id: true, erasure_epoch: true, recorded_at: true,
  } satisfies Record<keyof ContentRevisionErasureRow, true>,
  'content.publication_erasure_supersession': {
    operation_id: true, revision_id: true, erasure_id: true, erasure_epoch: true,
    graph_receipt: true, graph_data_epoch: true, graph_sequence: true, recorded_at: true,
  } satisfies Record<keyof ContentPublicationErasureSupersessionRow, true>,
} as const;
