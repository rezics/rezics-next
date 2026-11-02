import type { OwnerLeaf } from './owner-filter.ts';

export const FILTER_LIMITS = Object.freeze({ leaves: 32, depth: 4, or: 16, in: 64, qualifiers: 4 } as const);

export type FieldErrorCode =
  | 'required'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_format'
  | 'out_of_range'
  | 'unsupported';
export type FilterProblem = 'invalid_request' | 'unsupported_query';
export type FilterRange = { readonly gte?: number; readonly lte?: number; readonly unit?: string };
export type FilterQualifier = { readonly property: string; readonly in: readonly string[] };
export type FilterStatement =
  | { readonly property: string; readonly in: readonly string[]; readonly qualifiers?: readonly FilterQualifier[] }
  | { readonly property: string; readonly range: FilterRange; readonly qualifiers?: readonly FilterQualifier[] };

export type FilterDocument =
  | { readonly and: readonly FilterDocument[] }
  | { readonly or: readonly FilterDocument[] }
  | { readonly not: FilterDocument }
  | { readonly type: { readonly in: readonly string[] } }
  | { readonly statement: FilterStatement }
  | { readonly saved: string }
  | OwnerLeaf;

/** An exact native question identity. Definition revisions are resolved by the server. */
export type RatingQuestionLeaf = { readonly ratingQuestion: { readonly id: string } };

/** Opt-in discovery grammar. Catalogue/saved consumers retain FilterDocument. */
export type DiscoveryFilterDocument =
  | { readonly and: readonly DiscoveryFilterDocument[] }
  | { readonly or: readonly DiscoveryFilterDocument[] }
  | { readonly not: DiscoveryFilterDocument }
  | { readonly kind: { readonly in: readonly string[] } }
  | RatingQuestionLeaf
  | Exclude<FilterDocument, { readonly and: unknown } | { readonly or: unknown } | { readonly not: unknown }>;

function catalogueOnly(filter: DiscoveryFilterDocument): FilterDocument {
  if ('kind' in filter) throw new FilterError('invalid_request', '/kind', 'unknown_field');
  if ('ratingQuestion' in filter) throw new FilterError('invalid_request', '/ratingQuestion', 'unknown_field');
  if ('and' in filter) return { and: filter.and.map(catalogueOnly) };
  if ('or' in filter) return { or: filter.or.map(catalogueOnly) };
  if ('not' in filter) return { not: catalogueOnly(filter.not) };
  return filter;
}

export type FilterRelease = {
  types: Record<string, { bases?: readonly string[]; facets?: readonly string[] }>;
  properties: Record<
    string,
    {
      datatype: string;
      relation?: { group: string };
      qualifiers?: readonly string[];
      units?: readonly string[];
      value?: { pattern?: string; minLength?: number; maxLength?: number };
    }
  >;
  filters?: Record<string, { filter: unknown }>;
};

/** Owner-context admission checks structure, not authorization, capabilities or accepted historical pins. */
export type FilterAdmissionOptions = { saved?: boolean; owner?: true };

export type FilterValidationError = { problem: FilterProblem; pointer: string; code: FieldErrorCode };

export class FilterError extends Error {
  readonly problem: FilterProblem;
  readonly errors: { pointer: string; code: FieldErrorCode }[];

  constructor(problem: FilterProblem, pointer: string, code: FieldErrorCode) {
    super(`${problem}: ${code} at ${pointer || '(root)'}`);
    this.name = 'FilterError';
    this.problem = problem;
    this.errors = [{ pointer, code }];
  }
}

function fail(pointer: string, code: FieldErrorCode, problem: FilterProblem = 'invalid_request'): never {
  throw new FilterError(problem, pointer, code);
}

function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function record(input: unknown, pointer: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(pointer, 'invalid_type');
  return input as Record<string, unknown>;
}

type OwnData = { found: boolean; value: unknown };

function ownData(input: object, key: string | number): OwnData {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { found: false, value: undefined };
  return { found: true, value: descriptor.value };
}

// Missing array elements and accessor-backed elements must not resolve through prototypes or execute code.
function ownValue(input: object, key: string | number, pointer: string): unknown {
  const field = ownData(input, key);
  if (!field.found) fail(pointer, 'invalid_type');
  return field.value;
}

function array(input: unknown, pointer: string, limit?: number): unknown[] {
  if (!Array.isArray(input)) fail(pointer, 'invalid_type');
  if (input.length === 0) fail(pointer, 'out_of_range');
  if (limit !== undefined && input.length > limit) fail(pointer, 'out_of_range', 'unsupported_query');
  return input;
}

const curiePattern = /^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();

function stringValue(input: unknown, pointer: string, curie: boolean): string {
  if (typeof input !== 'string') fail(pointer, 'invalid_type');
  const maxBytes = curie ? 128 : 256;
  const match = curie ? curiePattern.exec(input)?.[0] : input;
  if (
    input.length === 0 ||
    input.length > maxBytes ||
    controlCharacters.test(input) ||
    (curie && match !== input) ||
    encoder.encode(input).byteLength > maxBytes
  )
    fail(pointer, 'invalid_format');
  return input;
}

