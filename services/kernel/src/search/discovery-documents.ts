import { HANDLE_LOOKUP_PATTERN } from '../access/handle-policy.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { documentActions } from './document.ts';
import {
  ACCOUNT_DISCOVERY_BATCH_SIZE,
  DISCOVERY_DOCUMENT_FORMAT,
  MIXED_DISCOVERY_DOCUMENT_FORMAT,
  type DiscoveryIndexAction,
  type DiscoveryIndexDefinition,
  type DiscoveryKey,
  type DiscoveryRegistry,
  type DiscoverySnapshot,
  type IndexedDiscoveryDocument,
} from './discovery.ts';
import { SearchUnavailableError } from './opensearch.ts';
import definition from '../../db/search/indices/discovery.json';
import mixedDefinition from '../../db/search/indices/discovery-mixed-v1.json';
import { MISSING_NAME } from './document.ts';

const MAX_NATIVE_VERSION = 9_223_372_036_854_775_807n;
const ID_PREFIX = 'discovery-v1:';
const COMMON_FIELDS = ['identity', 'document_format', 'owner', 'kind', 'id', 'route', 'partition', 'source_position'];
const ACCOUNT_FIELDS = [
  ...COMMON_FIELDS,
  'account_kind',
  'handle',
  'display_name',
  'revision',
  'names',
  'descriptions',
  'name_sort',
];
const SUBJECT_FIELDS = [
  ...COMMON_FIELDS,
  'type',
  'security_revision',
  'names',
  'descriptions',
  'name_sort',
  'statements',
  'facts',
  'relation_facet_overflow',
  'public_collection_count',
  'rating_score',
  'rating_prior_epoch',
];
const SECOND_SCOPE_FIELDS = [...COMMON_FIELDS, 'revision', 'source_version', 'names', 'descriptions', 'name_sort'];
const SECOND_SCOPE_BATCH_SIZE = 256;

/** Local codec seam until the closed DiscoveryKey/snapshot union owns these kinds. */
export type SecondScopeDiscoveryKey =
  | { owner: 'commerce'; kind: 'collection'; route: number; id: string }
  | { owner: 'content'; kind: 'review' | 'space'; route: number; id: string };
export type DiscoveryDocumentKey = DiscoveryKey | SecondScopeDiscoveryKey;
export type SecondScopeDiscoveryRecord = {
  key: SecondScopeDiscoveryKey;
  revision: bigint;
  sourceVersion: string | null;
  names: readonly string[];
  descriptions: readonly string[];
  nameSort: string | null;
};
export type SecondScopeDiscoveryObservation = {
  owner: 'commerce' | 'content';
  snapshot: {
    partition: number;
    position: bigint;
    /** False or omitted means the native read cannot establish deletions for this keyset. */
    complete: boolean;
    records: readonly SecondScopeDiscoveryRecord[];
  };
};
export type SecondScopeIndexedDiscoveryDocument = {
  document_format: typeof MIXED_DISCOVERY_DOCUMENT_FORMAT;
  identity: string;
  owner: 'commerce' | 'content';
  kind: 'collection' | 'review' | 'space';
  id: string;
  route: number;
  partition: number;
  source_position: string;
  revision: string;
  source_version: string | null;
  names: string[];
  descriptions: string[];
  name_sort: string | null;
};
export type SecondScopeDiscoveryIndexAction =
  | { op: 'index'; id: string; version: bigint; document: SecondScopeIndexedDiscoveryDocument }
  | { op: 'delete'; id: string; version: bigint };
export type DiscoveryDocumentValue = IndexedDiscoveryDocument | SecondScopeIndexedDiscoveryDocument;
export type AnyDiscoveryIndexAction = DiscoveryIndexAction | SecondScopeDiscoveryIndexAction;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nativeVersion(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_NATIVE_VERSION)
    throw new RangeError('Discovery version must be an exact nonnegative native bigint');
}
function decimalVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_NATIVE_VERSION;
}
function nullableText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.isWellFormed());
}
function validSourceVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.isWellFormed();
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.isWellFormed());
}
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function secondScopeOwner(kind: string): 'commerce' | 'content' | undefined {
  if (kind === 'collection') return 'commerce';
  if (kind === 'review' || kind === 'space') return 'content';
  return undefined;
}

