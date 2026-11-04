import { createHash } from 'node:crypto';

export const bangumiCharacterMeasurementLimits = Object.freeze({
  sourceBytes: 65_536,
  maxTemplateDepth: 2,
  maxFields: 64,
  maxDiagnostics: 16,
  maxValueCodeUnits: 128,
  maxQuantityCharacters: 64,
  maxQuantityFacts: 2,
});

const centimeter = 'http://www.wikidata.org/entity/Q174728';
const meter = 'http://www.wikidata.org/entity/Q11573';
const kilogram = 'http://www.wikidata.org/entity/Q11570';
const gram = 'http://www.wikidata.org/entity/Q41803';

type MeasurementField = 'height' | 'weight';
type PhysicalField = MeasurementField | 'bloodType';
type Quantity = Readonly<{ amount: string; unit: string }>;

export type BangumiCharacterPhysicalEvidence = Readonly<{
  field: PhysicalField;
  pointer: string;
  outcome: 'quantity' | 'unknown' | 'unavailable';
  sourceValue?: string;
  sourceValueBytes?: number;
  sourceValueDigest?: string;
  quantity?: Quantity;
}>;

export type BangumiCharacterMeasurement = Readonly<{
  field: MeasurementField;
  pointer: string;
  sourceValue: string;
  property: 'schema:height' | 'schema:weight';
  quantity: Quantity;
}>;

export type BangumiCharacterMeasurementProjection = Readonly<{
  measurements: readonly BangumiCharacterMeasurement[];
  evidence: readonly BangumiCharacterPhysicalEvidence[];
  diagnostics: readonly Readonly<{ pointer: string; code: string }>[];
}>;

type Line = Readonly<{ text: string; start: number; end: number }>;
type Occurrence = {
  field: PhysicalField;
  pointer: string;
  valueStart: number;
  valueEnd: number;
  sourceValue?: string;
  sourceValueBytes: number;
  sourceValueDigest?: string;
  nested: boolean;
  continued: boolean;
};

const fieldNames: Readonly<Record<string, PhysicalField | 'birthday' | 'bwh'>> = {
  身高: 'height',
  体重: 'weight',
  血型: 'bloodType',
  生日: 'birthday',
  BWH: 'bwh',
};
const unknownValues = new Set(['?', '未知', '不明', '不详', '不詳']);
const numericValue = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const quantityValue = /^([0-9]+(?:\.[0-9]+)?)[\t ]*([^\d\t ]+)$/u;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;
const unitRows = [
  { unit: centimeter, names: ['cm', '厘米', '公分'] },
  { unit: meter, names: ['m', '米', '公尺'] },
  { unit: kilogram, names: ['kg', '千克', '公斤'] },
  { unit: gram, names: ['g', '克', '公克'] },
] as const;

function* lines(source: string): Generator<Line> {
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    let text = source.slice(start, end);
    let logicalEnd = end;
    if (text.endsWith('\r')) {
      text = text.slice(0, -1);
      logicalEnd--;
    }
    yield { text, start, end: logicalEnd };
    if (newline === -1) return;
    start = newline + 1;
  }
}

function rawSliceEvidence(source: string, start: number, end: number) {
  const size = end - start;
  if (size <= bangumiCharacterMeasurementLimits.maxValueCodeUnits) {
    const sourceValue = source.slice(start, end);
    return { sourceValue, sourceValueBytes: Buffer.byteLength(sourceValue, 'utf8') };
  }

  const sourceValue = source.slice(start, end);
  return {
    sourceValueBytes: Buffer.byteLength(sourceValue, 'utf8'),
    sourceValueDigest: createHash('sha256').update(sourceValue, 'utf8').digest('hex'),
  };
}

function diagnosticsSink() {
  const diagnostics: { pointer: string; code: string }[] = [];
  let overflow = false;
  return {
    diagnostics,
    add(pointer: string, code: string) {
      if (diagnostics.length < bangumiCharacterMeasurementLimits.maxDiagnostics - 1) {
        diagnostics.push({ pointer, code });
      } else if (!overflow) {
        diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
        overflow = true;
      }
    },
  };
}

function braces(line: string, depth: number): { depth: number; exceeded: boolean; invalid: boolean } {
  let nextDepth = depth;
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith('{{', i)) {
      nextDepth++;
      if (nextDepth > bangumiCharacterMeasurementLimits.maxTemplateDepth) return { depth: nextDepth, exceeded: true, invalid: false };
      i++;
    } else if (line.startsWith('}}', i)) {
      nextDepth--;
      if (nextDepth < 1) return { depth: nextDepth, exceeded: false, invalid: true };
      i++;
    }
  }
  return { depth: nextDepth, exceeded: false, invalid: false };
}

function fieldForProperty(field: MeasurementField): 'schema:height' | 'schema:weight' {
  return field === 'height' ? 'schema:height' : 'schema:weight';
}

