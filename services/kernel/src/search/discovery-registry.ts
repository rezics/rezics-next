import { RELEASE_LIMITS } from '@rezics/definitions';
import { routeOf } from '../route/route.ts';
import type {
  DiscoveryCondition,
  DiscoveryDomain,
  DiscoveryKey,
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
export function createDiscoveryRegistry(options: DiscoveryRegistryOptions): DiscoveryRegistry {
  const types = Object.entries(options.release.types);
  if (types.length > RELEASE_LIMITS.types) throw new RangeError('Discovery catalogue exceeds the release limit');
  const byKind = new Map<string, DiscoveryRegistration>();
  for (const [kind, type] of types) {
    if (kind === 'account') throw new TypeError('The account kind is reserved for Accounts');
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
  });
}

/** Domain admission is independent of membership, resource authorization and native source availability. */
export function discoveryDomain(
  registry: DiscoveryRegistry,
  kind: string,
  domain: DiscoveryDomain,
): 'applicable' | 'not_applicable' {
  if (!SUBJECT_DOMAINS.includes(domain)) throw new TypeError('Unsupported discovery condition domain');
  return registry.get(kind).domains.includes(domain) ? 'applicable' : 'not_applicable';
}

/**
 * Evaluate an expanded/admitted planner tree. Leaf evidence is current native evidence, never an eligibility
 * callback. Callers must authorize ALL referenced resources before this operation; OR cannot grant access.
 * Unknown domains reject even in a branch whose truth would otherwise short circuit.
 */
export function evaluateDiscoveryCondition(
  registry: DiscoveryRegistry,
  kind: string,
  condition: DiscoveryCondition,
  evidence: (leaf: Extract<DiscoveryCondition, { domain: DiscoveryDomain }>) => DiscoveryTruth,
): DiscoveryTruth {
  registry.get(kind);
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
