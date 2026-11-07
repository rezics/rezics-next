import { Buffer } from 'node:buffer';

export const GROWTH_FAILURE_CAUSE_LIMIT = 16;
const PRIMITIVE_FAILURE_CONTEXT_LIMIT = 1;

export type GrowthFailureCause = Readonly<{
  phase: string;
  name: string;
  message: string;
  omittedNameCharacters?: number;
  omittedMessageCharacters?: number;
  sqlstate?: string;
  omittedSqlstateCharacters?: number;
  omittedDescriptionFields?: readonly ('name' | 'message' | 'sqlstate')[];
  /** The original thrown value remains available without replacing it or mutating its `cause`. */
  value: unknown;
}>;

export type GrowthFailureDiagnostic = Readonly<{
  kind: 'growth-failure-diagnostic';
  version: 1;
  status: 'incomplete';
  phase: string;
  file?: string;
  check?: string;
  source?: string;
  scale?: number;
  repetition?: number;
  captureMode?: 'raw' | 'cost-folded';
  primary: GrowthFailureCause;
  secondary: readonly GrowthFailureCause[];
  native?: unknown;
  omissions?: Readonly<Record<string, number | string>>;
}>;

type DiagnosticContext = Partial<
  Pick<
    GrowthFailureDiagnostic,
    'file' | 'check' | 'source' | 'scale' | 'repetition' | 'captureMode' | 'native' | 'omissions'
  >
> & { readonly phase?: string };

const objectEvidence = new WeakMap<object, GrowthFailureDiagnostic>();
const primitiveEvidence = new Map<unknown, GrowthFailureDiagnostic>();
const PROFILE_EVIDENCE_BYTES = 200_000;
const PROFILE_EVIDENCE_VALUES = 8_192;
const PROFILE_ARRAY_ITEMS = 64;
const PROFILE_STRING_CHARACTERS = 2_048;

/** Builds a bounded summary without allowing hostile error accessors to replace the initiating failure. */
export function describeGrowthFailure(value: unknown, phase: string): GrowthFailureCause {
  let name: string = typeof value;
  let message = 'Non-Error value was thrown';
  let sqlstate: string | undefined;
  const omittedFields: Array<'name' | 'message' | 'sqlstate'> = [];
  if (typeof value === 'string') {
    message = value;
  } else if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    message = String(value);
  } else {
    let isError = false;
    try {
      isError = value instanceof Error;
    } catch {
      // `instanceof` can invoke a hostile proxy trap; retain the exact value and report the omitted summary.
      message = 'Thrown value could not be summarized';
      omittedFields.push('name', 'message', 'sqlstate');
    }
    if (isError) {
      name = 'Error';
      try {
        const errorName = (value as Error).name;
        if (typeof errorName === 'string' && errorName.length > 0) name = errorName;
      } catch {
        omittedFields.push('name');
      }
      message = 'Thrown Error message unavailable';
      try {
        const errorMessage = (value as Error).message;
        if (typeof errorMessage === 'string') message = errorMessage;
        else omittedFields.push('message');
      } catch {
        omittedFields.push('message');
      }
      try {
        const code = (value as Error & { readonly code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) sqlstate = code;
      } catch {
        omittedFields.push('sqlstate');
      }
      if (sqlstate === undefined) {
        try {
          const code = (value as Error & { readonly sqlState?: unknown }).sqlState;
          if (typeof code === 'string' && code.length > 0) sqlstate = code;
        } catch {
          omittedFields.push('sqlstate');
        }
      }
    }
  }
  const omittedDescriptionFields = [...new Set(omittedFields)];
  // Causes are context, not another unbounded copy of a driver or assertion message.
  const maxCharacters = 1_024;
  const omittedNameCharacters = Math.max(0, name.length - 128);
  if (omittedNameCharacters > 0) name = `${name.slice(0, 128)}…`;
  const omittedMessageCharacters = Math.max(0, message.length - maxCharacters);
  if (omittedMessageCharacters > 0) message = `${message.slice(0, maxCharacters)}…`;
  const omittedSqlstateCharacters = Math.max(0, (sqlstate?.length ?? 0) - 128);
  if (sqlstate !== undefined && omittedSqlstateCharacters > 0) sqlstate = `${sqlstate.slice(0, 128)}…`;
  return {
    phase,
    name,
    message,
    ...(omittedNameCharacters === 0 ? {} : { omittedNameCharacters }),
    ...(omittedMessageCharacters === 0 ? {} : { omittedMessageCharacters }),
    ...(sqlstate === undefined ? {} : { sqlstate }),
    ...(omittedSqlstateCharacters === 0 ? {} : { omittedSqlstateCharacters }),
    ...(omittedDescriptionFields.length === 0 ? {} : { omittedDescriptionFields }),
    value,
  };
}

function remember(value: unknown, diagnostic: GrowthFailureDiagnostic): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    objectEvidence.set(value as object, diagnostic);
    return;
  }
  if (primitiveEvidence.has(value)) primitiveEvidence.delete(value);
  primitiveEvidence.set(value, diagnostic);
  while (primitiveEvidence.size > PRIMITIVE_FAILURE_CONTEXT_LIMIT)
    primitiveEvidence.delete(primitiveEvidence.keys().next().value);
}