function canonicalSecondScopeKey(registry: DiscoveryRegistry, value: unknown): SecondScopeDiscoveryKey {
  if (
    !record(value) ||
    !exactFields(value, ['owner', 'kind', 'route', 'id']) ||
    typeof value.kind !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number'
  )
    throw new TypeError('Invalid second-scope discovery key');
  const owner = secondScopeOwner(value.kind);
  if (owner === undefined || owner !== value.owner) throw new TypeError('Second-scope owner does not own this kind');
  if (registry.entries.some((entry) => entry.kind === value.kind))
    throw new TypeError('Second-scope kind collides with the closed discovery registry');
  const route = routeOf(value.id);
  if (route === null || route !== value.route) throw new RangeError('Invalid second-scope discovery route');
  return value.owner === 'commerce'
    ? { owner: 'commerce', kind: 'collection', route, id: value.id }
    : { owner: 'content', kind: value.kind as 'review' | 'space', route, id: value.id };
}

function canonicalDocumentKey(registry: DiscoveryRegistry, value: DiscoveryDocumentKey): DiscoveryDocumentKey {
  if (
    typeof value === 'object' &&
    value !== null &&
    secondScopeOwner((value as { kind?: string }).kind ?? '') !== undefined
  )
    return canonicalSecondScopeKey(registry, value);
  return registry.key(value as DiscoveryKey);
}

/** Canonical kind+ID key. Owner is resolved through the closed registry, never inferred from a raw UUID. */
export function discoveryDocumentId(registry: DiscoveryRegistry, key: DiscoveryDocumentKey): string {
  const canonical = canonicalDocumentKey(registry, key);
  const id = `${ID_PREFIX}${encodeURIComponent(canonical.kind)}:${canonical.id}`;
  if (Buffer.byteLength(id, 'utf8') > 512)
    throw new RangeError('Discovery document identity exceeds the native ID limit');
  return id;
}

/** A legacy UUID receipt is intentionally invalid here. Never pass tagged IDs to the legacy Subject parser. */
export function parseDiscoveryDocumentId(registry: DiscoveryRegistry, id: string): DiscoveryKey {
  return parseDiscoveryDocumentKey(registry, id) as DiscoveryKey;
}

/** Typed decoder for every registered and second-scope native key. */
export function parseDiscoveryDocumentKey(registry: DiscoveryRegistry, id: string): DiscoveryDocumentKey {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) throw new TypeError('Expected a tagged discovery identity');
  const separator = id.indexOf(':', ID_PREFIX.length);
  if (separator <= ID_PREFIX.length || separator === id.length - 1) throw new TypeError('Malformed discovery identity');
  const encodedKind = id.slice(ID_PREFIX.length, separator);
  let kind: string;
  try {
    kind = decodeURIComponent(encodedKind);
  } catch {
    throw new TypeError('Malformed discovery identity');
  }
  const nativeId = id.slice(separator + 1);
  const route = routeOf(nativeId);
  if (route === null) throw new RangeError('Invalid native discovery ID');
  const secondOwner = secondScopeOwner(kind);
  const key: DiscoveryDocumentKey =
    secondOwner === undefined
      ? registry.get(kind).owner === 'accounts'
        ? { owner: 'accounts', kind: 'account', route, id: nativeId }
        : { owner: 'semantic', kind, route, id: nativeId }
      : ({
          owner: secondOwner,
          kind: kind as 'collection' | 'review' | 'space',
          route,
          id: nativeId,
        } as SecondScopeDiscoveryKey);
  if (discoveryDocumentId(registry, key) !== id) throw new TypeError('Noncanonical discovery identity');
  return key;
}

