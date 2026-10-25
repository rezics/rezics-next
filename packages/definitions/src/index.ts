/// <reference path="./recheck.d.ts" />
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { checkSync } from 'recheck/lib/browser.js';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';

export const RELEASE_FORMAT = 'https://rezics.com/definitions/release/1';
export const DATA_TYPES = [
  'wikibase-item',
  'string',
  'external-id',
  'url',
  'monolingualtext',
  'quantity',
  'time',
  'document',
  'media',
] as const;
export type DataType = (typeof DATA_TYPES)[number];
export type TypeDefinition = {
  iri: string;
  labels: Record<string, string>;
  mappings: string[];
  bases: string[];
  properties: string[];
  facets: string[];
};
export type PropertyDefinition = {
  iri: string;
  labels: Record<string, string>;
  mappings: string[];
  datatype: DataType;
  multivalued: boolean;
  targets?: string[];
  units?: string[];
  minimum?: number;
  maximum?: number;
  qualifiers: string[];
  value: object;
};
export type ContextSettings = {
  labels: Record<string, string>;
  defaults: Record<string, 'inherit' | 'suppress'>;
};
export type Release = {
  format: typeof RELEASE_FORMAT;
  catalogue: { id: string; version: string };
  generator: { name: string; version: string };
  prefixes: Record<string, string>;
  types: Record<string, TypeDefinition>;
  properties: Record<string, PropertyDefinition>;
  contexts?: Record<string, ContextSettings>;
};
export type ReleaseViolation = { pointer: string; code: 'invalid' | 'unsafe_pattern' | 'limit' };

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const INTEGER = '^[+-](?:0|[1-9][0-9]*)$';
const DECIMAL = '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$';
type ValueOptions = { pattern?: string; units?: string[]; integer?: boolean };

export function valueSchema(
  datatype: 'monolingualtext',
  options?: ValueOptions,
): Extract<ReturnType<typeof buildValueSchema>, { properties: { text: object } }>;
export function valueSchema(datatype: DataType, options?: ValueOptions): ReturnType<typeof buildValueSchema>;
export function valueSchema(datatype: DataType, options: ValueOptions = {}) {
  return buildValueSchema(datatype, options);
}