function quantityFor(field: MeasurementField, sourceValue: string): { quantity?: Quantity; code?: string } {
  const value = sourceValue.replace(horizontalSpace, '');
  if (!value || unknownValues.has(value)) return { code: 'unknown_source_value' };
  if (/^(?:about|approx(?:imately)?|circa|约|約|大约|大約)/iu.test(value)) return { code: 'approximate_quantity' };
  if (/[\-–—~～至到]/u.test(value)) return { code: 'quantity_range_unavailable' };
  if (value.includes('{{') || value.includes('}}') || value.includes('[[') || value.includes(']]') || value.includes('|'))
    return { code: 'unsupported_quantity_markup' };

  if (numericValue.test(value)) return { code: 'missing_explicit_unit' };
  const match = quantityValue.exec(value);
  if (!match) return { code: 'unsupported_quantity_format' };
  const amount = match[1]!;
  if (amount.length > bangumiCharacterMeasurementLimits.maxQuantityCharacters) return { code: 'quantity_length_limit' };
  if (!numericValue.test(amount)) return { code: 'invalid_quantity_value' };

  const rawUnit = match[2]!;
  const unitName = /^[a-z]+$/iu.test(rawUnit) ? rawUnit.toLowerCase() : rawUnit;
  const admittedUnit = unitRows.find((row) => (row.names as readonly string[]).includes(unitName));
  if (!admittedUnit) return { code: 'unsupported_quantity_unit' };
  const propertyUnits =
    field === 'height'
      ? new Set([centimeter, meter])
      : new Set([kilogram, gram]);
  if (!propertyUnits.has(admittedUnit.unit)) return { code: 'unit_not_admitted_for_field' };
  return { quantity: { amount: `+${amount}`, unit: admittedUnit.unit } };
}

