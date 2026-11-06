import { PROBLEMS, ProblemError, type FieldError } from '../../http/problem-error.ts';
import type { SearchPageRecoveryTransition } from '../page-recovery.ts';

/** Typed producer families installed readers consume. Totals and empty-success chains are not members. */
export type SearchNativeRecoveryFamily =
  | 'invalid'
  | 'invalid-cursor'
  | 'session'
  | 'closed'
  | 'denied'
  | 'restart'
  | 'index-not-ready'
  | 'source-not-ready'
  | 'unavailable'
  | 'ready';

export type SearchNativeRecoveryInput = Readonly<{
  status: number;
  code?: string;
  cursorPointer?: boolean;
}>;

/** Omit absent optional problem fields so exactOptionalPropertyTypes callers can classify a status. */
export function searchNativeRecoveryInput(
  status: number,
  code?: string,
  cursorPointer?: boolean,
): SearchNativeRecoveryInput {
  return {
    status,
    ...(code === undefined ? {} : { code }),
    ...(cursorPointer === undefined ? {} : { cursorPointer }),
  };
}

export type SearchNativeCorrection = Readonly<{
  pointer: string;
  code: string;
}>;

/** Authored operand bytes that still retain per-value correction instead of a payload-free restart. */
export const SEARCH_VISIT_OPERAND_BUDGET = 4096;

/** Classify a native Search, suggest or facet HTTP problem before a reader publishes ready. */
export function searchNativeRecoveryFamily(input: SearchNativeRecoveryInput): SearchNativeRecoveryFamily {
  if (input.status === 200) return 'ready';
  if (input.status === 401) return 'session';
  if (input.status === 403 && input.code === 'platform_closed') return 'closed';
  if (input.status === 403 || input.status === 404) return 'denied';
  if (input.status === 409) return 'restart';
  if (input.status === 422) return 'invalid';
  if (input.status === 400) return input.cursorPointer ? 'invalid-cursor' : 'invalid';
  if (input.status === 503 && input.code === 'index_not_ready') return 'index-not-ready';
  if (input.status === 503 && input.code === 'semantic_not_ready') return 'source-not-ready';
  return 'unavailable';
}

export function searchNativeCursorPointer(errors?: readonly Pick<FieldError, 'pointer'>[]): boolean {
  return Boolean(errors?.some((error) => /(^|\/)cursor$/.test(error.pointer)));
}

export function searchNativeAuthoredBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
}

export type SearchNativeOperandRecovery = Readonly<{
  family: SearchNativeRecoveryFamily;
  corrections?: readonly SearchNativeCorrection[];
  textDiagnostic?: unknown;
  reusableRequest: boolean;
}>;

/**
 * Invalid operands keep field pointers and text diagnostics inside the visit budget.
 * Over-budget authored JSON is a payload-free restart that does not echo the request.
 * Temporary source or index unavailability keeps the same executed operands for retry.
 */
export function searchNativeOperandRecovery(input: {
  status: number;
  code?: string;
  errors?: readonly SearchNativeCorrection[];
  extensions?: Readonly<Record<string, unknown>>;
  authoredBytes: number;
}): SearchNativeOperandRecovery {
  const family = searchNativeRecoveryFamily(
    searchNativeRecoveryInput(input.status, input.code, searchNativeCursorPointer(input.errors)),
  );
  if (family === 'invalid' || family === 'invalid-cursor') {
    if (input.authoredBytes > SEARCH_VISIT_OPERAND_BUDGET) return { family: 'restart', reusableRequest: false };
    return {
      family,
      ...(input.errors ? { corrections: input.errors } : {}),
      ...(input.extensions?.textDiagnostic === undefined ? {} : { textDiagnostic: input.extensions.textDiagnostic }),
      reusableRequest: false,
    };
  }
  return {
    family,
    reusableRequest: family === 'index-not-ready' || family === 'source-not-ready' || family === 'unavailable',
  };
}

/** Map a thrown native problem onto the shared family, including over-budget operand restart. */
export function searchNativeProblemRecovery(error: ProblemError, authored: unknown): SearchNativeOperandRecovery {
  return searchNativeOperandRecovery({
    status: PROBLEMS[error.code].status,
    code: error.code,
    authoredBytes: searchNativeAuthoredBytes(authored),
    ...(error.errors === undefined ? {} : { errors: error.errors }),
    ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
  });
}

/** Over-budget invalid operands restart without echoing the payload; other problems stay as thrown. */
export function searchNativeRetainOrRestart(error: ProblemError, authored: unknown): ProblemError {
  const recovery = searchNativeProblemRecovery(error, authored);
  if (
    recovery.family === 'restart' &&
    (error.code === 'invalid_request' || error.code === 'unsupported_query') &&
    searchNativeAuthoredBytes(authored) > SEARCH_VISIT_OPERAND_BUDGET
  )
    return new ProblemError('search_restart_required');
  return error;
}

/** Generation or identity change restarts; preparation is never a successful empty page. */
export function searchNativePageTransition(input: {
  family: SearchNativeRecoveryFamily;
  generationChanged?: boolean;
  identityChanged?: boolean;
}): SearchPageRecoveryTransition {
  if (input.generationChanged || input.identityChanged || input.family === 'restart') return 'restart';
  if (input.family === 'index-not-ready' || input.family === 'source-not-ready') return 'preparing';
  if (input.family === 'ready') return 'ready';
  return 'retry';
}
