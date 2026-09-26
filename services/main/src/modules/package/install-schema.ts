import type { Columns, Sha256Hex } from './lock-schema.ts';

/**
 * Row types for installation generations, plans, inventory and the recovery
 * journal (`services/content/migrations/053_*`). SQL remains the DDL owner.
 */
type GenerationState = 'planned' | 'fetching' | 'verified' | 'staged' | 'activating'
  | 'active' | 'superseded' | 'rejected' | 'failed';

type GenerationTerminalReason = 'path-traversal' | 'ownership-collision' | 'unapproved-hook'
  | 'artifact-unverified' | 'artifact-revoked' | 'authority-revoked' | 'stale-generation'
  | 'cancelled' | 'step-failed';

export interface InstallationRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: Sha256Hex;
  target_key: string;
  environment: Record<string, unknown>;
  state: 'present' | 'removed';
  active_generation_id: string | null;
  /** Environment generation CAS; every head update advances it by one. */
  head_epoch: string;
  created_at: Date;
  updated_at: Date;
}

export interface InstallationGenerationRow {
  id: string;
  installation_id: string;
  principal_id: string;
  number: number;
  idempotency_key: string;
  request_digest: Sha256Hex;
  operation: 'install' | 'update' | 'rollback' | 'remove';
  lock_id: string | null;
  expected_prior_generation_id: string | null;
  rollback_of_generation_id: string | null;
  plan_sha256: Sha256Hex;
  state: GenerationState;
  terminal_reason: GenerationTerminalReason | null;
  /** Access admission that authorized the activation; required from `activating`. */
  activation_admission_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface InstallationStepRow {
  generation_id: string;
  ordinal: number;
  action: 'fetch' | 'verify' | 'unpack' | 'build' | 'configure' | 'register' | 'switch' | 'remove';
  step_key: string;
  lock_id: string | null;
  artifact_ordinal: number | null;
  executes_code: boolean;
  idempotent: boolean;
  hook_approval_id: string | null;
  executor_profile: string | null;
  capabilities: unknown[];
  compensation: 'none' | 'discard-staging' | 'restore-prior-generation' | 'inspect-effect';
}

export interface InstallationArtifactRow {
  generation_id: string;
  lock_id: string;
  artifact_ordinal: number;
  artifact_id: string;
  artifact_sha256: Sha256Hex;
}

export interface InstallationPathRow {
  generation_id: string;
  path: string;
  collision_key: string;
  kind: 'file' | 'directory' | 'symlink';
  ownership: 'installation' | 'user-data';
  step_ordinal: number;
  content_sha256: Sha256Hex | null;
  symlink_target: string | null;
}

export interface InstallationPathClaimRow {
  target_key: string;
  collision_key: string;
  installation_id: string;
  path: string;
  ownership: 'installation' | 'user-data';
  claimed_at: Date;
}

export interface InstallationJournalRow {
  generation_id: string;
  sequence: number;
  step_ordinal: number;
  event: 'intent' | 'completed' | 'failed' | 'compensated' | 'reconciled' | 'cancelled';
  effect: 'none' | 'partial' | 'complete' | 'unknown';
  evidence: Record<string, unknown>;
  created_at: Date;
}

export const packageInstallationTables = {
  'pkg.installation': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true, target_key: true,
    environment: true, state: true, active_generation_id: true, head_epoch: true,
    created_at: true, updated_at: true,
  } satisfies Columns<InstallationRow>,
  'pkg.installation_generation': {
    id: true, installation_id: true, principal_id: true, number: true, idempotency_key: true,
    request_digest: true, operation: true, lock_id: true, expected_prior_generation_id: true,
    rollback_of_generation_id: true, plan_sha256: true, state: true, terminal_reason: true,
    activation_admission_id: true, created_at: true, updated_at: true,
  } satisfies Columns<InstallationGenerationRow>,
  'pkg.installation_step': {
    generation_id: true, ordinal: true, action: true, step_key: true, lock_id: true,
    artifact_ordinal: true, executes_code: true, idempotent: true, hook_approval_id: true,
    executor_profile: true, capabilities: true, compensation: true,
  } satisfies Columns<InstallationStepRow>,
  'pkg.installation_artifact': {
    generation_id: true, lock_id: true, artifact_ordinal: true, artifact_id: true,
    artifact_sha256: true,
  } satisfies Columns<InstallationArtifactRow>,
  'pkg.installation_path': {
    generation_id: true, path: true, collision_key: true, kind: true, ownership: true,
    step_ordinal: true, content_sha256: true, symlink_target: true,
  } satisfies Columns<InstallationPathRow>,
  'pkg.installation_path_claim': {
    target_key: true, collision_key: true, installation_id: true, path: true, ownership: true,
    claimed_at: true,
  } satisfies Columns<InstallationPathClaimRow>,
  'pkg.installation_journal': {
    generation_id: true, sequence: true, step_ordinal: true, event: true, effect: true,
    evidence: true, created_at: true,
  } satisfies Columns<InstallationJournalRow>,
} as const;
