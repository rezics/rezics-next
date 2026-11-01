import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions } from '../library/collection-source.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export type IdentitySourceMaintenanceConfig = Readonly<{
  native: NativeStepWork;
  library: WorkDimensions;
}>;

const prefix = 'KERNEL_IDENTITY_SOURCE_MAINTENANCE_';

// Baseline invocation: original Account settlement and two History Source checks.
// This is NOT the allocation for the installed guarded History handoff. Final frame
// adoption also requires initial/repeated Source verification and the sole Library
// producer's exact SQL declaration. Insufficient balances continue to refuse; the
// final composition owner derives the replacement aggregate and hard ceilings.
// Directory planning stays independently capped below.
// No PostgreSQL engine request is dispatched.
const nativeDefaults = {
  ROWS: 577,
  POINTS: 577,
  STATEMENTS: 173,
  BYTES: 630784,
  ENGINE_REQUESTS: 0,
} as const;

/** Keep the original two-child Source planning envelope bounded by remaining frame balance. */
export function identitySourceConsumerDirectoryPlan(allowance: NativeStepWork): Readonly<{
  envelope: NativeStepWork;
  child: NativeStepWork;
}> {
  const envelope = Object.freeze({
    rows: Math.min(100, allowance.rows),
    points: Math.min(200, allowance.points),
    statements: Math.min(36, allowance.statements),
    bytes: Math.min(229376, allowance.bytes),
    engineRequests: Math.min(0, allowance.engineRequests),
  });
  const child = Object.freeze({
    rows: Math.floor(envelope.rows / 2),
    points: Math.floor(envelope.points / 2),
    statements: Math.floor(envelope.statements / 2),
    bytes: Math.floor(envelope.bytes / 2),
    engineRequests: Math.floor(envelope.engineRequests / 2),
  });
  return Object.freeze({ envelope, child });
}

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
