import { RV } from '../work/activate.ts';
import { SCALAR_NO_VALUE, SCALAR_UNKNOWN, scalarRdfTerm, type WorkScalarValue } from '../work/scalar-value.ts';

/**
 * The general ValueDefinition codec (MODEL03/04/10). It generalizes the MODEL02
 * Work scalar sum: every `WorkScalarValue` is a `SemanticValue` with the same tag,
 * lexical, RDF term and JSON-LD export. Numbers cross JSON only as exact strings.
 */
export type ExactNumber =
  | { kind: 'integer'; lexical: string }
  | { kind: 'decimal'; lexical: string }
  | { kind: 'rational'; lexical: string };

export type TemporalPrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

export type SemanticValue =
  | ExactNumber
  | { kind: 'boolean'; lexical: 'true' | 'false' }
  | { kind: 'string'; lexical: string }
  | { kind: 'language-string'; lexical: string; language: string; direction?: 'ltr' | 'rtl' }
  | { kind: 'temporal'; lexical: string; precision: TemporalPrecision; calendar: 'gregorian'; timeZone?: string }
  | { kind: 'quantity'; lexical: string; value: ExactNumber; unit: string; quantityKind?: string;
    uncertainty?: ExactNumber }
  | { kind: 'resource'; ref: string }
  | { kind: 'external'; provider: string; namespace: string; key: string }
  | { kind: 'unknown' }
  | { kind: 'no-value' };

/** A read never substitutes or discloses a private or missing referent (MODEL10). */
export type ReferenceAvailability = { state: 'available' } | { state: 'unavailable' };

/** Compile-time proof that the MODEL02 value space is a subset, not a fork. */
export const workScalarAsSemantic = (value: WorkScalarValue): SemanticValue => value;

export class InvalidSemanticValue extends Error {}
export class UnsupportedSemanticValue extends Error {}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const TIME = 'http://www.w3.org/2006/time#';
export const OWL_RATIONAL = 'http://www.w3.org/2002/07/owl#rational';
export const GREGORIAN = 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian';
export const EXACT_LIMITS = { digits: 1024, text: 8000, key: 512 } as const;

const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)\.[0-9]*[1-9]$/;
const RATIONAL = /^-?(0|[1-9][0-9]*)\/[1-9][0-9]*$/;
const EVIDENCE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERM = /^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEMPORAL: Record<TemporalPrecision, RegExp> = {
  year: /^(\d{4})$/,
  month: /^(\d{4})-(\d{2})$/,
  day: /^(\d{4})-(\d{2})-(\d{2})$/,
  hour: /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(Z|[+-]\d{2}:\d{2})?$/,
  minute: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/,
  second: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/,
};
const UNIT_TYPE: Record<TemporalPrecision, string> = {
  year: `${TIME}unitYear`, month: `${TIME}unitMonth`, day: `${TIME}unitDay`,
  hour: `${TIME}unitHour`, minute: `${TIME}unitMinute`, second: `${TIME}unitSecond`,
};

function fail(message: string): never { throw new InvalidSemanticValue(message); }

function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('semantic value must be an object');
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => row[key] === undefined)) {
    fail('semantic value has unsupported or missing fields');
  }
  return row;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /\p{Cs}/u.test(value) || value.includes('\u0000')) {
    fail('semantic text is invalid');
  }
  return value;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Exact numbers use one canonical lexical so TDB2 value normalization is the identity. */
export function checkedExactNumber(value: unknown): ExactNumber {
  const row = object(value, ['kind', 'lexical'], ['kind', 'lexical']);
  const lexical = text(row.lexical, EXACT_LIMITS.digits + 2);
  if (row.kind === 'integer' && INTEGER.test(lexical) && lexical !== '-0') return { kind: 'integer', lexical };
  if (row.kind === 'decimal' && DECIMAL.test(lexical)) return { kind: 'decimal', lexical };
  if (row.kind === 'rational' && RATIONAL.test(lexical)) {
    const [numerator, denominator] = lexical.split('/').map(BigInt) as [bigint, bigint];
    const magnitude = numerator < 0n ? -numerator : numerator;
    if (denominator >= 2n && numerator !== 0n && gcd(magnitude, denominator) === 1n) return { kind: 'rational', lexical };
  }
  return fail('exact number is not canonical');
}

/** Canonical exact value of a supplied decimal evidence lexical such as `1.50`. */
export function exactFromEvidence(lexical: string): { value: ExactNumber; decimalPlaces?: number } {
  if (!EVIDENCE.test(lexical) || lexical.length > EXACT_LIMITS.digits + 2) fail('quantity lexical is invalid');
  const [whole, fraction = ''] = lexical.split('.') as [string, string?];
  const trimmed = fraction.replace(/0+$/, '');
  const negative = whole.startsWith('-') && (whole !== '-0' || trimmed.length > 0);
  const digits = whole.replace(/^-/, '');
  const canonical = `${negative ? '-' : ''}${digits}${trimmed ? `.${trimmed}` : ''}`;
  return { value: trimmed ? { kind: 'decimal', lexical: canonical } : { kind: 'integer', lexical: canonical },
    ...(fraction.length ? { decimalPlaces: fraction.length } : {}) };
}

