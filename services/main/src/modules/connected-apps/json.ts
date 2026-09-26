import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export type SchemaValidation = 'valid' | 'invalid' | 'unsupported';

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** RFC 8785's property ordering and ECMAScript number serialization for JSON inputs. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('JSON nesting exceeds the canonicalization limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('JSON number cannot be represented canonically');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('value is not JSON');
}

const knownKeywords = new Set([
  '$schema', '$id', 'title', 'description', 'default', 'examples', 'type', 'properties',
  'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
]);
const primitiveTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * MCP schemas are arbitrary JSON Schema. This owner admits a deliberately small,
 * fully checked subset; valid-but-unimplemented keywords are recorded unsupported
 * and cannot be added to a consent ceiling.
 */
export function validateInputSchema(schema: unknown): SchemaValidation {
  try {
    if (!isObject(schema) || schema.type !== 'object') return 'invalid';
    return inspectSchema(schema, 0);
  } catch { return 'invalid'; }
}

function inspectSchema(schema: JsonObject, depth: number): SchemaValidation {
  if (depth > 32) return 'unsupported';
  let result: SchemaValidation = 'valid';
  for (const key of Object.keys(schema)) if (!knownKeywords.has(key)) result = 'unsupported';
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some(type => typeof type !== 'string' || !primitiveTypes.has(type))) {
      return 'invalid';
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return 'invalid';
    for (const child of Object.values(schema.properties)) {
      const status = inspectChild(child, depth + 1);
      result = combine(result, status);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some(value => typeof value !== 'string')
    || new Set(schema.required).size !== schema.required.length)) return 'invalid';
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    const status = inspectChild(schema.additionalProperties, depth + 1);
    result = combine(result, status);
  }
  if (schema.items !== undefined) result = combine(result, inspectChild(schema.items, depth + 1));
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 256)) return 'invalid';
  if (schema.const !== undefined) canonicalJson(schema.const);
  for (const name of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const bound = schema[name];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) return 'invalid';
  }
  for (const name of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const bound = schema[name];
    if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0
      || (bound as number) > 1_000_000)) return 'invalid';
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 256) return 'invalid';
    try { new RegExp(schema.pattern, 'u'); } catch { return 'invalid'; }
  }
  for (const key of ['title', 'description', '$schema', '$id'] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== 'string') return 'invalid';
  }
  for (const key of ['default'] as const) if (schema[key] !== undefined) canonicalJson(schema[key]);
  if (schema.examples !== undefined) {
    if (!Array.isArray(schema.examples) || schema.examples.length > 32) return 'invalid';
    for (const example of schema.examples) canonicalJson(example);
  }
  return result;
}

function inspectChild(value: unknown, depth: number): SchemaValidation {
  if (!isObject(value)) return 'invalid';
  return inspectSchema(value, depth);
}

function combine(left: SchemaValidation, right: SchemaValidation): SchemaValidation {
  if (left === 'invalid' || right === 'invalid') return 'invalid';
  if (left === 'unsupported' || right === 'unsupported') return 'unsupported';
  return 'valid';
}

/** Check tool arguments against the same admitted JSON Schema subset. */
export function argumentsMatch(schema: JsonObject, value: unknown): boolean {
  try { return matches(schema, value, 0); } catch { return false; }
}

function matches(schema: JsonObject, value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some(type => typeMatches(type, value))) return false;
  if (schema.enum && !(schema.enum as unknown[]).some(item => canonicalJson(item) === canonicalJson(value))) {
    return false;
  }
  if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) return false;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) return false;
    if (schema.maximum !== undefined && value > (schema.maximum as number)) return false;
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number)) return false;
    if (schema.exclusiveMaximum !== undefined && value >= (schema.exclusiveMaximum as number)) return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < (schema.minLength as number)) return false;
    if (schema.maxLength !== undefined && length > (schema.maxLength as number)) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string, 'u').test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) return false;
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) return false;
    if (isObject(schema.items) && !value.every(item => matches(schema.items as JsonObject, item, depth + 1))) {
      return false;
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    if (required.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (isObject(child)) {
        if (!matches(child, item, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (isObject(schema.additionalProperties)
        && !matches(schema.additionalProperties, item, depth + 1)) return false;
    }
  }
  return true;
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}