/** One strict writer for Collection, review and Space records supplied by their owner adapters. */
export function secondScopeDiscoveryDocumentActions(
  registry: DiscoveryRegistry,
  observation: SecondScopeDiscoveryObservation,
  keys: readonly SecondScopeDiscoveryKey[],
): SecondScopeDiscoveryIndexAction[] {
  if (!record(observation) || !exactFields(observation, ['owner', 'snapshot']))
    throw new TypeError('Invalid second-scope discovery observation');
  const snapshot = observation.snapshot;
  if (
    !record(snapshot) ||
    !exactFields(snapshot, ['partition', 'position', 'complete', 'records']) ||
    !safeInteger(snapshot.partition) ||
    snapshot.partition > 4095 ||
    snapshot.complete !== true ||
    !Array.isArray(snapshot.records)
  )
    throw new TypeError('Incomplete second-scope discovery snapshot');
  if (observation.owner !== 'commerce' && observation.owner !== 'content')
    throw new TypeError('Unknown second-scope discovery owner');
  nativeVersion(snapshot.position);
  if (!Array.isArray(keys) || keys.length > SECOND_SCOPE_BATCH_SIZE)
    throw new RangeError('Second-scope discovery source batch exceeds its owner bound');

  const requested = new Map<string, SecondScopeDiscoveryKey>();
  for (const input of keys) {
    const key = canonicalSecondScopeKey(registry, input);
    if (key.owner !== observation.owner || partitionOf(key.route) !== snapshot.partition)
      throw new RangeError('Second-scope source and requested owner/partition disagree');
    const identity = discoveryDocumentId(registry, key);
    if (!requested.has(identity)) requested.set(identity, key);
  }
  if (snapshot.records.length > requested.size) throw new TypeError('Invalid second-scope discovery source rows');

  const rows = new Map<string, SecondScopeDiscoveryRecord>();
  for (const input of snapshot.records) {
    if (
      !record(input) ||
      !exactFields(input, ['key', 'revision', 'sourceVersion', 'names', 'descriptions', 'nameSort']) ||
      !Array.isArray(input.names) ||
      !texts(input.names) ||
      !Array.isArray(input.descriptions) ||
      !texts(input.descriptions) ||
      !(input.sourceVersion === null || validSourceVersion(input.sourceVersion)) ||
      !nullableText(input.nameSort)
    )
      throw new TypeError('Invalid second-scope discovery source row');
    const key = canonicalSecondScopeKey(registry, input.key);
    if (key.owner !== observation.owner || partitionOf(key.route) !== snapshot.partition)
      throw new TypeError('Second-scope source row has a foreign owner or partition');
    nativeVersion(input.revision);
    const identity = discoveryDocumentId(registry, key);
    if (!requested.has(identity) || rows.has(identity))
      throw new TypeError('Second-scope source returned duplicate, unrequested or foreign rows');
    rows.set(identity, {
      key,
      revision: input.revision,
      sourceVersion: input.sourceVersion,
      names: input.names,
      descriptions: input.descriptions,
      nameSort: input.nameSort,
    });
  }

  const actions: SecondScopeDiscoveryIndexAction[] = [];
  for (const [identity, key] of requested) {
    const row = rows.get(identity);
    if (row === undefined) {
      actions.push({ op: 'delete', id: identity, version: snapshot.position });
      continue;
    }
    const document: SecondScopeIndexedDiscoveryDocument = {
      document_format: MIXED_DISCOVERY_DOCUMENT_FORMAT,
      identity,
      owner: key.owner,
      kind: key.kind,
      id: key.id,
      route: key.route,
      partition: snapshot.partition,
      source_position: snapshot.position.toString(),
      revision: row.revision.toString(),
      source_version: row.sourceVersion,
      names: [...row.names],
      descriptions: [...row.descriptions],
      name_sort: row.nameSort,
    };
    validateDiscoveryDocumentFormat(registry, document);
    actions.push({ op: 'index', id: identity, version: snapshot.position, document });
  }
  return actions;
}