function values(input: unknown, pointer: string, curie: boolean): string[] {
  const items = array(input, pointer, FILTER_LIMITS.in);
  const result: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const itemPointer = appendPointer(pointer, index);
    result.push(stringValue(ownValue(items, index, itemPointer), itemPointer, curie));
  }
  return result;
}

function parseFacet(input: unknown, pointer: string, statement: boolean): { property: string; in: string[] } {
  const fields = record(input, pointer);
  let property = '';
  let selected: string[] | undefined;
  for (const key of Object.getOwnPropertyNames(fields)) {
    const fieldPointer = appendPointer(pointer, key);
    if (key === 'property' && statement) {
      property = stringValue(ownValue(fields, key, fieldPointer), fieldPointer, true);
    } else if (key === 'in') {
      selected = values(ownValue(fields, key, fieldPointer), fieldPointer, !statement);
    } else {
      fail(fieldPointer, 'unknown_field');
    }
  }
  if (statement && !Object.hasOwn(fields, 'property')) fail(appendPointer(pointer, 'property'), 'required');
  if (selected === undefined) fail(appendPointer(pointer, 'in'), 'required');
  return { property, in: selected };
}

function parseRange(input: unknown, pointer: string): FilterRange {
  const fields = record(input, pointer);
  const parsed: { gte?: number; lte?: number; unit?: string } = {};
  for (const key of Object.getOwnPropertyNames(fields)) {
    const fieldPointer = appendPointer(pointer, key);
    if (key === 'gte' || key === 'lte') {
      const value = ownValue(fields, key, fieldPointer);
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(fieldPointer, 'invalid_type');
      parsed[key] = value;
    } else if (key === 'unit') {
      parsed.unit = stringValue(ownValue(fields, key, fieldPointer), fieldPointer, false);
    } else {
      fail(fieldPointer, 'unknown_field');
    }
  }
  if (parsed.gte === undefined && parsed.lte === undefined) fail(appendPointer(pointer, 'gte'), 'required');
  if (parsed.gte !== undefined && parsed.lte !== undefined && parsed.gte > parsed.lte) fail(pointer, 'out_of_range');
  return parsed;
}

function parseQualifier(input: unknown, pointer: string): FilterQualifier {
  const fields = record(input, pointer);
  let property: string | undefined;
  let selected: string[] | undefined;
  for (const key of Object.getOwnPropertyNames(fields)) {
    const fieldPointer = appendPointer(pointer, key);
    if (key === 'property') property = stringValue(ownValue(fields, key, fieldPointer), fieldPointer, true);
    else if (key === 'in') selected = values(ownValue(fields, key, fieldPointer), fieldPointer, false);
    else fail(fieldPointer, 'unknown_field');
  }
  if (property === undefined) fail(appendPointer(pointer, 'property'), 'required');
  if (selected === undefined) fail(appendPointer(pointer, 'in'), 'required');
  return { property, in: selected };
}

function parseQualifiers(input: unknown, pointer: string): FilterQualifier[] {
  const items = array(input, pointer, FILTER_LIMITS.qualifiers);
  const result: FilterQualifier[] = [];
  for (let index = 0; index < items.length; index++) {
    const itemPointer = appendPointer(pointer, index);
    result.push(parseQualifier(ownValue(items, index, itemPointer), itemPointer));
  }
  return result;
}

const savedPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseSaved(input: unknown, pointer: string): string {
  if (typeof input !== 'string') fail(pointer, 'invalid_type');
  if (input.length > 96 || savedPattern.exec(input)?.[0] !== input) fail(pointer, 'invalid_format');
  return input;
}

const ownerIdPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ownerId(input: unknown, pointer: string): string {
  const value = stringValue(input, pointer, false);
  if (ownerIdPattern.exec(value)?.[0] !== value) fail(pointer, 'invalid_format');
  return value;
}

function requiredValue(fields: object, key: string, pointer: string): unknown {
  if (!Object.hasOwn(fields, key)) fail(pointer, 'required');
  return ownValue(fields, key, pointer);
}

function parseRatingQuestion(input: unknown, pointer: string): RatingQuestionLeaf {
  const fields = record(input, pointer);
  for (const key of Object.getOwnPropertyNames(fields))
    if (key !== 'id') fail(appendPointer(pointer, key), 'unknown_field');
  const idPointer = appendPointer(pointer, 'id');
  const id = requiredValue(fields, 'id', idPointer);
  if (typeof id !== 'string') fail(idPointer, 'invalid_type');
  if (uuidPattern.exec(id)?.[0] !== id) fail(idPointer, 'invalid_format');
  return { ratingQuestion: { id } };
}

