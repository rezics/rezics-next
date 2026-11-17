import { types } from 'node:util';
import { CredentialInputError } from './credentials.ts';

type SeedPreparationPhase =
  | 'environment'
  | 'kernel-readiness'
  | 'personal-export'
  | 'dump-cache-open'
  | `${'bangumi' | 'vndb'}-${'cache-read' | 'archive-acquisition' | 'archive-extraction' | 'table-read'}`
  | 'vndb-manifest-write'
  | 'state-directory'
  | 'account-key'
  | 'catalogue-transport'
  | 'reviewed-catalogue'
  | 'reviewed-inventory'
  | 'reviewed-ledger'
  | 'reviewed-fence'
  | 'reviewed-metadata'
  | 'reviewed-create'
  | 'reviewed-proposal'
  | 'reviewed-selection'
  | 'reviewed-current-read'
  | 'reviewed-finalize'
  | 'showcase-account-key'
  | 'import-handoff'
  | 'seed-options'
  | 'record-planning'
  | 'character-vocabulary-planning'
  | 'prior-result'
  | 'binding-configuration'
  | 'binding-current-read'
  | 'showcase-journal'
  | 'result-handoff';

export type EnterSeedPreparation = (phase: SeedPreparationPhase) => void;

type PreparationReason =
  | 'missing-setting'
  | 'result-missing'
  | 'catalogue-unpublished'
  | 'ledger-busy'
  | 'source-fenced'
  | 'metadata-mismatch'
  | 'binding-withdrawn'
  | 'binding-unavailable'
  | 'file-missing'
  | 'table-header-invalid'
  | 'row-too-large'
  | 'row-shape-invalid'
  | 'table-changed'
  | 'table-invalid';

const failures = new WeakMap<object, { phase: SeedPreparationPhase; reason?: PreparationReason }>();

/** Preserve the innermost failed operation and the original error used by journal and transport callers. */
export function seedPreparationFailure(
  error: unknown,
  phase: SeedPreparationPhase,
  reason?: PreparationReason,
): object {
  const failure =
    error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error
      : new Error('Seed preparation failed', { cause: error });
  if (!failures.has(failure)) failures.set(failure, { phase, ...(reason && { reason }) });
  return failure;
}

export async function observeSeedPreparation<T>(
  initial: SeedPreparationPhase,
  run: (enter: EnterSeedPreparation) => Promise<T>,
): Promise<T> {
  let phase = initial;
  try {
    return await run((next) => {
      phase = next;
    });
  } catch (error) {
    throw seedPreparationFailure(error, phase);
  }
}

/** Emit only locally defined phase and cause labels, never exception text, filenames or response data. */
export function seedPreparationDetail(error: unknown): string | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  const failure = failures.get(error);
  if (!failure) return undefined;
  return `phase=${failure.phase} reason=${failure.reason ?? localFailureReason(error)}`;
}

function localFailureReason(error: object): string {
  if (types.isProxy(error)) return 'operation-failed';
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (code === 'ENOENT') return 'file-missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'access-denied';
  if (code === 'ENOSPC') return 'storage-full';
  if (code === 'ENOTDIR' || code === 'EISDIR') return 'wrong-file-type';
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return 'invalid-encoding';
  if (error instanceof CredentialInputError) return 'invalid-credential-input';
  if (error instanceof SyntaxError) return 'invalid-syntax';
  if (error instanceof TypeError) return 'type-error';
  return 'operation-failed';
}
