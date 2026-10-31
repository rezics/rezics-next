import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions } from '../library/collection-source.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export type IdentitySourceMaintenanceConfig = Readonly<{
  native: NativeStepWork;
  library: WorkDimensions;
}>;

const prefix = 'KERNEL_IDENTITY_SOURCE_MAINTENANCE_';

// One invocation may read and then verify the native directory. Each child still keeps
// the pre-existing 100-row ceiling. The extra native row/point allowance is the fixed
// Source control cut: original source, accepted claim/job, participant receipts, progress,
// and final source-home rechecks. The binding owner's two released snapshots add thirteen
// native points, ten statements and 16 KiB. Equal directory child ceilings need eighteen
// statements each, including read/verify cleanup. No PostgreSQL engine request is dispatched.
const nativeDefaults = {
  ROWS: 249,
  POINTS: 249,
  STATEMENTS: 81,
  BYTES: 286720,
  ENGINE_REQUESTS: 0,
} as const;

// One private Library effect selection uses the existing one-page bounds. Identity metadata
// is not read by this consumer path; the Source page is limited to one raw effect and keeps
// the established Collection Source SQL/point/byte caps for that child.
const libraryDefaults = {
  CANDIDATE_KEYS: 1,
  IDENTITY_METADATA_ROWS: 0,
  NATIVE_ROWS: 8192,
  NATIVE_POINTS: 128,
  WITNESS_KEYS: 1,
  STATEMENTS: 128,
  BYTES: 1048576,
  EMPTY_SEEKS: 2,
} as const;

function dimension(env: Environment, key: string, fallback: number, maximum: number): number {
  const name = `${prefix}${key}`;
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum || (fallback !== 0 && value === 0))
    throw new TypeError(`Invalid ${name}`);
  return value;
}

/** Parse Source's independent native and Library allocations; no prior request or job funds them. */
export function readIdentitySourceMaintenanceConfig(env: Environment): IdentitySourceMaintenanceConfig {
  return Object.freeze({
    native: Object.freeze({
      rows: dimension(env, 'NATIVE_ROWS', nativeDefaults.ROWS, nativeDefaults.ROWS),
      points: dimension(env, 'NATIVE_POINTS', nativeDefaults.POINTS, nativeDefaults.POINTS),
      statements: dimension(env, 'NATIVE_STATEMENTS', nativeDefaults.STATEMENTS, nativeDefaults.STATEMENTS),
      bytes: dimension(env, 'NATIVE_BYTES', nativeDefaults.BYTES, nativeDefaults.BYTES),
      engineRequests: dimension(env, 'NATIVE_ENGINE_REQUESTS', nativeDefaults.ENGINE_REQUESTS, 0),
    }),
    library: Object.freeze({
      candidateKeys: dimension(env, 'LIBRARY_CANDIDATE_KEYS', libraryDefaults.CANDIDATE_KEYS, 1),
      identityMetadataRows: dimension(env, 'LIBRARY_IDENTITY_METADATA_ROWS', libraryDefaults.IDENTITY_METADATA_ROWS, 0),
      nativeRows: dimension(env, 'LIBRARY_NATIVE_ROWS', libraryDefaults.NATIVE_ROWS, 8192),
      nativePoints: dimension(env, 'LIBRARY_NATIVE_POINTS', libraryDefaults.NATIVE_POINTS, 128),
      witnessKeys: dimension(env, 'LIBRARY_WITNESS_KEYS', libraryDefaults.WITNESS_KEYS, 1),
      statements: dimension(env, 'LIBRARY_STATEMENTS', libraryDefaults.STATEMENTS, 128),
      bytes: dimension(env, 'LIBRARY_BYTES', libraryDefaults.BYTES, 1048576),
      emptySeeks: dimension(env, 'LIBRARY_EMPTY_SEEKS', libraryDefaults.EMPTY_SEEKS, 2),
    }),
  });
}