/** Returns diagnostics associated with the exact thrown value, including primitive throws. */
export function growthFailureEvidence(value: unknown): GrowthFailureDiagnostic | undefined {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function')
    return objectEvidence.get(value as object);
  return primitiveEvidence.get(value);
}

/** Associates bounded native evidence while preserving the exact value that callers catch. */
export function recordGrowthFailureEvidence(
  value: unknown,
  detail: Readonly<{
    phase: string;
    secondary?: readonly Readonly<{ phase: string; value: unknown }>[];
    context?: DiagnosticContext;
    native?: unknown;
    omissions?: Readonly<Record<string, number | string>>;
  }>,
): GrowthFailureDiagnostic {
  const previous = growthFailureEvidence(value);
  const primary = describeGrowthFailure(value, detail.phase);
  const candidates: Array<Readonly<{ phase: string; value: unknown }>> = [
    ...(previous?.secondary.map(({ phase, value: cause }) => ({ phase, value: cause })) ?? []),
    ...(detail.secondary ?? []),
  ];
  const uniqueCandidates = candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => other.phase === candidate.phase && Object.is(other.value, candidate.value)) ===
      index,
  );
  const secondary = uniqueCandidates
    .slice(0, GROWTH_FAILURE_CAUSE_LIMIT)
    .map(({ phase, value: cause }) => describeGrowthFailure(cause, phase));
  const omittedSecondary = Math.max(0, uniqueCandidates.length - secondary.length);
  const context: DiagnosticContext = {
    ...(previous?.file === undefined ? {} : { file: previous.file }),
    ...(previous?.check === undefined ? {} : { check: previous.check }),
    ...(previous?.source === undefined ? {} : { source: previous.source }),
    ...(previous?.scale === undefined ? {} : { scale: previous.scale }),
    ...(previous?.repetition === undefined ? {} : { repetition: previous.repetition }),
    ...(previous?.captureMode === undefined ? {} : { captureMode: previous.captureMode }),
    ...(previous?.native === undefined ? {} : { native: previous.native }),
    ...(previous?.omissions === undefined ? {} : { omissions: previous.omissions }),
    ...(detail.context ?? {}),
  };
  const omissions = { ...(previous?.omissions ?? {}), ...(detail.omissions ?? {}) };
  const previousOmittedSecondary = previous?.omissions?.secondaryCauses;
  const totalOmittedSecondary =
    (typeof previousOmittedSecondary === 'number' ? previousOmittedSecondary : 0) + omittedSecondary;
  if (totalOmittedSecondary > 0) omissions.secondaryCauses = totalOmittedSecondary;
  const diagnostic: GrowthFailureDiagnostic = {
    kind: 'growth-failure-diagnostic',
    version: 1,
    status: 'incomplete',
    phase: detail.phase,
    ...context,
    primary,
    secondary,
    ...(detail.native === undefined && previous?.native === undefined
      ? {}
      : { native: detail.native ?? previous?.native }),
    ...(Object.keys(omissions).length === 0 ? {} : { omissions }),
  };
  remember(value, diagnostic);
  return diagnostic;
}

/** Adds check-level context to an existing diagnostic without replacing its primary failure. */
export function enrichGrowthFailureEvidence(value: unknown, context: DiagnosticContext): GrowthFailureDiagnostic {
  const previous = growthFailureEvidence(value);
  if (!previous) return recordGrowthFailureEvidence(value, { phase: context.phase ?? 'check', context });
  const definedContext = Object.fromEntries(Object.entries(context).filter(([, entry]) => entry !== undefined));
  const diagnostic: GrowthFailureDiagnostic = { ...previous, ...definedContext };
  remember(value, diagnostic);
  return diagnostic;
}

/** Adds a subordinate failure, such as diagnostic export, without changing the original thrown value. */
export function addGrowthFailureCause(value: unknown, phase: string, cause: unknown): GrowthFailureDiagnostic {
  const previous = growthFailureEvidence(value) ?? recordGrowthFailureEvidence(value, { phase });
  const nextCause = describeGrowthFailure(cause, phase);
  const hasCapacity = previous.secondary.length < GROWTH_FAILURE_CAUSE_LIMIT;
  const secondary = hasCapacity ? [...previous.secondary, nextCause] : previous.secondary;
  const omitted = hasCapacity ? 0 : 1;
  const previousOmissions = previous.omissions?.secondaryCauses;
  const diagnostic: GrowthFailureDiagnostic = {
    ...previous,
    secondary,
    ...(omitted === 0
      ? {}
      : {
          omissions: {
            ...(previous.omissions ?? {}),
            secondaryCauses: typeof previousOmissions === 'number' ? previousOmissions + omitted : omitted,
          },
        }),
  };
  remember(value, diagnostic);
  return diagnostic;
}