function parseOwner(input: unknown, pointer: string): OwnerLeaf {
  const fields = record(input, pointer);
  const keys = Object.getOwnPropertyNames(fields);
  if (keys.length !== 1) fail(pointer, 'unsupported');
  const family = keys[0]!;
  const familyPointer = appendPointer(pointer, family);
  if (family === 'presence') {
    const value = ownValue(fields, family, familyPointer);
    if (typeof value !== 'boolean') fail(familyPointer, 'invalid_type');
    if (value !== true) fail(familyPointer, 'invalid_format');
    return { owner: { presence: true } };
  }
  let allowed: readonly string[];
  switch (family) {
    case 'state':
      allowed = ['profileId', 'stateSetId', 'in'];
      break;
    case 'label':
      allowed = ['id'];
      break;
    case 'session':
      allowed = ['profileId', 'lifecycle'];
      break;
    case 'holding':
      allowed = ['profileId', 'kind', 'status'];
      break;
    default:
      return fail(familyPointer, 'unknown_field');
  }
  const operands = record(ownValue(fields, family, familyPointer), familyPointer);
  for (const key of Object.getOwnPropertyNames(operands)) {
    if (!allowed.includes(key)) fail(appendPointer(familyPointer, key), 'unknown_field');
  }
  const required = (key: string) => requiredValue(operands, key, appendPointer(familyPointer, key));
  const id = (key: string) => ownerId(required(key), appendPointer(familyPointer, key));
  if (family === 'label') {
    const value = stringValue(required('id'), appendPointer(familyPointer, 'id'), false);
    if (uuidPattern.exec(value)?.[0] !== value) fail(appendPointer(familyPointer, 'id'), 'invalid_format');
    return { owner: { label: { id: value } } };
  }
  const profileId = id('profileId');
  if (family === 'state') {
    const stateSetId = id('stateSetId');
    const inPointer = appendPointer(familyPointer, 'in');
    const items = array(required('in'), inPointer, FILTER_LIMITS.in);
    const selected: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index++) {
      const itemPointer = appendPointer(inPointer, index);
      const value = ownerId(ownValue(items, index, itemPointer), itemPointer);
      if (seen.has(value)) fail(itemPointer, 'invalid_format');
      seen.add(value);
      selected.push(value);
    }
    return { owner: { state: { profileId, stateSetId, in: selected } } };
  }
  if (family === 'session') {
    const lifecyclePointer = appendPointer(familyPointer, 'lifecycle');
    const lifecycle = stringValue(required('lifecycle'), lifecyclePointer, false);
    if (lifecycle !== 'active' && lifecycle !== 'completed' && lifecycle !== 'abandoned')
      fail(lifecyclePointer, 'invalid_format');
    return { owner: { session: { profileId, lifecycle } } };
  }
  return {
    owner: {
      holding: {
        profileId,
        ...(Object.hasOwn(operands, 'kind') ? { kind: id('kind') } : {}),
        ...(Object.hasOwn(operands, 'status') ? { status: id('status') } : {}),
      },
    },
  };
}

export function parseFilter(input: unknown): FilterDocument {
  return catalogueOnly(parseDocument(input, false));
}

export function parseDiscoveryFilter(input: unknown): DiscoveryFilterDocument {
  return parseDocument(input, true);
}