/** Pure allowlist projection from an already authorized native observation; performs no owner/profile reads. */
export function discoveryDocumentActions(
  registry: DiscoveryRegistry,
  observation: DiscoverySnapshot,
  keys: readonly DiscoveryKey[],
  counts?: ReadonlyMap<string, number>,
  format: 'legacy' | 'mixed-public-v1' = 'legacy',
): DiscoveryIndexAction[] {
  if (observation.owner !== 'semantic' && observation.owner !== 'accounts')
    throw new TypeError('Unknown discovery owner');
  const snapshot = observation.snapshot;
  if (!safeInteger(snapshot.partition) || snapshot.partition > 4095)
    throw new RangeError('Invalid discovery partition');
  nativeVersion(snapshot.position);
  const bound = observation.owner === 'accounts' ? ACCOUNT_DISCOVERY_BATCH_SIZE : 256;
  if (keys.length > bound) throw new RangeError('Discovery source batch exceeds its owner bound');
  const requested = new Map<string, DiscoveryKey>();
  const kindsById = new Map<string, Set<string>>();
  const firstById = new Map<string, DiscoveryKey>();
  for (const input of keys) {
    const key = registry.key(input);
    if (key.owner !== observation.owner || partitionOf(key.route) !== snapshot.partition)
      throw new RangeError('Discovery source and requested owner/partition disagree');
    const identity = discoveryDocumentId(registry, key);
    if (requested.has(identity)) continue;
    requested.set(identity, key);
    const kinds = kindsById.get(key.id) ?? new Set();
    kinds.add(key.kind);
    kindsById.set(key.id, kinds);
    firstById.set(key.id, firstById.get(key.id) ?? key);
  }
  const values = observation.owner === 'accounts' ? observation.snapshot.accounts : observation.snapshot.subjects;
  if (!Array.isArray(values) || values.length > kindsById.size) throw new TypeError('Invalid discovery source rows');
  const rows = new Map<string, (typeof values)[number]>();
  for (const value of values) {
    if (!record(value)) throw new TypeError('Invalid discovery source row');
    const kinds = kindsById.get(value.id);
    const key = firstById.get(value.id);
    if (!kinds || !key || routeOf(value.id) !== key.route || rows.has(value.id))
      throw new TypeError('Discovery source returned duplicate, unrequested or foreign rows');
    if (observation.owner === 'semantic' && (!('type' in value) || !kinds.has(value.type)))
      throw new TypeError('Subject type does not match its registered discovery kind');
    rows.set(value.id, value);
  }
  const actions: DiscoveryIndexAction[] = [];
  for (const key of requested.values()) {
    const id = discoveryDocumentId(registry, key);
    const identity = {
      document_format: format === 'legacy' ? DISCOVERY_DOCUMENT_FORMAT : MIXED_DISCOVERY_DOCUMENT_FORMAT,
      ...(format === 'legacy' ? {} : { identity: id }),
      id: key.id,
      kind: key.kind,
      route: key.route,
      partition: snapshot.partition,
      source_position: snapshot.position.toString(),
    } as const;
    let document: IndexedDiscoveryDocument | undefined;
    if (observation.owner === 'accounts') {
      const value = rows.get(key.id);
      if (value !== undefined) {
        if (!('revision' in value)) throw new TypeError('Expected an Account source row');
        nativeVersion(value.revision);
        document = {
          ...identity,
          owner: 'accounts',
          kind: 'account',
          account_kind: value.accountKind,
          handle: value.handle,
          display_name: value.displayName,
          revision: value.revision.toString(),
          ...(format === 'legacy'
            ? {}
            : {
                names: [...new Set([value.displayName, value.handle].filter((name): name is string => name !== null))],
                descriptions: [],
                name_sort: value.displayName ?? value.handle ?? MISSING_NAME,
              }),
        };
      }
    } else {
      const value = rows.get(key.id);
      if (value !== undefined && !('type' in value)) throw new TypeError('Expected a Subject source row');
      const current = value !== undefined && 'type' in value && value.type === key.kind ? value : undefined;
      const [action] = documentActions(
        {
          partition: snapshot.partition,
          position: snapshot.position,
          subjects: current === undefined ? [] : [current],
        },
        [key.id],
        counts,
      );
      if (action?.op === 'index') document = { ...action.document, ...identity, owner: 'semantic' };
    }
    if (document === undefined) actions.push({ op: 'delete', id, version: snapshot.position });
    else {
      validateDiscoveryDocument(registry, document);
      actions.push({ op: 'index', id, version: snapshot.position, document });
    }
  }
  return actions;
}

function validateSecondScopeDiscoveryDocument(
  registry: DiscoveryRegistry,
  value: Record<string, unknown>,
): SecondScopeIndexedDiscoveryDocument {
  if (
    !exactFields(value, SECOND_SCOPE_FIELDS) ||
    value.document_format !== MIXED_DISCOVERY_DOCUMENT_FORMAT ||
    (value.owner !== 'commerce' && value.owner !== 'content') ||
    typeof value.kind !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number'
  )
    throw new TypeError('Invalid second-scope discovery document identity');
  const expectedOwner = secondScopeOwner(value.kind);
  if (expectedOwner === undefined || expectedOwner !== value.owner)
    throw new TypeError('Second-scope owner does not own this kind');
  const key = canonicalSecondScopeKey(registry, {
    owner: value.owner,
    kind: value.kind,
    route: value.route,
    id: value.id,
  });
  if (
    value.identity !== discoveryDocumentId(registry, key) ||
    value.partition !== partitionOf(key.route) ||
    !decimalVersion(value.source_position) ||
    !decimalVersion(value.revision) ||
    !(value.source_version === null || validSourceVersion(value.source_version)) ||
    !texts(value.names) ||
    !texts(value.descriptions) ||
    !nullableText(value.name_sort)
  )
    throw new TypeError('Invalid second-scope discovery document');
  if (
    (key.kind === 'collection' && (value.names.length !== 1 || value.descriptions.length !== 0)) ||
    (key.kind === 'space' && (value.names.length !== 1 || value.descriptions.length !== 1))
  )
    throw new TypeError('Invalid public Collection or Space metadata');
  if ((key.kind === 'review') !== (value.source_version !== null))
    throw new TypeError('Review source version is missing or attached to another kind');
  return value as unknown as SecondScopeIndexedDiscoveryDocument;
}

