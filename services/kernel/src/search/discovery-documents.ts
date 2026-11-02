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
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.isWellFormed());
}
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Canonical kind+ID key. Owner is resolved through the closed registry, never inferred from a raw UUID. */
export function discoveryDocumentId(registry: DiscoveryRegistry, key: DiscoveryKey): string {
  const canonical = registry.key(key);
  const id = `${ID_PREFIX}${encodeURIComponent(canonical.kind)}:${canonical.id}`;
  if (Buffer.byteLength(id, 'utf8') > 512)
    throw new RangeError('Discovery document identity exceeds the native ID limit');
  return id;
}

/** A legacy UUID receipt is intentionally invalid here. Never pass tagged IDs to the legacy Subject parser. */
export function parseDiscoveryDocumentId(registry: DiscoveryRegistry, id: string): DiscoveryKey {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) throw new TypeError('Expected a tagged discovery identity');
  const separator = id.lastIndexOf(':');
  const kind = decodeURIComponent(id.slice(ID_PREFIX.length, separator));
  const nativeId = id.slice(separator + 1);
  const entry = registry.get(kind);
  const route = routeOf(nativeId);
  if (route === null) throw new RangeError('Invalid native discovery ID');
  const key: DiscoveryKey =
    entry.owner === 'accounts'
      ? { owner: 'accounts', kind: 'account', route, id: nativeId }
      : { owner: 'semantic', kind, route, id: nativeId };
  if (discoveryDocumentId(registry, key) !== id) throw new TypeError('Noncanonical discovery identity');
  return key;
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

/** Strict mixed _source validation, including fields which a shared mapping alone cannot prohibit per owner. */
export function validateDiscoveryDocument(registry: DiscoveryRegistry, value: unknown): IndexedDiscoveryDocument {
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

/** Additive parser for native mixed hits. This never changes the UUID-only Subject receipt/parser contract. */
export function parseDiscoveryHitIdentity(registry: DiscoveryRegistry, hit: unknown): DiscoveryKey {
  try {
    if (!record(hit) || typeof hit._id !== 'string') throw new TypeError('Missing discovery hit identity');
    const key = parseDiscoveryDocumentId(registry, hit._id);
    const document = validateDiscoveryDocument(registry, hit._source);
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

/**
 * Raw native NDJSON, with exact signed-bigint external versions. The legacy bulkLines/OpenSearch.bulk path
 * serializes JS numbers and is deliberately not used for this format. No transport or generation is activated.
 */
export function discoveryBulkBody(
  registry: DiscoveryRegistry,
  index: string,
  actions: readonly DiscoveryIndexAction[],
  options: { writeAlias?: string; replayDeletes?: boolean } = {},
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}discovery-g[1-9][0-9]*$/.test(index))
    throw new RangeError('Invalid discovery index name');
  if (options.writeAlias !== undefined && options.writeAlias !== `${index}-write`)
    throw new RangeError('Invalid discovery write alias');
  const lines: string[] = [];
  for (const action of actions) {
    nativeVersion(action.version);
    const key = parseDiscoveryDocumentId(registry, action.id);
    if (action.op !== 'index' && action.op !== 'delete') throw new TypeError('Invalid discovery action');
    if (action.op === 'index') {
      const document = validateDiscoveryDocument(registry, action.document);
      if (
        document.owner !== key.owner ||
        document.kind !== key.kind ||
        document.id !== key.id ||
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