function parseDocument(input: unknown, discovery: boolean): DiscoveryFilterDocument {
  let leaves = 0;

  function node(input: unknown, pointer: string, depth: number, underNot: boolean): DiscoveryFilterDocument {
    const fields = record(input, pointer);
    const keys = Object.getOwnPropertyNames(fields);
    if (keys.length !== 1) fail(pointer, 'unsupported');
    const key = keys[0]!;
    const fieldPointer = appendPointer(pointer, key);
    switch (key) {
      case 'and':
      case 'or': {
        if (depth >= FILTER_LIMITS.depth) fail(pointer, 'out_of_range', 'unsupported_query');
        const items = array(
          ownValue(fields, key, fieldPointer),
          fieldPointer,
          key === 'or' ? FILTER_LIMITS.or : undefined,
        );
        const children: DiscoveryFilterDocument[] = [];
        for (let index = 0; index < items.length; index++) {
          const childPointer = appendPointer(fieldPointer, index);
          children.push(node(ownValue(items, index, childPointer), childPointer, depth + 1, false));
        }
        return key === 'and' ? { and: children } : { or: children };
      }
      case 'not':
        if (underNot) fail(pointer, 'unsupported', 'unsupported_query');
        if (depth >= FILTER_LIMITS.depth) fail(pointer, 'out_of_range', 'unsupported_query');
        return { not: node(ownValue(fields, key, fieldPointer), fieldPointer, depth + 1, true) };
      case 'kind': {
        if (!discovery) return fail(fieldPointer, 'unknown_field');
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        const selection = record(ownValue(fields, key, fieldPointer), fieldPointer);
        for (const field of Object.getOwnPropertyNames(selection))
          if (field !== 'in') fail(appendPointer(fieldPointer, field), 'unknown_field');
        const inPointer = appendPointer(fieldPointer, 'in');
        return { kind: { in: values(requiredValue(selection, 'in', inPointer), inPointer, false) } };
      }
      case 'ratingQuestion':
        if (!discovery) return fail(fieldPointer, 'unknown_field');
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        return parseRatingQuestion(ownValue(fields, key, fieldPointer), fieldPointer);
      case 'type': {
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        return { type: { in: parseFacet(ownValue(fields, key, fieldPointer), fieldPointer, false).in } };
      }
      case 'statement': {
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        const statementFields = record(ownValue(fields, key, fieldPointer), fieldPointer);
        const statementKeys = Object.getOwnPropertyNames(statementFields);
        const hasIn = Object.hasOwn(statementFields, 'in');
        const hasRange = Object.hasOwn(statementFields, 'range');

        if (hasIn && hasRange) fail(appendPointer(fieldPointer, 'range'), 'unsupported');

        let property: string | undefined;
        let selected: string[] | undefined;
        let range: FilterRange | undefined;
        let qualifiers: FilterQualifier[] | undefined;
        for (const statementKey of statementKeys) {
          const propertyPointer = appendPointer(fieldPointer, statementKey);
          if (statementKey === 'property') {
            property = stringValue(ownValue(statementFields, statementKey, propertyPointer), propertyPointer, true);
          } else if (statementKey === 'in') {
            selected = values(ownValue(statementFields, statementKey, propertyPointer), propertyPointer, false);
          } else if (statementKey === 'range') {
            range = parseRange(ownValue(statementFields, statementKey, propertyPointer), propertyPointer);
          } else if (statementKey === 'qualifiers') {
            qualifiers = parseQualifiers(ownValue(statementFields, statementKey, propertyPointer), propertyPointer);
          } else {
            fail(propertyPointer, 'unknown_field');
          }
        }
        if (property === undefined) fail(appendPointer(fieldPointer, 'property'), 'required');
        if (selected === undefined && range === undefined) fail(appendPointer(fieldPointer, 'in'), 'required');

        const qualifierField = qualifiers === undefined ? {} : { qualifiers };
        leaves += qualifiers?.length ?? 0;
        if (leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        return {
          statement:
            selected === undefined
              ? { property, range: range!, ...qualifierField }
              : { property, in: selected, ...qualifierField },
        };
      }
      case 'owner':
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        return parseOwner(ownValue(fields, key, fieldPointer), fieldPointer);
      case 'saved':
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        return { saved: parseSaved(ownValue(fields, key, fieldPointer), fieldPointer) };
      default:
        return fail(fieldPointer, 'unknown_field');
    }
  }

  return node(input, '', 0, false);
}

/** Walk every node in source order, including NOT children. Expand saved filters through admission first. */
export function* walkFilter(filter: FilterDocument): IterableIterator<FilterDocument> {
  yield filter;
  if ('and' in filter) {
    for (const child of filter.and) yield* walkFilter(child);
  } else if ('or' in filter) {
    for (const child of filter.or) yield* walkFilter(child);
  } else if ('not' in filter) {
    yield* walkFilter(filter.not);
  }
}

export function positiveFilter(filter: FilterDocument): boolean {
  if ('not' in filter) return false;
  if ('and' in filter) return filter.and.some(positiveFilter);
  if ('or' in filter) return filter.or.every(positiveFilter);
  return true;
}

/** Discovery visitors are explicit so saved/dynamic catalogue consumers keep their closed grammar. */
export function* walkDiscoveryFilter(filter: DiscoveryFilterDocument): IterableIterator<DiscoveryFilterDocument> {
  yield filter;
  if ('and' in filter || 'or' in filter) {
    for (const child of 'and' in filter ? filter.and : filter.or) yield* walkDiscoveryFilter(child);
  } else if ('not' in filter) yield* walkDiscoveryFilter(filter.not);
}

export function positiveDiscoveryFilter(filter: DiscoveryFilterDocument): boolean {
  if ('not' in filter) return false;
  if ('and' in filter) return filter.and.some(positiveDiscoveryFilter);
  if ('or' in filter) return filter.or.every(positiveDiscoveryFilter);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dataField(input: unknown, key: string): unknown {
  if (!isRecord(input)) return undefined;
  const field = ownData(input, key);
  return field.found ? field.value : undefined;
}

function ownRecordValue(input: unknown, key: string): unknown {
  if (!isRecord(input)) return undefined;
  const field = ownData(input, key);
  return field.found ? field.value : undefined;
}

export function relationFacetProperty(release: FilterRelease, property: string): boolean {
  const properties = dataField(release, 'properties');
  const definition = ownRecordValue(properties, property);
  const relation = dataField(definition, 'relation');
  switch (dataField(relation, 'group')) {
    case 'order':
    case 'derivation':
    case 'world':
    case 'membership':
    case 'association':
    case 'credit':
    case 'appearance':
      return true;
    default:
      return false;
  }
}

function ownStringList(input: unknown, key: string): string[] {
  const value = dataField(input, key);
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = ownData(value, index);
    if (item.found && typeof item.value === 'string') result.push(item.value);
  }
  return result;
}

function hasOwnMapKey(map: unknown, key: string): boolean {
  if (!isRecord(map)) return false;
  const field = ownData(map, key);
  return field.found && isRecord(field.value);
}

/** An explicit construction lifetime. The caller owns a snapshot; raw entry points create a fresh one. */
export function createFilterConstruction(release: FilterRelease) {
  // Own all descriptor-backed data before retaining indexes across admissions.
  const snapshot = snapshotData(release) as FilterRelease;
  const construction = buildConstruction(snapshot);
  return {
    admitFilter: (filter: FilterDocument, options?: FilterAdmissionOptions) =>
      catalogueOnly(admitConstructed(filter, snapshot, options, construction)),
    validateFilter: (input: unknown, options?: FilterAdmissionOptions) =>
      validateConstructed(input, snapshot, options, construction),
    facetProperties: (types: readonly string[]) => displayFacets(construction, types),
    qualifiers: (property: string): ReadonlySet<string> => construction.qualifiers.get(property) ?? emptyFacets,
  };
}

// Copy own data only. Accessors, inherited fields and holes remain absent, never evaluated.
function snapshotData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(null);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const field = ownData(value, key);
    if (field.found)
      Object.defineProperty(copy, key, {
        value: snapshotData(field.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  ancestors.delete(value);
  return copy;
}

const emptyFacets: ReadonlySet<string> = new Set();
type Construction = {
  facets: Map<string, ReadonlySet<string>>;
  all: ReadonlySet<string>;
  qualifiers: Map<string, ReadonlySet<string>>;
  units: Map<string, ReadonlySet<string>>;
  patterns: Map<object, RegExp | null>;
};

function buildConstruction(release: FilterRelease): Construction {
  const types = dataField(release, 'types');
  const direct = new Map<string, readonly string[]>();
  const facets = new Map<string, ReadonlySet<string>>();
  const all = new Set<string>();
  if (isRecord(types)) {
    for (const type of Object.getOwnPropertyNames(types)) {
      direct.set(type, ownStringList(ownRecordValue(types, type), 'facets'));
    }
    for (const type of Object.getOwnPropertyNames(types)) {
      const definition = ownRecordValue(types, type);
      const selected = new Set<string>();
      for (const facet of direct.get(type) ?? []) selected.add(facet);
      for (const base of ownStringList(definition, 'bases')) {
        for (const facet of direct.get(base) ?? []) selected.add(facet);
      }
      facets.set(type, selected);
      for (const facet of selected) all.add(facet);
    }
  }
  const qualifiers = new Map<string, ReadonlySet<string>>();
  const units = new Map<string, ReadonlySet<string>>();
  const properties = dataField(release, 'properties');
  if (isRecord(properties))
    for (const property of Object.getOwnPropertyNames(properties)) {
      const definition = ownRecordValue(properties, property);
      qualifiers.set(property, new Set(ownStringList(definition, 'qualifiers')));
      units.set(property, new Set(ownStringList(definition, 'units')));
    }
  return { facets, all, qualifiers, units, patterns: new Map() };
}

const immutableConstructions = new WeakMap<object, Construction>();
function constructionFor(release: FilterRelease): Construction {
  const known = immutableConstructions.get(release);
  if (known) return known;
  const construction = buildConstruction(release);
  const seen = new Set<object>();
  function immutable(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || seen.has(value)) return true;
    if (!Object.isFrozen(value)) return false;
    seen.add(value);
    return Reflect.ownKeys(value).every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      return Object.hasOwn(field, 'value') && immutable(field.value);
    });
  }
  if (immutable(release)) immutableConstructions.set(release, construction);
  return construction;
}

