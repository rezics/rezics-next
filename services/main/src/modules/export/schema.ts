// Row declarations for the export owner in the Content database (Content 121).
// The SQL migration remains the DDL owner; numeric columns are strings.

export const EXPORT_USE_SCOPES = ['full', 'excerpt', 'quotation', 'evaluation'] as const;
export const EXPORT_STATES = ['staged', 'sealed', 'rejected'] as const;
export const EXPORT_COMPLETENESS = ['complete', 'partial'] as const;
/** Derived only from member rights bases; `blocked` cannot seal. */
export const EXPORT_LICENSE_SCOPES = ['determined', 'uncertain', 'blocked'] as const;

/** `export.manifest`: one idempotent export per principal and key. */
export interface ExportManifestRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  admission_id: string;
  /** Access authority epoch that fixed the export's disclosure. */
  authority_epoch: string;
  target_profile: string;
  use_scope: typeof EXPORT_USE_SCOPES[number];
  state: typeof EXPORT_STATES[number];
  completeness: typeof EXPORT_COMPLETENESS[number] | null;
  license_scope: typeof EXPORT_LICENSE_SCOPES[number] | null;
  license_expression: string | null;
  member_count: number;
  residual_count: number;
  manifest_digest: string | null;
  /** Content receipt position of a newly sealed export; legacy staged rows have nulls. */
  data_epoch: string | null;
  sequence: string | null;
  payload: Record<string, unknown> | null;
  rejection_reason: string | null;
  created_at: Date;
  sealed_at: Date | null;
}

export const EXPORT_SOURCE_OWNERS = ['content', 'graph', 'source', 'object'] as const;
/** Distinct grains stay distinct (I14); a target without the grain is `unmapped`. */
export const EXPORT_SOURCE_GRAINS = ['work', 'main_version', 'external_release', 'edition',
  'carrier', 'artifact', 'contribution', 'occurrence', 'agent', 'claim', 'evidence',
  'assessment', 'method', 'policy', 'context', 'definition', 'structure_revision',
  'content_revision', 'source_observation', 'value'] as const;
export const EXPORT_MAPPINGS = ['exact', 'narrower', 'broader', 'split', 'unmapped'] as const;

/** `export.member`: one exact pinned input at its own owner position. */
export interface ExportMemberRow {
  manifest_id: string;
  ordinal: number;
  source_owner: typeof EXPORT_SOURCE_OWNERS[number];
  /** Provenance: the native dataset or external source the member comes from. */
  source_namespace: string;
  source_grain: typeof EXPORT_SOURCE_GRAINS[number];
  exact_ref: string;
  /** Local pin for Content-owned members; equals `exact_ref`. */
  content_revision_id: string | null;
  ref_digest: string;
  owner_data_epoch: string;
  owner_sequence: string;
  /** Exact position inside a fixed source structure, when the member has one. */
  source_position: string | null;
  target_grain: string | null;
  mapping: typeof EXPORT_MAPPINGS[number];
}

export const EXPORT_RESIDUAL_KINDS = ['unmapped_grain', 'unsupported_scope', 'precision_loss',
  'language_loss', 'unknown_value', 'qualified_claim', 'context_scope', 'private_dependency',
  'erased', 'unavailable', 'rights_excluded', 'missing_member'] as const;

/** `export.residual`: one explicit loss; withheld inputs have no member ordinal.
 * Qualified claims, local Context meanings and private dependencies must remain
 * residual when the target profile cannot express them without changing meaning. */
export interface ExportResidualRow {
  manifest_id: string;
  ordinal: number;
  member_ordinal: number | null;
  kind: typeof EXPORT_RESIDUAL_KINDS[number];
  path: string | null;
  detail: Record<string, unknown>;
}

export const EXPORT_BASIS_KINDS = ['license_offering', 'use_assessment', 'public_domain',
  'unprotected_fact', 'statutory_exception', 'native_contribution'] as const;
export const EXPORT_OBLIGATIONS = ['attribution', 'share_alike', 'non_commercial',
  'no_derivatives', 'notice_retention', 'access_restriction'] as const;

/** `export.rights_basis`: a basis evaluated for this manifest's use scope only. */
export interface ExportRightsBasisRow {
  manifest_id: string;
  ordinal: number;
  basis_kind: typeof EXPORT_BASIS_KINDS[number];
  /** Exact rights record revision (offering, use assessment, exception or contribution). */
  basis_ref: string | null;
  license_expression: string | null;
  notice: string | null;
  obligations: Array<typeof EXPORT_OBLIGATIONS[number]>;
}

/** `export.member_basis`: which bases cover which exported member. */
export interface ExportMemberBasisRow {
  manifest_id: string;
  member_ordinal: number;
  basis_ordinal: number;
}

export const exportTables = {
  'export.manifest': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true,
    admission_id: true, authority_epoch: true, target_profile: true, use_scope: true,
    state: true, completeness: true, license_scope: true, license_expression: true,
    member_count: true, residual_count: true, manifest_digest: true, rejection_reason: true,
    data_epoch: true, sequence: true, payload: true, created_at: true, sealed_at: true,
  } satisfies Record<keyof ExportManifestRow, true>,
  'export.member': {
    manifest_id: true, ordinal: true, source_owner: true, source_namespace: true,
    source_grain: true, exact_ref: true, content_revision_id: true, ref_digest: true,
    owner_data_epoch: true, owner_sequence: true, source_position: true, target_grain: true,
    mapping: true,
  } satisfies Record<keyof ExportMemberRow, true>,
  'export.residual': {
    manifest_id: true, ordinal: true, member_ordinal: true, kind: true, path: true, detail: true,
  } satisfies Record<keyof ExportResidualRow, true>,
  'export.rights_basis': {
    manifest_id: true, ordinal: true, basis_kind: true, basis_ref: true,
    license_expression: true, notice: true, obligations: true,
  } satisfies Record<keyof ExportRightsBasisRow, true>,
  'export.member_basis': {
    manifest_id: true, member_ordinal: true, basis_ordinal: true,
  } satisfies Record<keyof ExportMemberBasisRow, true>,
} as const;
