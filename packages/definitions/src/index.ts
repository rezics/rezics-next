/// <reference path="./recheck.d.ts" />
import { validateFilter, type FilterDocument, type FilterValidationError } from '@rezics/filter';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { checkSync } from 'recheck/lib/browser.js';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { libraryProfileSemantics, type LibraryProfile, type LibraryProfileReference } from './library-profile.ts';
export type {
  LibraryLabels,
  LibraryProgressMode,
  LibraryProgressUnit,
  LibraryProfile,
  LibraryProfileReference,
  LibraryProfilePin,
  LibraryProfileSource,
} from './library-profile.ts';

export const RELEASE_FORMAT = 'https://rezics.com/definitions/release/1';
// Headroom over the bundled catalogue plus 100 launch-grain verticals (3 types and 12 properties each).
export const RELEASE_LIMITS = {
  types: 1024,
  properties: 4096,
  propertiesPerType: 64,
  facetsPerType: 16,
  contexts: 256,
  defaultsPerContext: 64,
  bytes: 4 * 1024 * 1024,
} as const;
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
  descriptions?: Record<string, string>;
  mappings: string[];
  bases: string[];
  properties: string[];
  facets: string[];
  coverRatio?: string;
  /** Explicit https://schema.org/Type IRI used as JSON-LD @type; absent in older releases. */
  schemaOrgType?: string;
  library?: LibraryProfileReference;
};
export type RelationGroup =
  | 'order'
  | 'derivation'
  | 'world'
  | 'membership'
  | 'association'
  | 'credit'
  | 'appearance'
  | 'classification';