/** Parses only the pinned, line-oriented Infobox Crt fields for physical profile evidence. */
export function projectBangumiCharacterMeasurements(infobox: unknown): BangumiCharacterMeasurementProjection {
  const sink = diagnosticsSink();
  const empty = (): BangumiCharacterMeasurementProjection => ({ measurements: [], evidence: [], diagnostics: sink.diagnostics });
  if (infobox === undefined || infobox === null) return empty();
  if (typeof infobox !== 'string' || !infobox.isWellFormed()) {
    sink.add('/infobox', 'unsupported_infobox_structure');
    return empty();
  }
  if (Buffer.byteLength(infobox, 'utf8') > bangumiCharacterMeasurementLimits.sourceBytes) {
    sink.add('/infobox', 'infobox_byte_limit');
    return empty();
  }

  const iterator = lines(infobox);
  let first: IteratorResult<Line>;
  do {
    first = iterator.next();
  } while (!first.done && !first.value.text.trim());
  if (first.done || first.value.text.trim() !== '{{Infobox Crt') {
    sink.add('/infobox', 'unsupported_infobox_template');
    return empty();
  }

  const occurrences: Occurrence[] = [];
  let fields = 0;
  let depth = 1;
  let active: Occurrence | undefined;
  let closed = false;
  let trailing = false;
  let stoppedAtDepthLimit = false;
  let stoppedAtFieldLimit = false;

  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value;
    const line = row.text.replace(horizontalSpace, '');
    if (!line) continue;
    if (depth === 1 && line === '}}') {
      active = undefined;
      depth = 0;
      closed = true;
      continue;
    }
    if (closed) {
      trailing = true;
      continue;
    }

    if (depth > 1) {
      const nested = braces(row.text, depth);
      if (active) active.nested = true;
      if (nested.exceeded) {
        sink.add(active?.pointer ?? '/infobox', 'infobox_depth_limit');
        stoppedAtDepthLimit = true;
        break;
      }
      if (nested.invalid) {
        sink.add('/infobox', 'unsupported_infobox_structure');
        stoppedAtDepthLimit = true;
        break;
      }
      depth = nested.depth;
      continue;
    }

    if (line.startsWith('|')) {
      active = undefined;
      fields++;
      if (fields > bangumiCharacterMeasurementLimits.maxFields) {
        sink.add('/infobox', 'infobox_field_limit');
        stoppedAtFieldLimit = true;
        break;
      }
      const equals = row.text.indexOf('=');
      const pointer = `/infobox/fields/${fields - 1}`;
      if (equals < 1) {
        sink.add(pointer, 'unsupported_infobox_structure');
        continue;
      }
      const key = row.text.slice(1, equals).replace(horizontalSpace, '');
      const field = fieldNames[key];
      if (!field) {
        sink.add(pointer, 'unsupported_infobox_field');
        const nested = braces(row.text, depth);
        if (nested.exceeded) {
          sink.add(pointer, 'infobox_depth_limit');
          stoppedAtDepthLimit = true;
          break;
        }
        if (nested.invalid) {
          sink.add('/infobox', 'unsupported_infobox_structure');
          stoppedAtDepthLimit = true;
          break;
        }
        depth = nested.depth;
        continue;
      }
      if (field === 'birthday' || field === 'bwh') {
        sink.add(pointer, field === 'birthday' ? 'omitted_partial_or_fictional_birthday' : 'omitted_composite_bwh');
        const nested = braces(row.text, depth);
        if (nested.exceeded) {
          sink.add(pointer, 'infobox_depth_limit');
          stoppedAtDepthLimit = true;
          break;
        }
        if (nested.invalid) {
          sink.add('/infobox', 'unsupported_infobox_structure');
          stoppedAtDepthLimit = true;
          break;
        }
        depth = nested.depth;
        continue;
      }
      const valueStart = row.start + equals + 1;
      const valueEnd = row.end;
      const raw = rawSliceEvidence(infobox, valueStart, valueEnd);
      active = {
        field,
        pointer,
        valueStart,
        valueEnd,
        ...raw,
        nested: false,
        continued: false,
      };
      occurrences.push(active);
      const nested = braces(row.text, depth);
      if (nested.exceeded) {
        active.nested = true;
        sink.add(pointer, 'infobox_depth_limit');
        stoppedAtDepthLimit = true;
        break;
      }
      if (nested.invalid) {
        active.nested = true;
        sink.add(pointer, 'unsupported_infobox_structure');
        stoppedAtDepthLimit = true;
        break;
      }
      if (nested.depth > depth) active.nested = true;
      depth = nested.depth;
      continue;
    }

    if (active) active.continued = true;
    else sink.add(`/infobox/lines/${row.start}`, 'unsupported_infobox_structure');
    const nested = braces(row.text, depth);
    if (nested.exceeded) {
      sink.add(active?.pointer ?? '/infobox', 'infobox_depth_limit');
      stoppedAtDepthLimit = true;
      break;
    }
    if (nested.invalid) {
      sink.add('/infobox', 'unsupported_infobox_structure');
      stoppedAtDepthLimit = true;
      break;
    }
    if (nested.depth > depth && active) active.nested = true;
    depth = nested.depth;
  }

  if (!closed && !stoppedAtDepthLimit) sink.add('/infobox', 'unsupported_infobox_structure');
  if (trailing) sink.add('/infobox', 'unsupported_infobox_structure');
  const complete = closed && !trailing && !stoppedAtDepthLimit && !stoppedAtFieldLimit;

  const counts = new Map<PhysicalField, number>();
  for (const occurrence of occurrences) counts.set(occurrence.field, (counts.get(occurrence.field) ?? 0) + 1);
  const evidence: BangumiCharacterPhysicalEvidence[] = [];
  const measurements: BangumiCharacterMeasurement[] = [];
  for (const occurrence of occurrences) {
    const duplicate = counts.get(occurrence.field)! > 1;
    const sourceValue = occurrence.sourceValue;
    let outcome: BangumiCharacterPhysicalEvidence['outcome'] = 'unavailable';
    let quantity: Quantity | undefined;
    if (!complete) sink.add(occurrence.pointer, 'incomplete_infobox_unavailable');
    else if (duplicate) sink.add(occurrence.pointer, 'duplicate_physical_field');
    else if (occurrence.sourceValueDigest) sink.add(occurrence.pointer, 'quantity_text_limit');
    else if (occurrence.nested || occurrence.continued || sourceValue === undefined)
      sink.add(occurrence.pointer, 'unsupported_infobox_value');
    else if (occurrence.field === 'bloodType') {
      const normalized = sourceValue.replace(horizontalSpace, '');
      if (!normalized || unknownValues.has(normalized)) {
        outcome = 'unknown';
        if (normalized) sink.add(occurrence.pointer, 'unknown_source_value');
      } else sink.add(occurrence.pointer, 'blood_type_concept_binding_unavailable');
    } else {
      const parsed = quantityFor(occurrence.field, sourceValue);
      if (parsed.quantity) {
        outcome = 'quantity';
        quantity = parsed.quantity;
        measurements.push({
          field: occurrence.field,
          pointer: occurrence.pointer,
          sourceValue,
          property: fieldForProperty(occurrence.field),
          quantity,
        });
      } else {
        if (parsed.code !== 'unknown_source_value') sink.add(occurrence.pointer, parsed.code ?? 'unsupported_quantity_format');
        else if (sourceValue.replace(horizontalSpace, '')) sink.add(occurrence.pointer, parsed.code);
        outcome = parsed.code === 'unknown_source_value' ? 'unknown' : 'unavailable';
      }
    }
    evidence.push({
      field: occurrence.field,
      pointer: occurrence.pointer,
      outcome,
      ...(sourceValue === undefined ? {} : { sourceValue }),
      ...(occurrence.sourceValueBytes === 0 ? {} : { sourceValueBytes: occurrence.sourceValueBytes }),
      ...(occurrence.sourceValueDigest ? { sourceValueDigest: occurrence.sourceValueDigest } : {}),
      ...(quantity ? { quantity } : {}),
    });
  }

  return { measurements: measurements.slice(0, bangumiCharacterMeasurementLimits.maxQuantityFacts), evidence, diagnostics: sink.diagnostics };
}