/** Typed validator for the closed format-1/format-2 family and the local second-scope seam. */
export function validateDiscoveryDocumentFormat(registry: DiscoveryRegistry, value: unknown): DiscoveryDocumentValue {
  if (
    record(value) &&
    (value.owner === 'commerce' ||
      value.owner === 'content' ||
      (typeof value.kind === 'string' && secondScopeOwner(value.kind) !== undefined))
  )
    return validateSecondScopeDiscoveryDocument(registry, value);
  return validateRegisteredDiscoveryDocument(registry, value);
}

/** Backward-compatible Subject/Account typing; validation still recognizes the strict second-scope seam. */
export function validateDiscoveryDocument(registry: DiscoveryRegistry, value: unknown): IndexedDiscoveryDocument {
  return validateDiscoveryDocumentFormat(registry, value) as IndexedDiscoveryDocument;
}

/** Strict mixed _source validation, including fields which a shared mapping alone cannot prohibit per owner. */
function validateRegisteredDiscoveryDocument(registry: DiscoveryRegistry, value: unknown): IndexedDiscoveryDocument {
  if (
    !record(value) ||
    (value.document_format !== DISCOVERY_DOCUMENT_FORMAT &&
      value.document_format !== MIXED_DISCOVERY_DOCUMENT_FORMAT) ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.route !== 'number' ||
    (value.owner !== 'accounts' && value.owner !== 'semantic')
  )
    throw new TypeError('Invalid discovery document identity');
  const key = registry.key(
    value.owner === 'accounts'
      ? { owner: 'accounts', kind: 'account', id: value.id, route: value.route }
      : { owner: 'semantic', kind: value.kind, id: value.id, route: value.route },
  );
  if (value.kind !== key.kind) throw new TypeError('Invalid discovery kind');
  if (
    value.document_format === MIXED_DISCOVERY_DOCUMENT_FORMAT &&
    value.identity !== discoveryDocumentId(registry, key)
  )
    throw new TypeError('Invalid mixed identity');
  if (value.document_format === DISCOVERY_DOCUMENT_FORMAT && value.identity !== undefined)
    throw new TypeError('Legacy discovery format has no comparator identity');
  if (value.partition !== partitionOf(key.route) || !decimalVersion(value.source_position))
    throw new TypeError('Invalid discovery document partition or position');
  const allowed =
    value.owner === 'accounts'
      ? value.document_format === DISCOVERY_DOCUMENT_FORMAT
        ? ACCOUNT_FIELDS.filter((field) => !['names', 'descriptions', 'name_sort'].includes(field))
        : ACCOUNT_FIELDS
      : SUBJECT_FIELDS;
  if (Object.keys(value).some((field) => !allowed.includes(field)))
    throw new TypeError('Unsupported discovery document field');
  if (value.owner === 'accounts') {
    if (
      (value.account_kind !== 'actor' && value.account_kind !== 'organization') ||
      !nullableText(value.handle) ||
      (value.handle !== null && !HANDLE_LOOKUP_PATTERN.test(value.handle)) ||
      !nullableText(value.display_name) ||
      !decimalVersion(value.revision)
    )
      throw new TypeError('Invalid Account discovery document');
    if (
      value.document_format === MIXED_DISCOVERY_DOCUMENT_FORMAT &&
      (!texts(value.names) ||
        !Array.isArray(value.descriptions) ||
        value.descriptions.length !== 0 ||
        !nullableText(value.name_sort) ||
        JSON.stringify(value.names) !==
          JSON.stringify([...new Set([value.display_name, value.handle].filter((name) => name !== null))]))
    )
      throw new TypeError('Invalid mixed Account public fields');
  } else {
    if (
      value.type !== key.kind ||
      !safeInteger(value.security_revision) ||
      !texts(value.names) ||
      !texts(value.descriptions) ||
      !nullableText(value.name_sort) ||
      !texts(value.statements) ||
      !Array.isArray(value.facts) ||
      (value.relation_facet_overflow !== undefined && !texts(value.relation_facet_overflow)) ||
      (value.public_collection_count !== undefined && !safeInteger(value.public_collection_count)) ||
      (value.rating_score !== undefined &&
        value.rating_score !== null &&
        (typeof value.rating_score !== 'number' || !Number.isFinite(value.rating_score))) ||
      (value.rating_prior_epoch !== undefined &&
        value.rating_prior_epoch !== null &&
        !safeInteger(value.rating_prior_epoch))
    )
      throw new TypeError('Invalid Subject discovery document');
    for (const fact of value.facts) {
      if (!record(fact) || typeof fact.property !== 'string' || !texts(fact.qualifiers))
        throw new TypeError('Invalid Subject discovery fact');
      const fields =
        'value' in fact
          ? ['property', 'value', 'qualifiers']
          : 'year' in fact
            ? ['property', 'year', 'qualifiers']
            : ['property', 'amount', 'unit', 'qualifiers'];
      if (
        Object.keys(fact).some((field) => !fields.includes(field)) ||
        ('value' in fact
          ? typeof fact.value !== 'string'
          : 'year' in fact
            ? !Number.isSafeInteger(fact.year)
            : typeof fact.amount !== 'number' || !Number.isFinite(fact.amount) || typeof fact.unit !== 'string')
      )
        throw new TypeError('Invalid Subject discovery fact value');
    }
  }
  return value as IndexedDiscoveryDocument;
}