function checkedOffset(offset: string | undefined): string | undefined {
  if (offset === undefined || offset === 'Z') return offset;
  const [hours, minutes] = offset.slice(1).split(':').map(Number) as [number, number];
  if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) fail('temporal offset is out of range');
  return offset;
}

export interface TemporalParts {
  offset?: string;
  /** Inclusive UTC bounds of the stated precision, only when an offset fixes the instant. */
  earliest?: string;
  latest?: string;
}

function utcMillis(fields: readonly number[]): number {
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields as [number, ...number[]];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function isoNanos(nanos: bigint): string {
  const seconds = nanos >= 0n ? nanos / 1_000_000_000n : -((-nanos + 999_999_999n) / 1_000_000_000n);
  const fraction = (nanos - seconds * 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ''}Z`;
}

/** Check a Gregorian lexical against its precision and derive offset-fixed bounds. */
export function temporalParts(lexical: string, precision: TemporalPrecision): TemporalParts {
  const match = TEMPORAL[precision].exec(lexical);
  if (!match) fail('temporal lexical does not match its precision');
  const fields = match.slice(1).filter(part => part !== undefined && /^\d+$/.test(part)).map(Number);
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields as [number, ...number[]];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) fail('temporal value is not a calendar date');
  const offset = checkedOffset(match.slice(1).find(part => part !== undefined && /^(Z|[+-]\d{2}:\d{2})$/.test(part)));
  if (offset === undefined) return {};
  const fraction = match.slice(1).find(part => part?.startsWith('.'));
  const shift = offset === 'Z' ? 0 : (offset.startsWith('-') ? -1 : 1)
    * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000;
  const start = BigInt(utcMillis(fields) - shift) * 1_000_000n
    + (fraction ? BigInt(fraction.slice(1).padEnd(9, '0')) : 0n);
  const span = precision === 'hour' ? 3_600_000_000_000n : precision === 'minute' ? 60_000_000_000n
    : 10n ** BigInt(9 - (fraction ? fraction.length - 1 : 0));
  return { offset, earliest: isoNanos(start), latest: isoNanos(start + span - 1n) };
}

function checkedTimeZone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const zone = text(value, 64);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); }
  catch { fail('time zone is not an admitted IANA name'); }
  return zone;
}

function checkedLanguage(value: unknown): string {
  const language = text(value, 35);
  let canonical: string | undefined;
  try { canonical = Intl.getCanonicalLocales(language)[0]; }
  catch { fail('language tag is invalid'); }
  if (canonical !== language || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language)) {
    fail('language tag is not canonical BCP 47');
  }
  return language;
}

/** Decode one request value. Absence is represented by omitting it, never by null. */
export function checkedSemanticValue(value: unknown): SemanticValue {
  const kind = (value && typeof value === 'object' && !Array.isArray(value)) ? (value as { kind?: unknown }).kind : undefined;
  switch (kind) {
    case 'integer': case 'decimal': case 'rational': return checkedExactNumber(value);
    case 'boolean': {
      const row = object(value, ['kind', 'lexical'], ['kind', 'lexical']);
      if (row.lexical !== 'true' && row.lexical !== 'false') fail('boolean lexical is not canonical');
      return { kind: 'boolean', lexical: row.lexical };
    }
    case 'string': {
      const row = object(value, ['kind', 'lexical'], ['kind', 'lexical']);
      return { kind: 'string', lexical: text(row.lexical, EXACT_LIMITS.text) };
    }
    case 'language-string': {
      const row = object(value, ['kind', 'lexical', 'language', 'direction'], ['kind', 'lexical', 'language']);
      if (row.direction !== undefined && row.direction !== 'ltr' && row.direction !== 'rtl') fail('direction is invalid');
      return { kind: 'language-string', lexical: text(row.lexical, EXACT_LIMITS.text),
        language: checkedLanguage(row.language), ...(row.direction ? { direction: row.direction } : {}) };
    }
    case 'temporal': {
      const row = object(value, ['kind', 'lexical', 'precision', 'calendar', 'timeZone'],
        ['kind', 'lexical', 'precision', 'calendar']);
      if (row.calendar !== 'gregorian') throw new UnsupportedSemanticValue('calendar is not admitted');
      if (typeof row.precision !== 'string' || !(row.precision in TEMPORAL)) fail('temporal precision is invalid');
      const precision = row.precision as TemporalPrecision;
      const lexical = text(row.lexical, 64);
      temporalParts(lexical, precision);
      const timeZone = checkedTimeZone(row.timeZone);
      return { kind: 'temporal', lexical, precision, calendar: 'gregorian', ...(timeZone ? { timeZone } : {}) };
    }
    case 'quantity': {
      const row = object(value, ['kind', 'lexical', 'value', 'unit', 'quantityKind', 'uncertainty'],
        ['kind', 'lexical', 'value', 'unit']);
      const lexical = text(row.lexical, EXACT_LIMITS.digits + 2);
      const exact = checkedExactNumber(row.value);
      const evidence = exact.kind === 'rational' ? exact : exactFromEvidence(lexical).value;
      if (evidence.kind !== exact.kind || evidence.lexical !== exact.lexical
        || (exact.kind === 'rational' && lexical !== exact.lexical)) {
        fail('quantity lexical evidence differs from its exact value');
      }
      const unit = text(row.unit, 2048);
      const quantityKind = row.quantityKind === undefined ? undefined : text(row.quantityKind, 2048);
      if (!TERM.test(unit) || (quantityKind !== undefined && !TERM.test(quantityKind))) fail('unit definition must be an IRI');
      const uncertainty = row.uncertainty === undefined ? undefined : checkedExactNumber(row.uncertainty);
      if (uncertainty?.lexical.startsWith('-')) fail('uncertainty is negative');
      return { kind: 'quantity', lexical, value: exact, unit, ...(quantityKind ? { quantityKind } : {}),
        ...(uncertainty ? { uncertainty } : {}) };
    }
    case 'resource': {
      const row = object(value, ['kind', 'ref'], ['kind', 'ref']);
      if (typeof row.ref !== 'string' || !NATIVE.test(row.ref)) fail('resource reference is not a native identity');
      return { kind: 'resource', ref: row.ref };
    }
    case 'external': {
      const row = object(value, ['kind', 'provider', 'namespace', 'key'], ['kind', 'provider', 'namespace', 'key']);
      const provider = text(row.provider, 64); const namespace = text(row.namespace, 64);
      if (!SLUG.test(provider) || !SLUG.test(namespace)) fail('external provider or namespace is invalid');
      const key = text(row.key, EXACT_LIMITS.key);
      if (!key.length || /[\u0000-\u001f\u007f]/.test(key)) fail('external key is invalid');
      return { kind: 'external', provider, namespace, key };
    }
    case 'unknown': case 'no-value':
      object(value, ['kind'], ['kind']);
      return { kind };
    default: return fail('unsupported semantic value kind');
  }
}

const literal = (lexical: string, datatype: string): string => `${JSON.stringify(lexical)}^^<${datatype}>`;

function exactTerm(value: ExactNumber): string {
  return literal(value.lexical, value.kind === 'rational' ? OWL_RATIONAL : `${XSD}${value.kind}`);
}

/** RDF for one value: a direct term, or an identified value node validated by value-exact-v1. */
export interface ValueRdf {
  object: string;
  node?: { iri: string; shape: 'quantity' | 'temporal' | 'directional-text' | 'external-reference'; triples: string[] };
}

export function semanticValueRdf(value: SemanticValue, allocateNode: () => string): ValueRdf {
  switch (value.kind) {
    case 'integer': case 'decimal': case 'rational': return { object: exactTerm(value) };
    case 'boolean': return { object: literal(value.lexical, `${XSD}boolean`) };
    case 'string': return { object: literal(value.lexical, `${XSD}string`) };
    case 'unknown': return { object: `<${SCALAR_UNKNOWN}>` };
    case 'no-value': return { object: `<${SCALAR_NO_VALUE}>` };
    case 'resource': return { object: `<${value.ref}>` };
    case 'language-string': {
      if (!value.direction) return { object: `${JSON.stringify(value.lexical)}@${value.language}` };
      const node = allocateNode();
      return { object: `<${node}>`, node: { iri: node, shape: 'directional-text', triples: [
        `<${node}> <${RDF}value> ${literal(value.lexical, `${XSD}string`)}`,
        `<${node}> <${RDF}language> ${literal(value.language, `${XSD}string`)}`,
        `<${node}> <${RDF}direction> ${literal(value.direction, `${XSD}string`)}`] } };
    }
    case 'temporal': {
      const node = allocateNode();
      const parts = temporalParts(value.lexical, value.precision);
      return { object: `<${node}>`, node: { iri: node, shape: 'temporal', triples: [
        `<${node}> a <${TIME}GeneralDateTimeDescription>`,
        `<${node}> <${RV}lexicalForm> ${literal(value.lexical, `${XSD}string`)}`,
        `<${node}> <${TIME}unitType> <${UNIT_TYPE[value.precision]}>`,
        `<${node}> <${TIME}hasTRS> <${GREGORIAN}>`,
        ...(parts.offset ? [`<${node}> <${RV}utcOffset> ${literal(parts.offset, `${XSD}string`)}`] : []),
        ...(value.timeZone ? [`<${node}> <${RV}timeZoneName> ${literal(value.timeZone, `${XSD}string`)}`] : []),
        ...(parts.earliest ? [`<${node}> <${RV}earliest> ${literal(parts.earliest, `${XSD}dateTime`)}`] : []),
        ...(parts.latest ? [`<${node}> <${RV}latest> ${literal(parts.latest, `${XSD}dateTime`)}`] : []),
      ] } };
    }
    case 'quantity': {
      const node = allocateNode();
      const places = value.value.kind === 'rational' ? undefined : exactFromEvidence(value.lexical).decimalPlaces;
      return { object: `<${node}>`, node: { iri: node, shape: 'quantity', triples: [
        `<${node}> a <https://schema.org/QuantitativeValue>`,
        `<${node}> <https://schema.org/value> ${exactTerm(value.value)}`,
        `<${node}> <https://schema.org/unitCode> <${value.unit}>`,
        `<${node}> <${RV}lexicalForm> ${literal(value.lexical, `${XSD}string`)}`,
        ...(places ? [`<${node}> <${RV}decimalPlaces> ${literal(String(places), `${XSD}integer`)}`] : []),
        ...(value.quantityKind ? [`<${node}> <${RV}quantityKind> <${value.quantityKind}>`] : []),
        ...(value.uncertainty ? [`<${node}> <${RV}uncertainty> ${exactTerm(value.uncertainty)}`] : []),
      ] } };
    }
    case 'external': {
      const node = allocateNode();
      return { object: `<${node}>`, node: { iri: node, shape: 'external-reference', triples: [
        `<${node}> a <${RV}ExternalReference>`,
        `<${node}> <${RV}externalProvider> ${literal(value.provider, `${XSD}string`)}`,
        `<${node}> <${RV}externalNamespace> ${literal(value.namespace, `${XSD}string`)}`,
        `<${node}> <${RV}externalKey> ${literal(value.key, `${XSD}string`)}`] } };
    }
  }
}