export type RelationDefinition = {
  group: RelationGroup;
  inverse?: string;
  inverseLabels?: Record<string, string>;
  symmetric?: true;
  acyclic?: true;
  order?: 'position' | 'date' | 'name';
  filter?: string | string[];
  slotKey?: string;
};
export type PropertyDefinition = {
  iri: string;
  labels: Record<string, string>;
  relation?: RelationDefinition;
  disclosure?: 'sourceOrConsent';
  descriptions?: Record<string, string>;
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
export type SavedFilter = {
  labels: Record<string, string>;
  filter: FilterDocument;
};
export type Release = {
  format: typeof RELEASE_FORMAT;
  catalogue: { id: string; version: string };
  generator: { name: string; version: string };
  prefixes: Record<string, string>;
  types: Record<string, TypeDefinition>;
  properties: Record<string, PropertyDefinition>;
  contexts?: Record<string, ContextSettings>;
  filters?: Record<string, SavedFilter>;
  libraryProfiles?: Record<string, LibraryProfile>;
};
export type ReleaseViolation = { pointer: string; code: 'invalid' | 'unsafe_pattern' | 'limit' };

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const subjectIdPattern = new RegExp(UUID);
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
          lowerBound: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
          upperBound: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
          unit: options.units?.includes('*')
            ? { type: 'string', pattern: `^(?:1|${schema.$defs.iri.pattern})$` }
            : { enum: [...(options.units ?? [])] },
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

/** A code facet is a string property whose release definition declares a pattern. */
function codeFacet(property: { datatype: string; value: object }): boolean {
  if (property.datatype !== 'string' || !record(property.value)) return false;
  const pattern = property.value.pattern;
  return typeof pattern === 'string' && pattern.length > 0;
}

function facetable(property: { datatype: string; value: object }): boolean {
  return (
    property.datatype === 'wikibase-item' ||
    property.datatype === 'time' ||
    property.datatype === 'quantity' ||
    codeFacet(property)
  );
}
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function collectionLimits(value: unknown, add: (pointer: string, code: ReleaseViolation['code']) => void) {
  if (!record(value)) return;
  if (record(value.types)) {
    if (Object.keys(value.types).length > RELEASE_LIMITS.types) add('/types', 'limit');
    else
      for (const [key, type] of Object.entries(value.types)) {
        if (record(type) && Array.isArray(type.properties) && type.properties.length > RELEASE_LIMITS.propertiesPerType)
          add(at(at('/types', key), 'properties'), 'limit');
        if (record(type) && Array.isArray(type.facets) && type.facets.length > RELEASE_LIMITS.facetsPerType)
          add(at(at('/types', key), 'facets'), 'limit');
      }
  }
  if (record(value.properties) && Object.keys(value.properties).length > RELEASE_LIMITS.properties)
    add('/properties', 'limit');
  if (record(value.contexts)) {
    if (Object.keys(value.contexts).length > RELEASE_LIMITS.contexts) add('/contexts', 'limit');
    else
      for (const [key, settings] of Object.entries(value.contexts))
        if (
          record(settings) &&
          record(settings.defaults) &&
          Object.keys(settings.defaults).length > RELEASE_LIMITS.defaultsPerContext
        )
          add(at(at('/contexts', key), 'defaults'), 'limit');
  }
  if (record(value.filters)) {
    const keys = Object.keys(value.filters);
    if (keys.length > 1024) add('/filters', 'limit');
    else {
      const counts = new Map<string, number>();
      for (const key of keys) {
        const slash = key.indexOf('/');
        if (slash <= 0) continue;
        const group = key.slice(0, slash);
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
      for (const [group, count] of counts) if (count > 64) add(at('/filters', group), 'limit');
    }
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
    if (bytes > RELEASE_LIMITS.bytes) return true;
  }
  return false;
}

function semantics(release: Release, add: (pointer: string, code?: ReleaseViolation['code']) => void) {
  for (const [key, profile] of Object.entries(release.libraryProfiles ?? {})) {
    const pointer = at('/libraryProfiles', key);
    if (key !== profile.id) add(at(pointer, 'id'));
    libraryProfileSemantics(profile, (child) => add(pointer + child));
  }
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
    if (
      type.library &&
      (type.library.profileId === 'legacy-fixed-v1' ||
        !release.libraryProfiles ||
        !own(release.libraryProfiles, type.library.profileId))
    )
      add(at(pointer, 'library'));
    list(type.properties, at(pointer, 'properties'), release.properties);
    type.bases.forEach((base, index) => {
      if (expand(base) === undefined) add(at(at(pointer, 'bases'), index));
    });
    type.facets.forEach((facet, index) => {
      const facetPointer = at(at(pointer, 'facets'), index);
      const property = release.properties[facet];
      if (expand(facet) === undefined || !type.properties.includes(facet) || !property || !facetable(property))
        add(facetPointer);
    });
  }
  const targetNames = new Set(Object.keys(release.types));
  for (const type of Object.values(release.types)) for (const base of type.bases) targetNames.add(base);
  const propertyIris = new Set(Object.values(release.properties).map((property) => property.iri));
  for (const [key, property] of Object.entries(release.properties)) {
    const pointer = at('/properties', key);
    list(property.qualifiers, at(pointer, 'qualifiers'), release.properties);
    const relation = property.relation;
    if (relation) {
      const relationPointer = at(pointer, 'relation');
      if (property.datatype !== 'wikibase-item') add(relationPointer);
      const hasInverse = own(relation, 'inverse');
      const hasSymmetric = own(relation, 'symmetric');
      if (hasInverse === hasSymmetric) add(relationPointer);
      const inverse = relation.inverse;
      if (typeof inverse === 'string' && inverse !== 'none') {
        const inverseIri = expand(inverse);
        if (inverseIri === undefined || own(release.properties, inverse) || propertyIris.has(inverseIri))
          add(at(relationPointer, 'inverse'));
        if (!own(relation, 'inverseLabels')) add(at(relationPointer, 'inverseLabels'));
      } else if (own(relation, 'inverseLabels')) add(at(relationPointer, 'inverseLabels'));
      if (hasSymmetric && own(relation, 'acyclic')) add(at(relationPointer, 'acyclic'));
      if (relation.order === 'position' && !property.qualifiers.includes('schema:position'))
        add(at(relationPointer, 'order'));
      if (relation.filter !== undefined) {
        const filters = Array.isArray(relation.filter) ? relation.filter : [relation.filter];
        for (const filter of filters) {
          const qualifier = release.properties[filter];
          if (!property.qualifiers.includes(filter) || qualifier?.datatype !== 'wikibase-item')
            add(at(relationPointer, 'filter'));
        }
      }
      if (relation.slotKey !== undefined) {
        const qualifier = release.properties[relation.slotKey];
        if (!property.qualifiers.includes(relation.slotKey) || qualifier?.datatype !== 'wikibase-item')
          add(at(relationPointer, 'slotKey'));
      }
    }
    for (const member of ['targets', 'units', 'minimum', 'maximum'] as const) {
      const allowed = member === 'targets' ? property.datatype === 'wikibase-item' : property.datatype === 'quantity';
      const required = member === 'targets' || member === 'units';
      if ((!allowed && own(property, member)) || (allowed && required && !own(property, member)))
        add(at(pointer, member));
    }
    if (property.targets) {
      const targetPointer = at(pointer, 'targets');
      list(property.targets, targetPointer);
      property.targets.forEach((target, index) => {
        if (!targetNames.has(target)) add(at(targetPointer, index));
      });
    }
    if (property.units) {
      list(property.units, at(pointer, 'units'), undefined, false);
      if (property.units.includes('*') && property.units.length !== 1) add(at(pointer, 'units'));
    }
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
  // A shipped filter names types, facets, years and amounts. Subject ids differ per deployment.
  for (const [key, saved] of Object.entries(release.filters ?? {})) {
    const filterPointer = at(at('/filters', key), 'filter');
    for (const error of validateFilter(saved.filter, release, { saved: false }))
      add(`${filterPointer}${error.pointer}`, savedFilterCode(error));
    visitSubjectIds(saved.filter, filterPointer, (pointer) => add(pointer));
  }
}

function savedFilterCode(error: FilterValidationError): ReleaseViolation['code'] {
  return error.problem === 'unsupported_query' && error.code === 'out_of_range' ? 'limit' : 'invalid';
}

function visitSubjectIds(value: unknown, pointer: string, add: (pointer: string) => void): void {
  if (typeof value === 'string') {
    if (subjectIdPattern.test(value)) add(pointer);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) visitSubjectIds(value[index], at(pointer, index), add);
    return;
  }
  if (!record(value)) return;
  for (const key of Object.keys(value)) visitSubjectIds(value[key], at(pointer, key), add);
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
