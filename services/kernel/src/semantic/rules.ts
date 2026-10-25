import type { PropertyDefinition, Release } from '@rezics/definitions';
import { Compile } from 'typebox/schema';
import { issuePointers } from '../http/problem.ts';
import type { Violation } from './item.ts';

export type ItemTarget = { pointer: string; id: string; targets: readonly string[] };

const validators = new Map<string, Map<string, ReturnType<typeof Compile>>>();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

function validator(digest: string, id: string, property: PropertyDefinition) {
  let properties = validators.get(digest);
  if (!properties) {
    properties = new Map();
    validators.set(digest, properties);
  }
  let compiled = properties.get(id);
  if (!compiled) {
    compiled = Compile(property.value);
    properties.set(id, compiled);
  }
  return compiled;
}

// Keep the significant digits and decimal point position separate, including for
// bounds that String(number) writes in scientific notation. Amounts stay strings.
function decimal(value: string) {
  const [coefficient, exponent = '0'] = value.toLowerCase().split('e');
  const unsigned = coefficient!.replace(/^[+-]/, '');
  const point = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '').replace(/^0+/, '');
  const leading = unsigned.replace('.', '').length - digits.length;
  return {
    negative: coefficient!.startsWith('-') && digits.length > 0,
    digits,
    position: (point === -1 ? unsigned.length : point) - leading + Number(exponent),
  };
}

function compareDecimal(left: string, right: string): number {
  const a = decimal(left);
  const b = decimal(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  let magnitude = 0;
  if (!a.digits.length || !b.digits.length) magnitude = Math.sign(a.digits.length - b.digits.length);
  else if (a.position !== b.position) magnitude = Math.sign(a.position - b.position);
  else {
    const length = Math.max(a.digits.length, b.digits.length);
    const x = a.digits.padEnd(length, '0');
    const y = b.digits.padEnd(length, '0');
    magnitude = x === y ? 0 : x < y ? -1 : 1;
  }
  return a.negative ? -magnitude : magnitude;
}

function dateExists(time: string, precision: number): boolean {
  const match = /^[+-]([0-9]{4,})-([0-9]{2})-([0-9]{2})T00:00:00Z$/.exec(time);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (precision === 9) return month === 0 && day === 0;
  if (month < 1 || month > 12) return false;
  if (precision === 10) return day === 0;
  // Divisibility by 400, 100 and 4 depends only on the last four year digits.
  const year = Number(match[1]!.slice(-4));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return precision === 11 && day >= 1 && day <= days[month - 1]!;
}

export function checkTyped(
  release: Release,
  digest: string,
  input: unknown,
): { violations: Violation[]; items: ItemTarget[] } {
  const violations: Violation[] = [];
  const items: ItemTarget[] = [];
  const result = { violations, items };
  const add = (pointer: string, code: Violation['code']) => {
    if (violations.length < 16) violations.push({ pointer, code });
  };
  if (!record(input)) return result;
  if (input.type === undefined) add('/type', 'required');
  else if (typeof input.type !== 'string') add('/type', 'invalid_type');
  else if (!Object.hasOwn(release.types, input.type)) add('/type', 'unsupported');
  if (violations.length) return result;
  const type = release.types[input.type as string]!;
  if (!record(input.statements)) return result;

  const checkValue = (raw: Record<string, unknown>, property: PropertyDefinition, id: string, path: string) => {
    if (!record(raw.value) || raw.value.type !== 'value' || !Object.hasOwn(raw.value, 'content')) return;
    const content = raw.value.content;
    const pointer = `${path}/value/content`;
    if (property.datatype === 'document' || property.datatype === 'media') {
      add(pointer, 'unsupported');
      return;
    }
    const compiled = validator(digest, id, property);
    if (!compiled.Check(content)) {
      const [, errors] = compiled.Errors(content);
      for (const error of errors) for (const field of issuePointers(error)) add(pointer + field.pointer, field.code);
      return;
    }
    if (property.datatype === 'quantity' && record(content) && typeof content.amount === 'string') {
      if (
        (property.minimum !== undefined && compareDecimal(content.amount, String(property.minimum)) < 0) ||
        (property.maximum !== undefined && compareDecimal(content.amount, String(property.maximum)) > 0)
      )
        add(`${pointer}/amount`, 'out_of_range');
    } else if (
      property.datatype === 'time' &&
      record(content) &&
      typeof content.time === 'string' &&
      typeof content.precision === 'number'
    ) {
      if (!dateExists(content.time, content.precision)) add(`${pointer}/time`, 'invalid_format');
    } else if (property.datatype === 'wikibase-item' && typeof content === 'string') {
      items.push({ pointer, id: content, targets: property.targets! });
    }
  };
  const propertyId = (raw: unknown): string | undefined =>
    record(raw) && record(raw.property) && typeof raw.property.id === 'string' ? raw.property.id : undefined;
  const checkPart = (raw: unknown, path: string, allowed?: readonly string[]) => {
    const id = propertyId(raw);
    if (id === undefined) return;
    if (!Object.hasOwn(release.properties, id) || (allowed && !allowed.includes(id))) {
      add(`${path}/property/id`, 'unsupported');
      return;
    }
    checkValue(raw as Record<string, unknown>, release.properties[id]!, id, path);
  };

  for (const [id, list] of Object.entries(input.statements)) {
    const path = at('/statements', id);
    if (!type.properties.includes(id)) {
      add(path, 'unsupported');
      continue;
    }
    if (!Array.isArray(list)) continue;
    const property = release.properties[id]!;
    list.forEach((statement, index) => {
      if (!record(statement) || propertyId(statement) !== id) return;
      const pointer = at(path, index);
      if (statement.rank === 'deprecated') add(`${pointer}/rank`, 'unsupported');
      if (!property.multivalued && index > 0) add(pointer, 'out_of_range');
      checkValue(statement, property, id, pointer);
      if (Array.isArray(statement.qualifiers))
        statement.qualifiers.forEach((qualifier, j) =>
          checkPart(qualifier, `${pointer}/qualifiers/${j}`, property.qualifiers),
        );
      if (Array.isArray(statement.references))
        statement.references.forEach((reference, k) => {
          if (record(reference) && Array.isArray(reference.parts))
            reference.parts.forEach((part, m) => checkPart(part, `${pointer}/references/${k}/parts/${m}`));
        });
    });
  }
  return result;
}
