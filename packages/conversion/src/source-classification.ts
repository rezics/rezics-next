const DIGEST = /^[0-9a-f]{64}$/u;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/u;
const MAX_PROJECTION_BYTES = 8192;

export type SourceClassificationCoverage =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'complete' | 'partial'; from: string | null; through: string }>;

export type SourceClassificationValue =
  | Readonly<{
      kind: 'observation';
      confidence?: number;
      lie?: boolean;
      confidenceCount?: number;
      lieCount?: number;
    }>
  | Readonly<{ kind: 'clear' }>;

export type SourceClassificationProvenance = Readonly<{
  sourceAlias: string;
  sourceRecordId: string;
  sourceRevision: string | null;
  sourceDigest?: string;
  converterRevision: string;
  observedAt: string | null;
  coverage: SourceClassificationCoverage;
  attribution: string;
  licence: Readonly<{ id: string; url: string }>;
}>;

export type SourceClassificationProjection =
  | Readonly<{
      state: 'available';
      provenance: SourceClassificationProvenance;
      value: SourceClassificationValue;
    }>
  | Readonly<{
      state: 'unavailable';
      reason: 'unadmitted' | 'unsupported-record' | 'incomplete-input' | 'invalid-observation' | 'association-unavailable';
    }>;

type ProjectionInput = Readonly<{
  sourceAlias: unknown;
  sourceRecordId: unknown;
  sourceRevision: unknown;
  sourceDigest?: unknown;
  converterRevision: unknown;
  observedAt: unknown;
  coverage: unknown;
  attribution: unknown;
  licence: unknown;
  value: unknown;
}>;

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= max;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !DATETIME.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function projectCoverage(input: unknown): SourceClassificationCoverage | null {
  const value = object(input);
  if (!value || typeof value.kind !== 'string') return null;
  if (value.kind === 'unknown' && exactKeys(value, ['kind'])) return { kind: 'unknown' };
  if (
    (value.kind === 'complete' || value.kind === 'partial') &&
    exactKeys(value, ['kind', 'from', 'through']) &&
    (value.from === null || validDate(value.from)) &&
    validDate(value.through)
  )
    return { kind: value.kind, from: value.from, through: value.through };
  return null;
}

function projectValue(input: unknown): SourceClassificationValue | null {
  const value = object(input);
  if (!value || typeof value.kind !== 'string') return null;
  if (value.kind === 'clear' && exactKeys(value, ['kind'])) return { kind: 'clear' };
  if (value.kind !== 'observation') return null;
  const allowed = ['kind', 'confidence', 'lie', 'confidenceCount', 'lieCount'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  const hasConfidence = Object.hasOwn(value, 'confidence');
  const hasLie = Object.hasOwn(value, 'lie');
  if (!hasConfidence && !hasLie) return null;
  if (hasConfidence && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence <= 0 || value.confidence > 3))
    return null;
  if (hasLie && typeof value.lie !== 'boolean') return null;
  if (Object.hasOwn(value, 'confidenceCount') && (!hasConfidence || !Number.isSafeInteger(value.confidenceCount) || (value.confidenceCount as number) < 0))
    return null;
  if (Object.hasOwn(value, 'lieCount') && (!hasLie || !Number.isSafeInteger(value.lieCount) || (value.lieCount as number) < 0))
    return null;
  return {
    kind: 'observation',
    ...(hasConfidence ? { confidence: value.confidence as number } : {}),
    ...(hasLie ? { lie: value.lie as boolean } : {}),
    ...(Object.hasOwn(value, 'confidenceCount') ? { confidenceCount: value.confidenceCount as number } : {}),
    ...(Object.hasOwn(value, 'lieCount') ? { lieCount: value.lieCount as number } : {}),
  };
}

/**
 * Builds the bounded converter projection from an admitted trusted registration's sanitized facts.
 * This does not admit provider data or identify a native association.
 */
export function projectSourceClassification(input: unknown): SourceClassificationProjection {
  const value = object(input);
  if (!value) return { state: 'unavailable', reason: 'unsupported-record' };
  const required = ['sourceAlias', 'sourceRecordId', 'sourceRevision', 'converterRevision', 'observedAt', 'coverage', 'attribution', 'licence', 'value'];
  if (Object.keys(value).some((key) => ![...required, 'sourceDigest'].includes(key)))
    return { state: 'unavailable', reason: 'unsupported-record' };
  if (
    !boundedText(value.sourceAlias, 32) || !ALIAS.test(value.sourceAlias) ||
    !boundedText(value.sourceRecordId, 255) ||
    !(value.sourceRevision === null || boundedText(value.sourceRevision, 255)) ||
    (value.sourceDigest !== undefined && (typeof value.sourceDigest !== 'string' || !DIGEST.test(value.sourceDigest))) ||
    (value.sourceRevision === null && typeof value.sourceDigest !== 'string') ||
    !boundedText(value.converterRevision, 128) ||
    !(value.observedAt === null || validDateTime(value.observedAt)) ||
    !boundedText(value.attribution, 256)
  )
    return { state: 'unavailable', reason: 'incomplete-input' };
  const coverage = projectCoverage(value.coverage);
  const sourceValue = projectValue(value.value);
  const licence = object(value.licence);
  if (!coverage || !sourceValue || !licence || !exactKeys(licence, ['id', 'url']) || !boundedText(licence.id, 64) || !boundedText(licence.url, 512))
    return { state: 'unavailable', reason: 'invalid-observation' };
  let url: URL;
  try {
    url = new URL(licence.url);
  } catch {
    return { state: 'unavailable', reason: 'invalid-observation' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { state: 'unavailable', reason: 'invalid-observation' };
  const provenance: SourceClassificationProvenance = {
    sourceAlias: value.sourceAlias,
    sourceRecordId: value.sourceRecordId,
    sourceRevision: value.sourceRevision,
    ...(value.sourceDigest === undefined ? {} : { sourceDigest: value.sourceDigest as string }),
    converterRevision: value.converterRevision,
    observedAt: value.observedAt,
    coverage,
    attribution: value.attribution,
    licence: { id: licence.id, url: licence.url },
  };
  const projection: SourceClassificationProjection = { state: 'available', provenance, value: sourceValue };
  if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > MAX_PROJECTION_BYTES)
    return { state: 'unavailable', reason: 'invalid-observation' };
  return projection;
}
