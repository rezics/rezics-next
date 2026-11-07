import { PROBLEMS, ProblemError, type FieldError } from '../../http/problem-error.ts';

import {
  SEARCH_VISIT_OPERAND_BUDGET,
  searchNativeAuthoredBytes,
  recoverSearchOperands,
  type SearchNativeRecoveryFamily,
  type SearchNativeCorrection,
  type SearchNativeOperandRecovery,
} from '../operation-outcomes.ts';
export { SEARCH_VISIT_OPERAND_BUDGET, searchNativeAuthoredBytes } from '../operation-outcomes.ts';
export type {
  SearchNativeRecoveryFamily,
  SearchNativeCorrection,
  SearchNativeOperandRecovery,
} from '../operation-outcomes.ts';

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
  return recoverSearchOperands({
    family,
    authoredBytes: input.authoredBytes,
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  });
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

export { searchNativePageTransition } from '../page-recovery.ts';
