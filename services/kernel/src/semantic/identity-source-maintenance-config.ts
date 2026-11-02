import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions } from '../library/collection-source.ts';

type Environment = Readonly<Record<string, string | undefined>>;

/** Executed by the private Source receiver, rather than inferred from page size.
 * An exhausted-page recheck is the second verifier inside the Source fence; it is
 * not a Library finishScope/finalFence. Planning belongs to the Library participant.
 */
export const IDENTITY_SOURCE_ORIGINAL_SCHEDULE = Object.freeze({
  custodyAdvancements: 1,
  directoryPages: 1,
  source: Object.freeze({
    retainedDiscovery: 1,
    original: 1,
    acceptedBinding: 1,
    published: 2,
    participantReconcile: 3,
    prepare: 1,
    retainedFallback: 1,
    progress: 1,
    directory: 1,
    directoryRecheck: 1,
    scopeAdmission: 1,
    receivingSelection: 1,
    receivingReconcile: 1,
    receivingCommand: 1,
    checkpoint: 1,
    finish: 1,
    terminalVerify: 1,
    historyAuthority: 1,
    historyHandoff: 1,
  }),
  library: Object.freeze({
    discovery: 0,
    plannerSteps: 0,
    effectPages: 1,
    currentVerifications: 1,
    exhaustedPageRechecks: 1,
    finalFences: 0,
  }),
});
export type IdentitySourceLibraryOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.library;
export type IdentitySourceScheduledOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source;

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

/** Parse ceilings for independent Source work. These are never additive original
 * funding: the selected History route requires Accounts' private prepaid partition. */
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

/** Arithmetic for owner adoption only. This result cannot admit a Source callback,
 * authenticate an original, increase a child ceiling or create a private grant. */
export function composeIdentitySourceOriginalCosts(
  parts: Readonly<{
    accountsLocalControl: WorkDimensions | null;
    sourceHistoryNativeAllReachedCalls: WorkDimensions | null;
    libraryAllReachedCalls: WorkDimensions | null;
    additionalOriginalTransferControl: WorkDimensions | null;
  }>,
): Readonly<{ missing: readonly string[]; total: WorkDimensions | null }> {
  const axes = [
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
  ] as const;
  const total = Object.fromEntries(axes.map((axis) => [axis, 0])) as Record<keyof WorkDimensions, number>;
  const missing: string[] = [];
  for (const name of [
    'accountsLocalControl',
    'sourceHistoryNativeAllReachedCalls',
    'libraryAllReachedCalls',
    'additionalOriginalTransferControl',
  ] as const) {
    const part = parts[name];
    if (part === null || part === undefined) {
      missing.push(name);
      continue;
    }
    const values = axes.map((axis) => part[axis]);
    if (
      Reflect.ownKeys(part).length !== axes.length ||
      axes.some((axis) => !Object.hasOwn(part, axis)) ||
      values.some((value) => !Number.isSafeInteger(value) || value < 0)
    )
      throw new TypeError('Original composition requires all eight explicit dimensions');
    axes.forEach((axis, index) => {
      total[axis] += values[index]!;
      if (!Number.isSafeInteger(total[axis])) throw new RangeError('Original composition overflow');
    });
  }
  return Object.freeze({ missing: Object.freeze(missing), total: missing.length ? null : Object.freeze(total) });
}

export type IdentitySourceReachedDeclaration = Readonly<{
  name: string;
  calls: number;
  declaration: Readonly<{ work: WorkDimensions; engineRequests: 0 }> | null;
}>;

/** Assemble disjoint reached calls, including repeated validators and alternative
 * failure/rollback controls. This arithmetic never authenticates or funds a child.
 * Call counts come from the owning bounded body, not a caller's claimed progress. */
export function composeIdentitySourceReachedCosts(
  terms: readonly IdentitySourceReachedDeclaration[],
):
  | Readonly<{ state: 'missing'; missing: readonly string[] }>
  | Readonly<{ state: 'complete'; work: WorkDimensions; engineRequests: 0 }> {
  const axes = [
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
  ] as const;
  const total = Object.fromEntries(axes.map((axis) => [axis, 0])) as Record<keyof WorkDimensions, number>;
  const names = new Set<string>();
  const missing: string[] = [];
  for (const term of terms) {
    if (!term.name || names.has(term.name) || !Number.isSafeInteger(term.calls) || term.calls < 1)
      throw new TypeError('Invalid reached Source cost term');
    names.add(term.name);
    if (term.declaration === null) {
      missing.push(term.name);
      continue;
    }
    const declaration = term.declaration;
    if (declaration.engineRequests !== 0 || Reflect.ownKeys(declaration).length !== 2)
      throw new TypeError('Source work requires explicit zero engine requests');
    const work = { ...declaration.work };
    if (
      Reflect.ownKeys(work).length !== axes.length ||
      axes.some((axis) => !Object.hasOwn(work, axis) || !Number.isSafeInteger(work[axis]) || work[axis] < 0)
    )
      throw new TypeError('Source work requires all eight explicit dimensions');
    for (const axis of axes) {
      const repeated = work[axis] * term.calls;
      if (!Number.isSafeInteger(repeated) || !Number.isSafeInteger(total[axis] + repeated))
        throw new RangeError('Reached Source composition overflow');
      total[axis] += repeated;
    }
  }
  if (!terms.length) throw new TypeError('Source composition requires reached body declarations');
  return missing.length
    ? Object.freeze({ state: 'missing', missing: Object.freeze(missing) })
    : Object.freeze({ state: 'complete', work: Object.freeze(total), engineRequests: 0 });
}