/** Records bounded context omitted while causes or native evidence reach a shared limit. */
export function addGrowthFailureOmission(value: unknown, omission: string, count: number): GrowthFailureDiagnostic {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Failure omission count must be non-negative');
  const previous = growthFailureEvidence(value) ?? recordGrowthFailureEvidence(value, { phase: 'check' });
  const existing = previous.omissions?.[omission];
  const next = typeof existing === 'number' ? existing + count : count;
  const diagnostic: GrowthFailureDiagnostic = {
    ...previous,
    omissions: { ...(previous.omissions ?? {}), [omission]: next },
  };
  remember(value, diagnostic);
  return diagnostic;
}

function profileCause(cause: GrowthFailureCause): Readonly<Record<string, unknown>> {
  return {
    phase: cause.phase,
    name: cause.name,
    message: cause.message,
    ...(cause.omittedNameCharacters === undefined ? {} : { omittedNameCharacters: cause.omittedNameCharacters }),
    ...(cause.omittedMessageCharacters === undefined
      ? {}
      : { omittedMessageCharacters: cause.omittedMessageCharacters }),
    ...(cause.sqlstate === undefined ? {} : { sqlstate: cause.sqlstate }),
    ...(cause.omittedSqlstateCharacters === undefined
      ? {}
      : { omittedSqlstateCharacters: cause.omittedSqlstateCharacters }),
    ...(cause.omittedDescriptionFields === undefined
      ? {}
      : { omittedDescriptionFields: cause.omittedDescriptionFields }),
  };
}

type CompactState = {
  bytes: number;
  values: number;
  omittedValues: number;
  omittedBytes: number;
  ancestors: Set<object>;
};

function compactProfileValue(value: unknown, state: CompactState, depth = 0): unknown {
  if (++state.values > PROFILE_EVIDENCE_VALUES || depth > 32) {
    state.omittedValues++;
    return undefined;
  }
  if (typeof value === 'string') {
    const limited = value.length > PROFILE_STRING_CHARACTERS ? value.slice(0, PROFILE_STRING_CHARACTERS) : value;
    const bytes = Buffer.byteLength(limited, 'utf8');
    if (state.bytes + bytes > PROFILE_EVIDENCE_BYTES) {
      state.omittedBytes += bytes;
      state.omittedValues++;
      return undefined;
    }
    state.bytes += bytes;
    if (limited.length < value.length) state.omittedBytes += Buffer.byteLength(value.slice(limited.length), 'utf8');
    return limited;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || value === undefined) return undefined;
  if (state.ancestors.has(value)) {
    state.omittedValues++;
    return undefined;
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const count = Math.min(value.length, PROFILE_ARRAY_ITEMS);
      for (let index = 0; index < count; index++) {
        const item = compactProfileValue(value[index], state, depth + 1);
        if (item !== undefined) result.push(item);
      }
      state.omittedValues += value.length - count;
      return result;
    }
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>);
    const count = Math.min(keys.length, PROFILE_ARRAY_ITEMS);
    for (let index = 0; index < count; index++) {
      const key = keys[index]!;
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (state.bytes + keyBytes > PROFILE_EVIDENCE_BYTES) {
        state.omittedBytes += keyBytes;
        state.omittedValues++;
        continue;
      }
      state.bytes += keyBytes;
      const item = compactProfileValue((value as Record<string, unknown>)[key], state, depth + 1);
      if (item !== undefined) result[key] = item;
    }
    state.omittedValues += keys.length - count;
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function compactProfileEvidence(
  value: unknown,
): Readonly<{ value: unknown; omittedValues: number; omittedBytes: number }> {
  const state: CompactState = { bytes: 0, values: 0, omittedValues: 0, omittedBytes: 0, ancestors: new Set() };
  return {
    value: compactProfileValue(value, state),
    omittedValues: state.omittedValues,
    omittedBytes: state.omittedBytes,
  };
}

/** Removes direct error references before sending the diagnostic through the bounded JSONL writer. */
export function growthFailureProfileRecord(diagnostic: GrowthFailureDiagnostic): Readonly<Record<string, unknown>> {
  const native = diagnostic.native === undefined ? undefined : compactProfileEvidence(diagnostic.native);
  return {
    kind: diagnostic.kind,
    version: diagnostic.version,
    status: diagnostic.status,
    file: diagnostic.file,
    check: diagnostic.check,
    source: diagnostic.source,
    phase: diagnostic.phase,
    scale: diagnostic.scale,
    repetition: diagnostic.repetition,
    captureMode: diagnostic.captureMode,
    cause: profileCause(diagnostic.primary),
    secondaryCauses: diagnostic.secondary.map(profileCause),
    ...(native === undefined ? {} : { native: native.value }),
    ...(diagnostic.omissions === undefined && native?.omittedValues === 0 && native.omittedBytes === 0
      ? {}
      : {
          omissions: {
            ...(diagnostic.omissions ?? {}),
            ...(native === undefined
              ? {}
              : { profileEvidenceValues: native.omittedValues, profileEvidenceBytes: native.omittedBytes }),
          },
        }),
  };
}

/** UTF-8 size helper used when charging the small context added to a retained capture. */
export function growthFailureContextBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
