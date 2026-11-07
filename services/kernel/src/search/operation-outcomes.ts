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

export class SearchUnavailableError extends Error {
  constructor(message = 'OpenSearch is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchUnavailableError';
  }
}

/** A candidate cannot be populated or published from an incomplete native producer set. */
export class DiscoveryProducerCoverageError extends Error {
  readonly missingKinds: readonly string[];
  readonly unsupportedKinds: readonly string[];
  readonly duplicateKinds: readonly string[];

  constructor(input: {
    missingKinds: readonly string[];
    unsupportedKinds: readonly string[];
    duplicateKinds: readonly string[];
  }) {
    const details = [
      ...(input.missingKinds.length ? [`missing kinds: ${input.missingKinds.join(', ')}`] : []),
      ...(input.unsupportedKinds.length ? [`unsupported kinds: ${input.unsupportedKinds.join(', ')}`] : []),
      ...(input.duplicateKinds.length ? [`duplicate kinds: ${input.duplicateKinds.join(', ')}`] : []),
    ];
    const message = 'Discovery generation is not ready: native producer coverage is incomplete';
    super(details.length ? `${message} (${details.join('; ')})` : message);
    this.name = 'DiscoveryProducerCoverageError';
    this.missingKinds = input.missingKinds;
    this.unsupportedKinds = input.unsupportedKinds;
    this.duplicateKinds = input.duplicateKinds;
  }
}

/** A signed owner continuation was invalidated; never retry its retired cut forever. */
export class DiscoveryPopulationCutChangedError extends DiscoveryProducerCoverageError {
  constructor(kind: import('./discovery-api.ts').DiscoveryMetadataKind) {
    super({ missingKinds: [], unsupportedKinds: [kind], duplicateKinds: [] });
  }
}

/** Owner rows changed during nested hydration; the page is not one observation. */
export class OwnerCurrentRestartRequired extends SearchOperationError {
  constructor() {
    super('search_restart_required');
    this.name = 'OwnerCurrentRestartRequired';
  }
}