function displayFacets(construction: Construction, types: readonly string[]): string[] {
  const result = new Set<string>();
  for (const type of types) for (const facet of construction.facets.get(type) ?? emptyFacets) result.add(facet);
  return [...result];
}

export function facetProperties(release: FilterRelease, types: readonly string[]): string[] {
  return displayFacets(constructionFor(release), types);
}

function codePattern(definition: object, construction: Construction): RegExp | null {
  if (construction.patterns.has(definition)) return construction.patterns.get(definition) ?? null;
  const value = dataField(definition, 'value');
  const source = isRecord(value) ? dataField(value, 'pattern') : undefined;
  let compiled: RegExp | null = null;
  if (typeof source === 'string' && source.length > 0) {
    try {
      compiled = new RegExp(source, 'u');
    } catch {
      compiled = null;
    }
  }
  construction.patterns.set(definition, compiled);
  return compiled;
}

function containsSaved(filter: FilterDocument): boolean {
  if ('saved' in filter) return true;
  if ('and' in filter) return filter.and.some(containsSaved);
  if ('or' in filter) return filter.or.some(containsSaved);
  if ('not' in filter) return containsSaved(filter.not);
  return false;
}

function mappedPointer(actual: string, source: string | undefined): string {
  return source ?? actual;
}

function admitConstructed(
  filter: DiscoveryFilterDocument,
  release: FilterRelease,
  options: FilterAdmissionOptions & { kinds?: ReadonlySet<string> } = {},
  construction: Construction,
): DiscoveryFilterDocument {
  const expansions = new Map<string, FilterDocument | null>();
  const allowSaved = options.saved !== false;
  const filters = dataField(release, 'filters');

  function loadSaved(node: Extract<FilterDocument, { saved: string }>, pointer: string): FilterDocument | null {
    if (expansions.has(pointer)) return expansions.get(pointer)!;
    if (!allowSaved) {
      expansions.set(pointer, null);
      return null;
    }
    const entry = ownRecordValue(filters, node.saved);
    if (!isRecord(entry)) {
      expansions.set(pointer, null);
      return null;
    }
    const raw = ownRecordValue(entry, 'filter');
    let parsed: FilterDocument;
    try {
      parsed = parseFilter(raw);
    } catch {
      expansions.set(pointer, null);
      return null;
    }
    if (containsSaved(parsed)) {
      expansions.set(pointer, null);
      return null;
    }
    expansions.set(pointer, parsed);
    return parsed;
  }

  const types = dataField(release, 'types');
  let returnable: string[] | undefined;
  if ('type' in filter) {
    returnable = [...filter.type.in];
  } else if ('saved' in filter) {
    const expanded = loadSaved(filter, '');
    if (expanded && 'type' in expanded) returnable = [...expanded.type.in];
  } else if ('and' in filter) {
    const values: string[][] = [];
    for (let index = 0; index < filter.and.length; index++) {
      const child = filter.and[index]!;
      if ('type' in child) values.push([...child.type.in]);
      else if ('saved' in child) {
        const pointer = appendPointer(appendPointer('', 'and'), index);
        const expanded = loadSaved(child, pointer);
        if (expanded && 'type' in expanded) values.push([...expanded.type.in]);
      }
    }
    if (values.length > 0) {
      const intersection = new Set(values[0]);
      for (const childValues of values.slice(1)) {
        const childSet = new Set(childValues);
        for (const value of intersection) if (!childSet.has(value)) intersection.delete(value);
      }
      returnable = [...intersection];
    }
  }

  const selectedFacets =
    returnable === undefined
      ? [construction.all]
      : returnable
          .filter((type) => hasOwnMapKey(types, type))
          .map((type) => construction.facets.get(type) ?? emptyFacets);
  const allowedFacet = (property: string) => selectedFacets.some((facets) => facets.has(property));

  let expandedLeaves = 0;

  function reject(pointer: string, source: string | undefined, code: FieldErrorCode, problem: FilterProblem): never {
    fail(mappedPointer(pointer, source), code, problem);
  }

  function validateType(
    node: Extract<FilterDocument, { type: unknown }>,
    pointer: string,
    source: string | undefined,
  ): void {
    const typeMap = dataField(release, 'types');
    for (let index = 0; index < node.type.in.length; index++) {
      const type = node.type.in[index]!;
      const valuePointer = appendPointer(appendPointer(appendPointer(pointer, 'type'), 'in'), index);
      if (!hasOwnMapKey(typeMap, type)) reject(valuePointer, source, 'unsupported', 'unsupported_query');
    }
  }

  function validateUuidValues(values: readonly string[], pointer: string, source: string | undefined): void {
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      const match = uuidPattern.exec(value)?.[0];
      if (match !== value) reject(appendPointer(pointer, index), source, 'invalid_format', 'invalid_request');
    }
  }

  function propertyDefinition(propertyMap: unknown, property: string): Record<string, unknown> | undefined {
    const value = ownRecordValue(propertyMap, property);
    return isRecord(value) ? value : undefined;
  }

  function validateStatement(
    node: Extract<FilterDocument, { statement: unknown }>,
    pointer: string,
    source: string | undefined,
  ): void {
    const statement = node.statement;
    const propertyPointer = appendPointer(appendPointer(pointer, 'statement'), 'property');
    if (!allowedFacet(statement.property)) reject(propertyPointer, source, 'unsupported', 'unsupported_query');

    const properties = dataField(release, 'properties');
    const definition = propertyDefinition(properties, statement.property);
    if (!definition) reject(propertyPointer, source, 'unsupported', 'unsupported_query');
    if (statement.qualifiers !== undefined && relationFacetProperty(release, statement.property))
      reject(
        appendPointer(appendPointer(pointer, 'statement'), 'qualifiers'),
        source,
        'unsupported',
        'invalid_request',
      );
    const datatype = dataField(definition, 'datatype');

    if ('in' in statement) {
      const inPointer = appendPointer(appendPointer(pointer, 'statement'), 'in');
      if (datatype === 'wikibase-item') validateUuidValues(statement.in, inPointer, source);
      else if (datatype === 'string') {
        const pattern = codePattern(definition, construction);
        if (!pattern) reject(inPointer, source, 'unsupported', 'unsupported_query');
        for (let index = 0; index < statement.in.length; index++) {
          const value = statement.in[index]!;
          // Full match: a code is the pattern's identifier, at most 128 UTF-16 code units.
          if (value.length < 1 || value.length > 128 || pattern.exec(value)?.[0] !== value)
            reject(appendPointer(inPointer, index), source, 'invalid_format', 'invalid_request');
        }
      } else reject(inPointer, source, 'unsupported', 'unsupported_query');
    } else {
      const rangePointer = appendPointer(appendPointer(pointer, 'statement'), 'range');
      if (datatype !== 'time' && datatype !== 'quantity')
        reject(rangePointer, source, 'unsupported', 'unsupported_query');
      const range = statement.range;
      if (datatype === 'time') {
        for (const key of Object.keys(range)) {
          const value = range[key as keyof FilterRange];
          const rangeFieldPointer = appendPointer(rangePointer, key);
          if (key === 'unit') reject(rangeFieldPointer, source, 'unsupported', 'unsupported_query');
          if ((key === 'gte' || key === 'lte') && !Number.isSafeInteger(value))
            reject(rangeFieldPointer, source, 'invalid_format', 'invalid_request');
        }
      } else {
        if (range.unit === undefined)
          reject(appendPointer(rangePointer, 'unit'), source, 'required', 'invalid_request');
        if (!construction.units.get(statement.property)?.has(range.unit))
          reject(appendPointer(rangePointer, 'unit'), source, 'unsupported', 'unsupported_query');
      }
    }

    const qualifiers = statement.qualifiers;
    if (qualifiers) {
      const declaredQualifiers = construction.qualifiers.get(statement.property) ?? emptyFacets;
      for (let index = 0; index < qualifiers.length; index++) {
        const qualifier = qualifiers[index]!;
        const qualifierPointer = appendPointer(appendPointer(appendPointer(pointer, 'statement'), 'qualifiers'), index);
        const qualifierPropertyPointer = appendPointer(qualifierPointer, 'property');
        const qualifierDefinition = propertyDefinition(properties, qualifier.property);
        if (!declaredQualifiers.has(qualifier.property) || !qualifierDefinition)
          reject(qualifierPropertyPointer, source, 'unsupported', 'unsupported_query');
        const inPointer = appendPointer(qualifierPointer, 'in');
        const datatype = dataField(qualifierDefinition, 'datatype');
        if (datatype === 'wikibase-item') validateUuidValues(qualifier.in, inPointer, source);
        else if (datatype === 'string') {
          const schema = dataField(qualifierDefinition, 'value');
          const declaredPattern = dataField(schema, 'pattern');
          const pattern = codePattern(qualifierDefinition, construction);
          if (declaredPattern !== undefined && declaredPattern !== '' && !pattern)
            reject(inPointer, source, 'unsupported', 'unsupported_query');
          const minimum = dataField(schema, 'minLength');
          const maximum = dataField(schema, 'maxLength');
          for (let valueIndex = 0; valueIndex < qualifier.in.length; valueIndex++) {
            const value = qualifier.in[valueIndex]!;
            const valuePointer = appendPointer(inPointer, valueIndex);
            // Qualifiers retain the grammar's byte limit, not the catalogue code-facet limit.
            try {
              stringValue(value, valuePointer, false);
            } catch (error) {
              if (error instanceof FilterError) reject(valuePointer, source, error.errors[0]!.code, error.problem);
              throw error;
            }
            const length = [...value].length;
            if (
              (typeof minimum === 'number' && length < minimum) ||
              (typeof maximum === 'number' && length > maximum) ||
              (pattern && !pattern.test(value))
            )
              reject(valuePointer, source, 'invalid_format', 'invalid_request');
          }
        } else reject(qualifierPropertyPointer, source, 'unsupported', 'unsupported_query');
      }
    }
  }

  function visit(
    node: DiscoveryFilterDocument,
    pointer: string,
    depth: number,
    underNot: boolean,
    source: string | undefined,
  ): DiscoveryFilterDocument {
    if ('and' in node || 'or' in node) {
      const isAnd = 'and' in node;
      const operator = isAnd ? 'and' : 'or';
      const children = isAnd ? node.and : node.or;
      if (depth >= FILTER_LIMITS.depth) reject(pointer, source, 'out_of_range', 'unsupported_query');
      if (children.length === 0 || (operator === 'or' && children.length > FILTER_LIMITS.or))
        reject(appendPointer(pointer, operator), source, 'out_of_range', 'unsupported_query');
      const parsedChildren = children.map((child, index) =>
        visit(child, appendPointer(appendPointer(pointer, operator), index), depth + 1, false, source),
      );
      return operator === 'and' ? { and: parsedChildren } : { or: parsedChildren };
    }
    if ('not' in node) {
      if (underNot) reject(pointer, source, 'unsupported', 'unsupported_query');
      if (depth >= FILTER_LIMITS.depth) reject(pointer, source, 'out_of_range', 'unsupported_query');
      return { not: visit(node.not, appendPointer(pointer, 'not'), depth + 1, true, source) };
    }
    if ('saved' in node) {
      const savedPointer = appendPointer(pointer, 'saved');
      if (!allowSaved) reject(savedPointer, source, 'unsupported', 'unsupported_query');
      if (source !== undefined) reject(savedPointer, source, 'unsupported', 'unsupported_query');
      const expanded = loadSaved(node, pointer);
      if (!expanded) reject(savedPointer, source, 'unsupported', 'unsupported_query');
      return visit(expanded, pointer, depth, underNot, savedPointer);
    }

    expandedLeaves += 1;
    if ('statement' in node) expandedLeaves += node.statement.qualifiers?.length ?? 0;
    if (expandedLeaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');

    if ('kind' in node) {
      const inPointer = appendPointer(appendPointer(pointer, 'kind'), 'in');
      if (!options.kinds) reject(appendPointer(pointer, 'kind'), source, 'unsupported', 'unsupported_query');
      if (node.kind.in.length === 0 || node.kind.in.length > FILTER_LIMITS.in)
        reject(inPointer, source, 'out_of_range', 'unsupported_query');
      for (const [index, kind] of node.kind.in.entries())
        if (!options.kinds.has(kind))
          reject(appendPointer(inPointer, index), source, 'unsupported', 'unsupported_query');
      return { kind: { in: [...node.kind.in] } };
    }

    if ('ratingQuestion' in node) {
      // The request grammar is the only entry point. A saved definition is
      // parsed by parseFilter before expansion and cannot acquire this operand.
      if (!options.kinds || source !== undefined)
        reject(appendPointer(pointer, 'ratingQuestion'), source, 'unsupported', 'unsupported_query');
      return parseRatingQuestion(node.ratingQuestion, appendPointer(pointer, 'ratingQuestion'));
    }

    if ('type' in node) {
      if (node.type.in.length === 0 || node.type.in.length > FILTER_LIMITS.in)
        reject(appendPointer(appendPointer(pointer, 'type'), 'in'), source, 'out_of_range', 'unsupported_query');
      validateType(node, pointer, source);
      return { type: { in: [...node.type.in] } };
    }

    if ('owner' in node) {
      if (options.owner !== true) reject(appendPointer(pointer, 'owner'), source, 'unsupported', 'unsupported_query');
      return parseOwner(node.owner, appendPointer(pointer, 'owner'));
    }

    const statement = node.statement;
    if ('in' in statement) {
      if (statement.in.length === 0 || statement.in.length > FILTER_LIMITS.in)
        reject(appendPointer(appendPointer(pointer, 'statement'), 'in'), source, 'out_of_range', 'unsupported_query');
    } else {
      if (
        (statement.range.gte === undefined && statement.range.lte === undefined) ||
        (statement.range.gte !== undefined &&
          statement.range.lte !== undefined &&
          statement.range.gte > statement.range.lte)
      )
        reject(appendPointer(appendPointer(pointer, 'statement'), 'range'), source, 'out_of_range', 'invalid_request');
    }
    if ((statement.qualifiers?.length ?? 0) > FILTER_LIMITS.qualifiers)
      reject(
        appendPointer(appendPointer(pointer, 'statement'), 'qualifiers'),
        source,
        'out_of_range',
        'unsupported_query',
      );
    if (statement.qualifiers?.length === 0)
      reject(
        appendPointer(appendPointer(pointer, 'statement'), 'qualifiers'),
        source,
        'out_of_range',
        'invalid_request',
      );
    if (statement.qualifiers) {
      for (let index = 0; index < statement.qualifiers.length; index++) {
        const values = statement.qualifiers[index]!.in;
        const valuesPointer = appendPointer(
          appendPointer(appendPointer(appendPointer(pointer, 'statement'), 'qualifiers'), index),
          'in',
        );
        if (values.length === 0 || values.length > FILTER_LIMITS.in)
          reject(
            valuesPointer,
            source,
            'out_of_range',
            values.length > FILTER_LIMITS.in ? 'unsupported_query' : 'invalid_request',
          );
      }
    }
    validateStatement(node, pointer, source);
    return {
      statement:
        'in' in statement
          ? {
              property: statement.property,
              in: [...statement.in],
              ...(statement.qualifiers
                ? {
                    qualifiers: statement.qualifiers.map((qualifier) => ({
                      property: qualifier.property,
                      in: [...qualifier.in],
                    })),
                  }
                : {}),
            }
          : {
              property: statement.property,
              range: { ...statement.range },
              ...(statement.qualifiers
                ? {
                    qualifiers: statement.qualifiers.map((qualifier) => ({
                      property: qualifier.property,
                      in: [...qualifier.in],
                    })),
                  }
                : {}),
            },
    };
  }

  return visit(filter, '', 0, false, undefined);
}