/** Expanded JSON-LD object for one value; MODEL02 states export exactly as before. */
export function semanticValueExport(value: SemanticValue): Record<string, unknown> {
  switch (value.kind) {
    case 'integer': case 'decimal': return { '@value': value.lexical, '@type': `${XSD}${value.kind}` };
    case 'rational': return { '@value': value.lexical, '@type': OWL_RATIONAL };
    case 'boolean': return { '@value': value.lexical, '@type': `${XSD}boolean` };
    case 'string': return { '@value': value.lexical, '@type': `${XSD}string` };
    case 'unknown': return { '@id': SCALAR_UNKNOWN };
    case 'no-value': return { '@id': SCALAR_NO_VALUE };
    case 'resource': return { '@id': value.ref };
    case 'language-string': return { '@value': value.lexical, '@language': value.language,
      ...(value.direction ? { '@direction': value.direction } : {}) };
    case 'temporal': return { '@type': [`${TIME}GeneralDateTimeDescription`],
      [`${RV}lexicalForm`]: [{ '@value': value.lexical }],
      [`${TIME}unitType`]: [{ '@id': UNIT_TYPE[value.precision] }], [`${TIME}hasTRS`]: [{ '@id': GREGORIAN }],
      ...(value.timeZone ? { [`${RV}timeZoneName`]: [{ '@value': value.timeZone }] } : {}) };
    case 'quantity': return { '@type': ['https://schema.org/QuantitativeValue'],
      'https://schema.org/value': [semanticValueExport(value.value)],
      'https://schema.org/unitCode': [{ '@id': value.unit }], [`${RV}lexicalForm`]: [{ '@value': value.lexical }],
      ...(value.quantityKind ? { [`${RV}quantityKind`]: [{ '@id': value.quantityKind }] } : {}),
      ...(value.uncertainty ? { [`${RV}uncertainty`]: [semanticValueExport(value.uncertainty)] } : {}) };
    case 'external': return { '@type': [`${RV}ExternalReference`],
      [`${RV}externalProvider`]: [{ '@value': value.provider }],
      [`${RV}externalNamespace`]: [{ '@value': value.namespace }], [`${RV}externalKey`]: [{ '@value': value.key }] };
  }
}

/** The MODEL02 term is reproduced exactly for the shared value subset. */
export function sameTermAsWorkScalar(value: WorkScalarValue): boolean {
  return semanticValueRdf(value, () => fail('scalar states need no node')).object === scalarRdfTerm(value);
}
