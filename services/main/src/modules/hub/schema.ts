import type { Columns, Sha256Hex } from '../package/lock-schema.ts';

/**
 * Row types for Hub typing of Content revisions (`services/content/migrations/051_*`).
 * Skill and Prompt revisions are `content.revision` rows; these tables add
 * their kind, file inventory, declared requirements and import receipts.
 */
type HubKind = 'skill-package' | 'prompt';

export interface HubVariantProfileRow {
  variant_id: string;
  kind: HubKind;
  created_at: Date;
}

export interface HubRevisionRow {
  revision_id: string;
  variant_id: string;
  kind: HubKind;
  /** Equals `content.revision.model`, e.g. `rezics-skill-package-v1` or `rezics-prompt-v1`. */
  body_model: string;
  applicability: Record<string, unknown>;
  parameter_schema_sha256: Sha256Hex | null;
  parameter_schema_dialect: 'https://json-schema.org/draft/2020-12/schema' | null;
  file_count: number;
  requirement_count: number;
  created_at: Date;
}

export interface HubRevisionFileRow {
  revision_id: string;
  kind: 'skill-package';
  path: string;
  file_id: string;
  role: 'manifest' | 'script' | 'reference' | 'asset' | 'other';
  artifact_id: string;
  sha256: Sha256Hex;
  mode_executable: boolean;
}

export interface HubRevisionRequirementRow {
  revision_id: string;
  ordinal: number;
  kind: 'skill-package';
  ecosystem: string;
  native_selector: string;
  target: Record<string, unknown>;
  strength: 'required' | 'optional';
  declaration: 'declared' | 'missing' | 'unsupported';
  source_path: string;
  source_pointer: string;
}

export interface HubImportRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: Sha256Hex;
  source_format: 'agent-skills-directory-v1' | 'repository-package-v1';
  source_tree_sha256: Sha256Hex;
  source_locator: Record<string, unknown>;
  ingest_profile: 'inert-ingest-v1';
  outcome: 'imported' | 'rejected';
  content_operation_id: string | null;
  revision_id: string | null;
  rejection: Record<string, unknown> | null;
  residuals: unknown[];
  unsupported: unknown[];
  created_at: Date;
}

export const hubTables = {
  'hub.variant_profile': {
    variant_id: true, kind: true, created_at: true,
  } satisfies Columns<HubVariantProfileRow>,
  'hub.revision': {
    revision_id: true, variant_id: true, kind: true, body_model: true, applicability: true,
    parameter_schema_sha256: true, parameter_schema_dialect: true, file_count: true,
    requirement_count: true, created_at: true,
  } satisfies Columns<HubRevisionRow>,
  'hub.revision_file': {
    revision_id: true, kind: true, path: true, file_id: true, role: true, artifact_id: true,
    sha256: true, mode_executable: true,
  } satisfies Columns<HubRevisionFileRow>,
  'hub.revision_requirement': {
    revision_id: true, ordinal: true, kind: true, ecosystem: true, native_selector: true,
    target: true, strength: true, declaration: true, source_path: true, source_pointer: true,
  } satisfies Columns<HubRevisionRequirementRow>,
  'hub.import': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true,
    source_format: true, source_tree_sha256: true, source_locator: true, ingest_profile: true,
    outcome: true, content_operation_id: true, revision_id: true, rejection: true,
    residuals: true, unsupported: true, created_at: true,
  } satisfies Columns<HubImportRow>,
} as const;
