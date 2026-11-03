import { RELEASE_LIMITS } from '@rezics/definitions';
import { routeOf } from '../route/route.ts';
import type {
  DiscoveryCondition,
  DiscoveryDomain,
  DiscoveryKey,
  DiscoveryOwnerAdapter,
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerKind,
  DiscoveryOwnerKey,
  DiscoveryOwnerRegistry,
  DiscoveryOwnerRegistration,
  DiscoveryRegistration,
  DiscoveryRegistry,
  DiscoveryRegistryOptions,
  DiscoveryTruth,
  KindCountEvidence,
} from './discovery.ts';

const SUBJECT_DOMAINS: readonly DiscoveryDomain[] = Object.freeze([
  'text',
  'kind',
  'type',
  'statement',
  'owner',
  'collection',
  'zone',
  'realm',
]);
const ACCOUNT_DOMAINS: readonly DiscoveryDomain[] = Object.freeze(['text', 'kind']);
const OWNER_DOMAINS = Object.freeze(['text', 'kind'] as const);
const UNAVAILABLE_OWNER_ADAPTERS: DiscoveryOwnerAdapterSlots = Object.freeze({
  collection: Object.freeze({ readiness: 'unavailable' }),
  review: Object.freeze({ readiness: 'unavailable' }),
  space: Object.freeze({ readiness: 'unavailable' }),
});

function metadata(id: string, labels: Record<string, string>, icon: string) {
  if (
    !id ||
    typeof icon !== 'string' ||
    !icon ||
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.keys(labels).length === 0 ||
    Object.values(labels).some((label) => typeof label !== 'string' || !label)
  )
    throw new TypeError('Discovery kinds require localized labels and an icon');
  return Object.freeze({ id, labels: Object.freeze({ ...labels }), icon });
}

/** Closed dispatch: released catalogue types and the Accounts source, with no arbitrary owner registration. */
export function createDiscoveryRegistry(
  options: DiscoveryRegistryOptions,
): DiscoveryRegistry & DiscoveryOwnerRegistry {
  const types = Object.entries(options.release.types);
  if (types.length > RELEASE_LIMITS.types) throw new RangeError('Discovery catalogue exceeds the release limit');
  const byKind = new Map<string, DiscoveryRegistration>();
  const ownerByKind = new Map<DiscoveryOwnerKind, DiscoveryOwnerRegistration>();
  for (const [kind, type] of types) {
    if (kind === 'account' || kind === 'collection' || kind === 'review' || kind === 'space')
      throw new TypeError(`The ${kind} kind is reserved for its discovery owner`);
    byKind.set(
      kind,
      Object.freeze({
        owner: 'semantic',
        kind,
        summary: 'subject',
        domains: SUBJECT_DOMAINS,
        metadata: metadata(kind, type.labels, options.semantic.icons[kind]!),
        source: options.semantic.source,
        hydrate: options.semantic.hydrate,
      }),
    );
  }

  function ownerAdapter<K extends DiscoveryOwnerKind, O extends 'commerce' | 'content'>(
    kind: K,
    owner: O,
    slot: DiscoveryOwnerAdapterSlots[K],
  ): DiscoveryOwnerAdapterSlots[K] {
    if (!slot || typeof slot !== 'object') throw new TypeError(`Invalid ${kind} discovery adapter slot`);
    if (slot.readiness === 'unavailable') {
      if (Object.keys(slot).some((key) => key !== 'readiness'))
        throw new TypeError(`Unavailable ${kind} discovery adapter has a payload`);
      return Object.freeze({ readiness: 'unavailable' }) as DiscoveryOwnerAdapterSlots[K];
    }
    if (slot.readiness !== 'ready' || Object.keys(slot).some((key) => !['readiness', 'adapter'].includes(key)))
      throw new TypeError(`Invalid ${kind} discovery adapter readiness`);
    const adapter = slot.adapter as DiscoveryOwnerAdapter<K, O>;
    if (
      !adapter ||
      adapter.owner !== owner ||
      adapter.kind !== kind ||
      typeof adapter.readCurrent !== 'function' ||
      !adapter.metadata ||
      typeof adapter.metadata !== 'object' ||
      adapter.metadata.id !== kind
    )
      throw new TypeError(`Invalid ${kind} discovery owner adapter`);
    if (Object.keys(adapter).some((key) => !['owner', 'kind', 'metadata', 'readCurrent'].includes(key)))
      throw new TypeError(`Unsupported ${kind} discovery adapter field`);
    if (Object.keys(adapter.metadata).some((key) => !['id', 'labels', 'icon'].includes(key)))
      throw new TypeError(`Unsupported ${kind} discovery metadata field`);
    const normalized: DiscoveryOwnerAdapter<K, O> = Object.freeze({
      owner,
      kind,
      metadata: metadata(kind, adapter.metadata.labels, adapter.metadata.icon),
      readCurrent: adapter.readCurrent,
    });
    ownerByKind.set(kind, Object.freeze({ ...normalized, domains: OWNER_DOMAINS }) as DiscoveryOwnerRegistration);
    return Object.freeze({ readiness: 'ready', adapter: normalized }) as unknown as DiscoveryOwnerAdapterSlots[K];
  }
  const supplied = options.ownerAdapters ?? UNAVAILABLE_OWNER_ADAPTERS;
  const ownerAdapters: DiscoveryOwnerAdapterSlots = Object.freeze({
    collection: ownerAdapter('collection', 'commerce', supplied.collection),
    review: ownerAdapter('review', 'content', supplied.review),
    space: ownerAdapter('space', 'content', supplied.space),
  });

  byKind.set(
    'account',
    Object.freeze({
      owner: 'accounts',
      kind: 'account',
      summary: 'account',
      domains: ACCOUNT_DOMAINS,
      metadata: metadata('account', options.accounts.labels, options.accounts.icon),
      source: options.accounts.source,
      hydrate: options.accounts.hydrate,
    }),
  );
  const get = (kind: string): DiscoveryRegistration => {
    const entry = byKind.get(kind);
    if (!entry) throw new RangeError('Unregistered discovery kind');
    return entry;
  };
  return Object.freeze({
    entries: Object.freeze([...byKind.values()]),
    get,
    ownerAdapters,
    getOwnerAdapter(kind: DiscoveryOwnerKind) {
      const entry = ownerByKind.get(kind);
      if (!entry) throw new RangeError('Unregistered discovery kind');
      return entry;
    },
    domains(kind: string) {
      const entry = byKind.get(kind) ?? ownerByKind.get(kind as DiscoveryOwnerKind);
      if (!entry) throw new RangeError('Unregistered discovery kind');
      return entry.domains;
    },
    key(value: DiscoveryKey): DiscoveryKey {
      const entry = get(value.kind);
      const route = routeOf(value.id);
      if (entry.owner !== value.owner) throw new TypeError('Discovery owner does not own this kind');
      if (route === null || route !== value.route)
        throw new RangeError('Discovery key has an invalid or foreign route');
      // Copy only the canonical identity; do not retain caller-added profile/authority fields.
      return entry.owner === 'accounts'
        ? { owner: 'accounts', kind: 'account', route, id: value.id }
        : { owner: 'semantic', kind: entry.kind, route, id: value.id };
    },
    ownerKey(value: DiscoveryOwnerKey): DiscoveryOwnerKey {
      const entry = ownerByKind.get(value.kind);
      if (!entry) throw new RangeError('Unregistered discovery kind');
      const route = routeOf(value.id);
      if (entry.owner !== value.owner) throw new TypeError('Discovery owner does not own this kind');
      if (route === null || route !== value.route)
        throw new RangeError('Discovery key has an invalid or foreign route');
      return entry.kind === 'collection'
        ? { owner: 'commerce', kind: 'collection', route, id: value.id }
        : entry.kind === 'review'
          ? { owner: 'content', kind: 'review', route, id: value.id }
          : { owner: 'content', kind: 'space', route, id: value.id };
    },
  });
}