function validateConstructed(
  input: unknown,
  release: FilterRelease,
  options: FilterAdmissionOptions | undefined,
  construction: Construction,
): FilterValidationError[] {
  try {
    const parsed = parseFilter(input);
    admitConstructed(parsed, release, options, construction);
    return [];
  } catch (error) {
    if (error instanceof FilterError) {
      const first = error.errors[0]!;
      return [{ problem: error.problem, pointer: first.pointer, code: first.code }];
    }
    return [{ problem: 'invalid_request', pointer: '', code: 'invalid_type' }];
  }
}

/** Raw mutable releases are indexed anew for every public call. */
export function admitFilter(
  filter: FilterDocument,
  release: FilterRelease,
  options?: FilterAdmissionOptions,
): FilterDocument {
  return catalogueOnly(admitConstructed(filter, release, options, constructionFor(release)));
}

/** Expands only catalogue saved filters and charges the complete mixed tree before deduplication. */
export function admitDiscoveryFilter(
  filter: DiscoveryFilterDocument,
  release: FilterRelease,
  kinds: ReadonlySet<string>,
): DiscoveryFilterDocument {
  return admitConstructed(filter, release, { kinds }, constructionFor(release));
}

export function validateDiscoveryFilter(
  input: unknown,
  release: FilterRelease,
  kinds: ReadonlySet<string>,
): FilterValidationError[] {
  try {
    admitDiscoveryFilter(parseDiscoveryFilter(input), release, kinds);
    return [];
  } catch (error) {
    if (error instanceof FilterError) return error.errors.map((field) => ({ problem: error.problem, ...field }));
    return [{ problem: 'invalid_request', pointer: '', code: 'invalid_type' }];
  }
}

export function validateFilter(
  input: unknown,
  release: FilterRelease,
  options?: FilterAdmissionOptions,
): FilterValidationError[] {
  return validateConstructed(input, release, options, constructionFor(release));
}