function buildValueSchema(datatype: DataType, options: ValueOptions) {
  if (
    (datatype === 'document' || datatype === 'media') &&
    (options.units !== undefined || options.integer !== undefined)
  )
    throw new TypeError(`Quantity options are not supported for ${datatype}`);
  if (options.pattern !== undefined && !['string', 'external-id', 'monolingualtext'].includes(datatype))
    throw new TypeError(`Patterns are not supported for ${datatype}`);
  const text = {
    type: 'string',
    minLength: 1,
    maxLength: 1500,
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  };
  switch (datatype) {
    case 'media':
      return { type: 'string', pattern: `${UUID}(?![\\s\\S])` };
    case 'wikibase-item':
      return { type: 'string', pattern: UUID };
    case 'string':
    case 'external-id':
      return text;
    case 'url':
      return { type: 'string', maxLength: 1500, pattern: '^https?://[^\\s]+$' };
    case 'monolingualtext':
      return {
        type: 'object',
        required: ['text', 'language'],
        additionalProperties: false,
        properties: { text, language: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' } },
      };
    case 'document':
      return {
        type: 'object',
        required: ['language', 'document'],
        additionalProperties: false,
        properties: {
          language: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' },
          document: { type: 'object' },
        },
      };
    case 'quantity':
      return {
        type: 'object',
        required: ['amount', 'unit'],
        additionalProperties: false,
        properties: {
          amount: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
          unit: { enum: [...(options.units ?? [])] },
        },
      };
    case 'time':
      return {
        type: 'object',
        required: ['time', 'precision', 'calendarmodel'],
        additionalProperties: false,
        properties: {
          time: { type: 'string', pattern: '^[+-][0-9]{4,}-[0-9]{2}-[0-9]{2}T00:00:00Z$' },
          precision: { enum: [9, 10, 11] },
          calendarmodel: { const: 'http://www.wikidata.org/entity/Q1985727' },
        },
      };
    default:
      throw new TypeError(`Unknown data type: ${datatype}`);
  }
}

export function releaseDigest(release: Release): string {
  return `sha256:${createHash('sha256').update(canonicalize(release)!, 'utf8').digest('hex')}`;
}

const validator = Compile(schema);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function collectionLimits(value: unknown, add: (pointer: string, code: ReleaseViolation['code']) => void) {
  if (!record(value)) return;
  if (record(value.types)) {
    if (Object.keys(value.types).length > 256) add('/types', 'limit');
    else
      for (const [key, type] of Object.entries(value.types)) {
        if (record(type) && Array.isArray(type.properties) && type.properties.length > 64)
          add(at(at('/types', key), 'properties'), 'limit');
        if (record(type) && Array.isArray(type.facets) && type.facets.length > 16)
          add(at(at('/types', key), 'facets'), 'limit');
      }
  }
  if (record(value.properties) && Object.keys(value.properties).length > 1024) add('/properties', 'limit');
  if (record(value.contexts)) {
    if (Object.keys(value.contexts).length > 256) add('/contexts', 'limit');
    else
      for (const [key, settings] of Object.entries(value.contexts))
        if (record(settings) && record(settings.defaults) && Object.keys(settings.defaults).length > 64)
          add(at(at('/contexts', key), 'defaults'), 'limit');
  }
}

// Canonical ordering does not change byte length. Count JSON bytes before sorting
// keys or compiling schema errors, and stop as soon as the size bound is crossed.
function exceedsSize(value: unknown): boolean {
  const pending = [value];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        if (!Array.isArray(item)) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        pending.push(child);
      }
    } else {
      const json = JSON.stringify(item);
      if (json === undefined || (typeof item === 'number' && !Number.isFinite(item)))
        throw new TypeError('Expected JSON');
      bytes += Buffer.byteLength(json);
    }
    if (bytes > 1024 * 1024) return true;
  }
  return false;
}

