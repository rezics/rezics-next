/**
 * Row types for the artifact store and exact lock owner tables
 * (`services/content/migrations/050_*`, `052_*`). SQL remains the DDL owner;
 * each column set is compared with the live table by the schema test.
 */
export type Columns<Row> = { readonly [K in keyof Row]-?: true };

export type Sha256Hex = string;

export interface ArtifactRow {
  id: string;
  retention_domain: 'public-origin' | 'principal-private';
  owner_principal_id: string | null;
  sha256: Sha256Hex;
  /** int8 arrives from pg as a decimal string. */
  byte_length: string;
  media_type: string;
  /** `package/artifact/public/sha256/<sha256>` or `package/artifact/private/<principal>/sha256/<sha256>`. */
  object_key: string;
  state: 'quarantined' | 'verified' | 'rejected' | 'erased';
  created_at: Date;
  settled_at: Date | null;
}

export interface ArtifactRevocationRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  sha256: Sha256Hex;
  reason: 'malicious' | 'integrity' | 'rights' | 'provider-withdrawn' | 'policy';
  basis: Record<string, unknown>;
  created_at: Date;
}

export interface LockRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: Sha256Hex;
  contract_version: 'rezics-package-lock-v1';
  /** Canonical UTF-8 JSON; `lock_sha256` is its SHA-256 and `manifest` its parse. */
  canonical_bytes: Buffer;
  lock_sha256: Sha256Hex;
  manifest: Record<string, unknown>;
  subject_revision_id: string | null;
  subject_kind: 'skill-package' | null;
  segment_count: number;
  artifact_count: number;
  created_at: Date;
}

type LockEcosystem = 'go' | 'cargo' | 'npm';

export interface LockSegmentRow {
  lock_id: string;
  ordinal: number;
  principal_id: string;
  ecosystem: LockEcosystem;
  adapter_profile: string;
  scope_kind: 'process' | 'path' | 'abi';
  scope_label: string;
  go_resolution_id: string | null;
  cargo_resolution_id: string | null;
  npm_resolution_id: string | null;
}

export interface LockArtifactRow {
  lock_id: string;
  ordinal: number;
  segment_ordinal: number;
  ecosystem: LockEcosystem;
  instance_key: string;
  coordinate: Record<string, unknown>;
  locator: string;
  mutable_reference: string | null;
  integrity_basis: 'registry-digest' | 'observed-bytes' | 'unverifiable';
  digest_algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' | 'go-h1' | null;
  /** Lowercase hex for SHA digests; `h1:<base64>` for Go. */
  digest_value: string | null;
  artifact_id: string | null;
  artifact_sha256: Sha256Hex | null;
}

export interface LockRequirementRow {
  lock_id: string;
  subject_revision_id: string;
  requirement_ordinal: number;
  ecosystem: LockEcosystem;
  segment_ordinal: number;
}

export interface LockReplayRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: Sha256Hex;
  lock_id: string;
  lock_sha256: Sha256Hex;
  policy: 'exact-artifact-replay-v1';
  outcome: 'verified' | 'unavailable';
  created_at: Date;
}

export interface LockReplayArtifactRow {
  replay_id: string;
  lock_id: string;
  artifact_ordinal: number;
  result: 'verified' | 'digest-mismatch' | 'unavailable' | 'revoked' | 'unverifiable';
  observed_sha256: Sha256Hex | null;
  observed_byte_length: string | null;
  artifact_id: string | null;
  artifact_sha256: Sha256Hex | null;
}

export const packageLockTables = {
  'pkg.artifact': {
    id: true, retention_domain: true, owner_principal_id: true, sha256: true, byte_length: true,
    media_type: true, object_key: true, state: true, created_at: true, settled_at: true,
  } satisfies Columns<ArtifactRow>,
  'pkg.artifact_revocation': {
    id: true, principal_id: true, idempotency_key: true, sha256: true, reason: true, basis: true,
    created_at: true,
  } satisfies Columns<ArtifactRevocationRow>,
  'pkg.lock': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true,
    contract_version: true, canonical_bytes: true, lock_sha256: true, manifest: true,
    subject_revision_id: true, subject_kind: true, segment_count: true, artifact_count: true,
    created_at: true,
  } satisfies Columns<LockRow>,
  'pkg.lock_segment': {
    lock_id: true, ordinal: true, principal_id: true, ecosystem: true, adapter_profile: true,
    scope_kind: true, scope_label: true, go_resolution_id: true, cargo_resolution_id: true,
    npm_resolution_id: true,
  } satisfies Columns<LockSegmentRow>,
  'pkg.lock_artifact': {
    lock_id: true, ordinal: true, segment_ordinal: true, ecosystem: true, instance_key: true,
    coordinate: true, locator: true, mutable_reference: true, integrity_basis: true,
    digest_algorithm: true, digest_value: true, artifact_id: true, artifact_sha256: true,
  } satisfies Columns<LockArtifactRow>,
  'pkg.lock_requirement': {
    lock_id: true, subject_revision_id: true, requirement_ordinal: true, ecosystem: true,
    segment_ordinal: true,
  } satisfies Columns<LockRequirementRow>,
  'pkg.lock_replay': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true, lock_id: true,
    lock_sha256: true, policy: true, outcome: true, created_at: true,
  } satisfies Columns<LockReplayRow>,
  'pkg.lock_replay_artifact': {
    replay_id: true, lock_id: true, artifact_ordinal: true, result: true, observed_sha256: true,
    observed_byte_length: true, artifact_id: true, artifact_sha256: true,
  } satisfies Columns<LockReplayArtifactRow>,
} as const;

/** Object key for artifact bytes in Main's configured RustFS bucket. */
export function artifactObjectKey(sha256: Sha256Hex, ownerPrincipalId: string | null): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('artifact digest must be lowercase SHA-256 hex');
  return ownerPrincipalId === null
    ? `package/artifact/public/sha256/${sha256}`
    : `package/artifact/private/${ownerPrincipalId}/sha256/${sha256}`;
}

/** Key-sorted JSON: the canonical encoding for lock bytes and intent digests. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
