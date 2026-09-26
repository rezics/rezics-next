// Row declarations for owner relocation and reconciliation (relay 012-013).
// The SQL migrations remain the DDL owner; bigint/numeric columns are strings.

export const RELOCATION_OWNERS = ['graph', 'content', 'object'] as const;
export const RELOCATION_STATES = ['staged', 'copying', 'draining', 'verifying', 'activated',
  'retaining', 'collected', 'aborted'] as const;

/** `relay.owner_relocation`: one in-flight move per owner dataset. */
export interface OwnerRelocationRow {
  id: string;
  operation_id: string;
  request_digest: string;
  owner: typeof RELOCATION_OWNERS[number];
  dataset_id: string;
  source_location: string;
  target_location: string;
  source_routing_epoch: string;
  target_routing_epoch: string | null;
  /** Verified final source frontier; required with every digest before activation. */
  source_data_epoch: string | null;
  source_sequence: string | null;
  target_data_epoch: string | null;
  anchor_count: string | null;
  anchor_digest: string | null;
  object_count: string | null;
  object_digest: string | null;
  /** Erasure journal epoch whose fences the copy was verified against. */
  erasure_epoch: string | null;
  state: typeof RELOCATION_STATES[number];
  retain_until: Date | null;
  abort_reason: string | null;
  created_at: Date;
  activated_at: Date | null;
  collected_at: Date | null;
}

export const RECONCILIATION_KINDS = ['restore', 'format_upgrade', 'anchor_rebuild',
  'revision_recovery', 'relay_gap', 'consumer_redelivery', 'retention_gc', 'relocation',
  'erasure'] as const;
export const RECONCILIATION_STATES = ['running', 'held', 'reconciled', 'failed'] as const;
export const RECONCILIATION_OWNERS = ['account', 'access', 'content', 'source', 'graph',
  'object', 'relay'] as const;

/** `relay.owner_reconciliation`: one running pass per kind and scope. */
export interface OwnerReconciliationRow {
  id: string;
  operation_id: string;
  request_digest: string;
  kind: typeof RECONCILIATION_KINDS[number];
  scope: string;
  consumer: string | null;
  /** `relay.recovery_coverage_head.generation` compared by this pass. */
  coverage_generation: string | null;
  /** Erasure journal epoch reconciled through. */
  erasure_epoch: string | null;
  relocation_id: string | null;
  erasure_id: string | null;
  format_from: string | null;
  format_to: string | null;
  state: typeof RECONCILIATION_STATES[number];
  hold_reason: string | null;
  outcome_digest: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export const CUT_STATUSES = ['matched', 'behind', 'ahead', 'mismatch', 'missing',
  'format_mismatch'] as const;

/** `relay.owner_reconciliation_cut`: the restored or observed cut of one owner. */
export interface OwnerReconciliationCutRow {
  reconciliation_id: string;
  owner: typeof RECONCILIATION_OWNERS[number];
  data_epoch: string | null;
  sequence: string | null;
  cluster_id: string | null;
  wal_lsn: string | null;
  format_version: string | null;
  coverage_digest: string | null;
  status: typeof CUT_STATUSES[number];
  recorded_at: Date;
}

export const RECONCILIATION_ITEM_KINDS = ['revision', 'anchor', 'payload', 'receipt',
  'outbox_event', 'relay_batch', 'consumer_effect', 'preparation_pin', 'deletion_intent',
  'erasure', 'authority_fence', 'retention_pin'] as const;
/** `unavailable`, `corrupt`, `gap` and `conflict` keep the affected hold. */
export const RECONCILIATION_DISPOSITIONS = ['matched', 'replayed', 'rebuilt', 'unavailable',
  'corrupt', 'newer_unadopted', 'erased', 'gap', 'conflict', 'preserved', 'retired'] as const;

/** `relay.owner_reconciliation_item`: append-only finding for one exact item. */
export interface OwnerReconciliationItemRow {
  reconciliation_id: string;
  ordinal: number;
  owner: typeof RECONCILIATION_OWNERS[number];
  item_kind: typeof RECONCILIATION_ITEM_KINDS[number];
  item_ref: string;
  disposition: typeof RECONCILIATION_DISPOSITIONS[number];
  evidence_digest: string | null;
  recorded_at: Date;
}

export const ownerTables = {
  'relay.owner_relocation': {
    id: true, operation_id: true, request_digest: true, owner: true, dataset_id: true,
    source_location: true, target_location: true, source_routing_epoch: true,
    target_routing_epoch: true, source_data_epoch: true, source_sequence: true,
    target_data_epoch: true, anchor_count: true, anchor_digest: true, object_count: true,
    object_digest: true, erasure_epoch: true, state: true, retain_until: true,
    abort_reason: true, created_at: true, activated_at: true, collected_at: true,
  } satisfies Record<keyof OwnerRelocationRow, true>,
  'relay.owner_reconciliation': {
    id: true, operation_id: true, request_digest: true, kind: true, scope: true,
    consumer: true, coverage_generation: true, erasure_epoch: true, relocation_id: true,
    erasure_id: true, format_from: true, format_to: true, state: true, hold_reason: true,
    outcome_digest: true, created_at: true, completed_at: true,
  } satisfies Record<keyof OwnerReconciliationRow, true>,
  'relay.owner_reconciliation_cut': {
    reconciliation_id: true, owner: true, data_epoch: true, sequence: true, cluster_id: true,
    wal_lsn: true, format_version: true, coverage_digest: true, status: true, recorded_at: true,
  } satisfies Record<keyof OwnerReconciliationCutRow, true>,
  'relay.owner_reconciliation_item': {
    reconciliation_id: true, ordinal: true, owner: true, item_kind: true, item_ref: true,
    disposition: true, evidence_digest: true, recorded_at: true,
  } satisfies Record<keyof OwnerReconciliationItemRow, true>,
} as const;