/** Typed parser for native mixed hits, including the local second-scope seam. */
export function parseDiscoveryHitKey(registry: DiscoveryRegistry, hit: unknown): DiscoveryDocumentKey {
  try {
    if (!record(hit) || typeof hit._id !== 'string') throw new TypeError('Missing discovery hit identity');
    const key = parseDiscoveryDocumentKey(registry, hit._id);
    const document = validateDiscoveryDocumentFormat(registry, hit._source);
    if (
      document.owner !== key.owner ||
      document.kind !== key.kind ||
      document.id !== key.id ||
      document.route !== key.route
    )
      throw new TypeError('Discovery hit identity disagrees with its document');
    return key;
  } catch {
    throw new SearchUnavailableError('OpenSearch discovery identity is missing or malformed');
  }
}

/** Additive parser for native mixed hits. This never changes the UUID-only Subject receipt/parser contract. */
export function parseDiscoveryHitIdentity(registry: DiscoveryRegistry, hit: unknown): DiscoveryKey {
  return parseDiscoveryHitKey(registry, hit) as DiscoveryKey;
}

/**
 * Raw native NDJSON, with exact signed-bigint external versions. The legacy bulkLines/OpenSearch.bulk path
 * serializes JS numbers and is deliberately not used for this format. No transport or generation is activated.
 */
export function discoveryBulkBody(
  registry: DiscoveryRegistry,
  index: string,
  actions: readonly AnyDiscoveryIndexAction[],
  options: { writeAlias?: string; replayDeletes?: boolean } = {},
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}discovery-g[1-9][0-9]*$/.test(index))
    throw new RangeError('Invalid discovery index name');
  if (options.writeAlias !== undefined && options.writeAlias !== `${index}-write`)
    throw new RangeError('Invalid discovery write alias');
  const lines: string[] = [];
  for (const action of actions) {
    nativeVersion(action.version);
    const key = parseDiscoveryDocumentKey(registry, action.id);
    if (action.op !== 'index' && action.op !== 'delete') throw new TypeError('Invalid discovery action');
    if (action.op === 'index') {
      const document = validateDiscoveryDocumentFormat(registry, action.document);
      if (
        document.owner !== key.owner ||
        document.kind !== key.kind ||
        document.id !== key.id ||
        document.route !== key.route ||
        document.source_position !== action.version.toString()
      )
        throw new TypeError('Discovery action and document disagree');
    }
    const metadata = JSON.stringify({
      _index: options.writeAlias ?? index,
      _id: action.id,
      // A repeated deletion has the same minimized effect, including after a lost response.
      version_type: action.op === 'delete' && options.replayDeletes ? 'external_gte' : 'external',
    });
    lines.push(`{"${action.op}":${metadata.slice(0, -1)},"version":${action.version.toString()}}}`);
    if (action.op === 'index') lines.push(JSON.stringify(action.document));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** A fresh, inert definition for one shared native family; no index creation/alias switch is performed. */
export function discoveryIndexDefinition(): DiscoveryIndexDefinition {
  return structuredClone(definition) as DiscoveryIndexDefinition;
}

/** Versioned successor; never modifies the immutable format-1 mapping. */
export function mixedDiscoveryIndexDefinition(): DiscoveryIndexDefinition {
  return structuredClone(mixedDefinition) as DiscoveryIndexDefinition;
}