function registeredDomains(registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>, kind: string) {
  return registry.domains ? registry.domains(kind) : registry.get(kind).domains;
}

/** Domain admission is independent of membership, resource authorization and native source availability. */
export function discoveryDomain(
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
  kind: string,
  domain: DiscoveryDomain,
): 'applicable' | 'not_applicable' {
  if (!SUBJECT_DOMAINS.includes(domain)) throw new TypeError('Unsupported discovery condition domain');
  return registeredDomains(registry, kind).includes(domain) ? 'applicable' : 'not_applicable';
}

/**
 * Evaluate an expanded/admitted planner tree. Leaf evidence is current native evidence, never an eligibility
 * callback. Callers must authorize ALL referenced resources before this operation; OR cannot grant access.
 * Unknown domains reject even in a branch whose truth would otherwise short circuit.
 */
export function evaluateDiscoveryCondition(
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
  kind: string,
  condition: DiscoveryCondition,
  evidence: (leaf: Extract<DiscoveryCondition, { domain: DiscoveryDomain }>) => DiscoveryTruth,
): DiscoveryTruth {
  registeredDomains(registry, kind);
  function evaluate(node: DiscoveryCondition): DiscoveryTruth {
    if ('not' in node) {
      const value = evaluate(node.not);
      return typeof value === 'boolean' ? !value : value;
    }
    if ('and' in node || 'or' in node) {
      const conjunction = 'and' in node;
      const values = (conjunction ? node.and : node.or).map(evaluate);
      if (values.includes(!conjunction)) return !conjunction;
      if (values.includes('not_proven')) return 'not_proven';
      if (values.includes('not_applicable')) return 'not_applicable';
      return conjunction;
    }
    if (discoveryDomain(registry, kind, node.domain) === 'not_applicable') return 'not_applicable';
    const value = evidence(node);
    if (value !== true && value !== false && value !== 'not_applicable' && value !== 'not_proven')
      throw new TypeError('Invalid discovery condition evidence');
    return value;
  }
  return evaluate(condition);
}

/** Counts must come from a certified query population, never the source's generation census or row length. */
export function validateKindCountEvidence(registry: DiscoveryRegistry, count: KindCountEvidence): KindCountEvidence {
  registry.get(count.kind);
  if ('unavailable' in count) {
    if (count.unavailable !== true || Object.keys(count).some((key) => key !== 'kind' && key !== 'unavailable'))
      throw new TypeError('Invalid unavailable kind count');
    return { kind: count.kind, unavailable: true };
  }
  if (
    typeof count.exact !== 'boolean' ||
    !Number.isSafeInteger(count.value) ||
    count.value < 0 ||
    (!count.exact && count.value === 0) ||
    Object.keys(count).some((key) => !['kind', 'value', 'exact'].includes(key))
  )
    throw new TypeError('Invalid kind count evidence');
  return { kind: count.kind, value: count.value, exact: count.exact };
}
