import type { PropertyDefinition } from '@rezics/definitions';
import { checkStatementInput } from '@rezics/definitions/validate';

const MAX_INPUT_BYTES = 1_048_576;
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const JULIAN = 'http://www.wikidata.org/entity/Q1985786';

export type WikidataValueFailure =
  | 'missing'
  | 'invalid-value'
  | 'unsupported-datatype'
  | 'unsupported-calendar'
  | 'unsupported-precision'
  | 'unsupported-timezone'
  | 'unsupported-uncertainty'
  | 'unsupported-unit';

export type WikidataValueAdmission =
  | { state: 'admitted'; datatype?: 'time' | 'quantity'; value: { type: 'value'; content: unknown } | { type: 'somevalue' | 'novalue' } }
  | { state: 'unsupported'; reason: WikidataValueFailure };

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function bounded(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > 8) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string' && entry.length > MAX_INPUT_BYTES) return false;
    if (entry !== null && typeof entry === 'object') {
      if (!isRecord(entry) || Object.keys(entry).length > 8) return false;
      for (const nested of Object.values(entry))
        if (typeof nested === 'string' && nested.length > MAX_INPUT_BYTES) return false;
    }
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= MAX_INPUT_BYTES;
  } catch {
    return false;
  }
}

function sourceValue(input: RecordValue):
  | { state: 'missing' }
  | { state: 'snak'; type: 'somevalue' | 'novalue' }
  | { state: 'value'; datatype: string; content: unknown } {
  if (input.snaktype === 'somevalue' || input.snaktype === 'novalue') return { state: 'snak', type: input.snaktype };
  if (input.snaktype !== undefined && input.snaktype !== 'value') return { state: 'missing' };
  const wrapper = isRecord(input.datavalue) ? input.datavalue : input;
  const datatype = typeof input.datatype === 'string' ? input.datatype : wrapper.type;
  if (typeof datatype !== 'string') return { state: 'missing' };
  if (!Object.hasOwn(wrapper, 'value')) return { state: 'missing' };
  return { state: 'value', datatype, content: wrapper.value };
}

function unsupportedTime(content: unknown): WikidataValueFailure | undefined {
  if (!isRecord(content)) return 'invalid-value';
  if (typeof content.precision !== 'number' || ![9, 10, 11].includes(content.precision))
    return 'unsupported-precision';
  if (content.calendarmodel !== GREGORIAN && content.calendarmodel !== JULIAN) return 'unsupported-calendar';
  if (Object.hasOwn(content, 'timezone') && (typeof content.timezone !== 'number' || !Number.isSafeInteger(content.timezone)))
    return 'unsupported-timezone';
  for (const key of ['before', 'after']) {
    const uncertainty = content[key];
    if (Object.hasOwn(content, key) && (typeof uncertainty !== 'number' || !Number.isSafeInteger(uncertainty) || uncertainty < 0))
      return 'unsupported-uncertainty';
  }
  return;
}

/** Admit one Wikibase snak/DataValue through the exact portable property schema and native limits. */
export function admitWikidataValue(input: unknown, property: PropertyDefinition): WikidataValueAdmission {
  if (input === undefined) return { state: 'unsupported', reason: 'missing' };
  if (!bounded(input)) return { state: 'unsupported', reason: 'invalid-value' };
  if (!isRecord(input)) return { state: 'unsupported', reason: 'invalid-value' };
  const parsed = sourceValue(input);
  if (parsed.state === 'missing') return { state: 'unsupported', reason: 'missing' };
  if (parsed.state === 'snak') return { state: 'admitted', value: { type: parsed.type } };
  if (parsed.datatype !== property.datatype || (parsed.datatype !== 'time' && parsed.datatype !== 'quantity'))
    return { state: 'unsupported', reason: 'unsupported-datatype' };
  if (parsed.datatype === 'time') {
    const failure = unsupportedTime(parsed.content);
    if (failure) return { state: 'unsupported', reason: failure };
  } else if (isRecord(parsed.content) && typeof parsed.content.unit === 'string') {
    const units = property.units ?? [];
    if (!units.includes('*') && !units.includes(parsed.content.unit))
      return { state: 'unsupported', reason: 'unsupported-unit' };
  }
  const statement = {
    property: { id: 'ex:value' },
    value: { type: 'value', content: parsed.content },
    references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://www.wikidata.org/' } }] }],
  };
  const url: PropertyDefinition = {
    iri: 'https://schema.org/url',
    labels: { en: 'Source URL' },
    mappings: [],
    datatype: 'url',
    multivalued: false,
    qualifiers: [],
    value: { type: 'string', pattern: '^https?://[^\\s]+$', maxLength: 1500 },
  };
  const checked = checkStatementInput(statement, { properties: { 'ex:value': property, 'schema:url': url } });
  if (checked.violations.length) return { state: 'unsupported', reason: 'invalid-value' };
  return {
    state: 'admitted',
    datatype: parsed.datatype,
    value: { type: 'value', content: structuredClone(parsed.content) },
  };
}