function semantics(release: Release, add: (pointer: string, code?: ReleaseViolation['code']) => void) {
  const expand = (curie: string): string | undefined => {
    const match = /^([a-z][a-z0-9_]*):([^\s]+)$(?![\s\S])/u.exec(curie);
    return match && own(release.prefixes, match[1]!) ? release.prefixes[match[1]!] + match[2]! : undefined;
  };
  const list = (items: string[], pointer: string, references?: object, curies = true) => {
    items.forEach((item, index) => {
      if (
        (index > 0 && items[index - 1]! >= item) ||
        (curies && expand(item) === undefined) ||
        (references && !own(references, item))
      )
        add(at(pointer, index));
    });
  };
  // Cache only within this validation, bounding memory across untrusted releases.
  const safety = new Map<string, boolean>();
  const patterns = (value: unknown, pointer: string) => {
    const pending = [{ value, pointer }];
    while (pending.length) {
      const current = pending.pop()!;
      if (!record(current.value)) continue;
      for (const [key, child] of Object.entries(current.value)) {
        const childPointer = at(current.pointer, key);
        if (key === 'pattern' && typeof child === 'string') {
          let safe = safety.get(child);
          if (safe === undefined) {
            safe = false;
            if (child.length <= 256) {
              try {
                new RegExp(child, 'u');
                safe = checkSync(child, 'u', { timeout: 3000 }).status === 'safe';
              } catch {
                /* Checker failures are unsafe, too. */
              }
            }
            safety.set(child, safe);
          }
          if (!safe) add(childPointer, 'unsafe_pattern');
        } else if (record(child)) pending.push({ value: child, pointer: childPointer });
      }
    }
  };
  for (const [collection, definitions] of [
    ['types', release.types],
    ['properties', release.properties],
  ] as const) {
    for (const [key, definition] of Object.entries(definitions)) {
      const pointer = at(`/${collection}`, key);
      const expanded = expand(key);
      if (expanded === undefined) add(pointer);
      else if (definition.iri !== expanded) add(at(pointer, 'iri'));
      list(definition.mappings, at(pointer, 'mappings'));
    }
  }
  for (const [key, type] of Object.entries(release.types)) {
    const pointer = at('/types', key);
    list(type.properties, at(pointer, 'properties'), release.properties);
    type.bases.forEach((base, index) => {
      if (expand(base) === undefined) add(at(at(pointer, 'bases'), index));
    });
    type.facets.forEach((facet, index) => {
      const facetPointer = at(at(pointer, 'facets'), index);
      const property = release.properties[facet];
      if (
        expand(facet) === undefined ||
        !type.properties.includes(facet) ||
        !property ||
        !['wikibase-item', 'time', 'quantity'].includes(property.datatype)
      )
        add(facetPointer);
    });
  }
  for (const [key, property] of Object.entries(release.properties)) {
    const pointer = at('/properties', key);
    list(property.qualifiers, at(pointer, 'qualifiers'), release.properties);
    for (const member of ['targets', 'units', 'minimum', 'maximum'] as const) {
      const allowed = member === 'targets' ? property.datatype === 'wikibase-item' : property.datatype === 'quantity';
      const required = member === 'targets' || member === 'units';
      if ((!allowed && own(property, member)) || (allowed && required && !own(property, member)))
        add(at(pointer, member));
    }
    if (property.targets) list(property.targets, at(pointer, 'targets'), release.types);
    if (property.units) list(property.units, at(pointer, 'units'), undefined, false);
    if (property.minimum !== undefined && property.maximum !== undefined && property.maximum < property.minimum)
      add(at(pointer, 'maximum'));
    const value = property.value as Record<string, unknown>;
    const fields = record(value.properties) ? value.properties : {};
    const text = record(fields.text) ? fields.text : {};
    const amount = record(fields.amount) ? fields.amount : {};
    const pattern = property.datatype === 'monolingualtext' ? text.pattern : value.pattern;
    const options: ValueOptions = {};
    if (['string', 'external-id', 'monolingualtext'].includes(property.datatype) && typeof pattern === 'string')
      options.pattern = pattern;
    if (property.datatype === 'quantity') {
      if (property.units) options.units = property.units;
      options.integer = amount.pattern === INTEGER;
    }
    if (canonicalize(value) !== canonicalize(valueSchema(property.datatype, options))) add(at(pointer, 'value'));
    patterns(value, at(pointer, 'value'));
  }
  for (const [id, settings] of Object.entries(release.contexts ?? {}))
    for (const property of Object.keys(settings.defaults))
      if (!own(release.properties, property)) add(at(at(at('/contexts', id), 'defaults'), property));
}

export function validateRelease(value: unknown): ReleaseViolation[] {
  const violations = new Map<string, ReleaseViolation['code']>();
  const add = (pointer: string, code: ReleaseViolation['code'] = 'invalid') => {
    if (!violations.has(pointer)) violations.set(pointer, code);
  };
  const result = () =>
    [...violations]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 64)
      .map(([pointer, code]) => ({ pointer, code }));
  try {
    collectionLimits(value, add);
    if (violations.size) return result();
    if (exceedsSize(value)) return [{ pointer: '', code: 'limit' }];
    // JCS rejects malformed Unicode as well as non-finite JSON numbers.
    canonicalize(value);
    if (!validator.Check(value)) {
      const [, errors] = validator.Errors(value);
      for (const error of errors) {
        if (error.keyword === 'required') {
          for (const member of error.params.requiredProperties) add(at(error.instancePath, member));
        } else if (error.keyword === 'additionalProperties') {
          for (const member of error.params.additionalProperties) add(at(error.instancePath, member));
        } else add(error.instancePath);
      }
      if (!violations.size) add('');
      return result();
    }
    semantics(value as Release, add);
    return result();
  } catch {
    add('');
    return result();
  }
}
