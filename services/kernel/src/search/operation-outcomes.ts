/** Native Search outcomes. Transport status, headers and problem construction belong to HTTP. */
export type SearchOperationCode =
  | 'invalid_request'
  | 'unsupported_query'
  | 'search_restart_required'
  | 'index_not_ready'
  | 'semantic_not_ready'
  | 'dependency_unavailable';

export type SearchCorrectionCode =
  | 'required'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_format'
  | 'out_of_range'
  | 'unsupported';
export type SearchCorrection = Readonly<{ pointer: string; code: SearchCorrectionCode }>;

/** An admitted operation's native refusal; the route supplies its HTTP representation. */
export class SearchOperationError extends Error {
  readonly errors: readonly SearchCorrection[] | undefined;
  readonly extensions: Readonly<Record<string, unknown>> | undefined;

  constructor(
    readonly code: SearchOperationCode,
    options: Readonly<{
      errors?: readonly SearchCorrection[];
      extensions?: Readonly<Record<string, unknown>>;
    }> = {},
  ) {
    super(code);
    this.name = 'SearchOperationError';
    this.errors = options.errors;
    this.extensions = options.extensions;
  }
}

/** Producer families retained by executed-request recovery before publishing ready. */
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
export type SearchNativeCorrection = Readonly<{ pointer: string; code: string }>;
export type SearchNativeOperandRecovery = Readonly<{
  family: SearchNativeRecoveryFamily;
  corrections?: readonly SearchNativeCorrection[];
  textDiagnostic?: unknown;
  reusableRequest: boolean;
}>;

/** Authored operand bytes that retain per-value correction instead of a payload-free restart. */
export const SEARCH_VISIT_OPERAND_BUDGET = 4096;

export function searchNativeAuthoredBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
}

/** Native recovery owns retained operands and correction disclosure, independent of HTTP status. */
export function recoverSearchOperands(
  input: Readonly<{
    family: SearchNativeRecoveryFamily;
    errors?: readonly SearchNativeCorrection[];
    extensions?: Readonly<Record<string, unknown>>;
    authoredBytes: number;
  }>,
): SearchNativeOperandRecovery {
  const { family } = input;
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
