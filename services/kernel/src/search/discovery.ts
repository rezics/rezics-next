import type { Release } from '@rezics/definitions';
import type { AvatarSummary } from '../content/avatar.ts';
import type { SubjectSummary, SummaryReaderDependencies } from '../semantic/summaries.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SubjectDocument } from './document.ts';
import type { SearchRequest } from './service.ts';
import type { IndexedSubject, SubjectSource, SubjectSnapshot } from './source.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** This format is opt-in; legacy Subject IDs and generation receipts retain their meaning. */
export const DISCOVERY_DOCUMENT_FORMAT = 1;
export const ACCOUNT_DISCOVERY_BATCH_SIZE = 100;
export const MAX_ACCOUNT_DISCOVERY_BATCH = ACCOUNT_DISCOVERY_BATCH_SIZE;

export type DiscoveryKey =
  | { owner: 'semantic'; kind: string; route: number; id: string }
  | { owner: 'accounts'; kind: 'account'; route: number; id: string };

/** Already eligible native projection. Only the producer can establish eligibility and exact claims at T. */
export type IndexedAccount = {
  id: string;
  accountKind: 'actor' | 'organization';
  /** Null when the current exact active claim is absent or invalid; displayName remains eligible. */
  handle: string | null;
  displayName: string | null;
  revision: bigint;
};
export type AccountSnapshot = { partition: number; position: bigint; accounts: IndexedAccount[] };
export type AccountPageKey = { route: number; id: string };
export type AccountFrontier = AccountPageKey;
export type AccountPage = AccountSnapshot & { next: AccountPageKey | null };

export function discoveryPartition(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Discovery id must be a routable UUID');
  return partitionOf(route);
}

/** Compatibility for the earlier projection adapter; native mixed writers use discoveryDocumentId. */
export function discoveryIdentity(owner: DiscoveryKey['owner'], id: string): string {
  discoveryPartition(id);
  return `${owner === 'accounts' ? 'account' : 'subject'}:${id}`;
}
export interface AccountDiscoverySource {
  /** Deduplicate at most 100 full keys in one partition; omit unknown/ineligible rows. */
  read(partition: number, ids: readonly string[]): Promise<AccountSnapshot>;
  /** Native generation census only, never query/kind count evidence. */
  count(partition: number): Promise<{ partition: number; position: bigint; count: number }>;
  /** Native partition keyset, limit 1..100; next proves remaining eligible input. */
  page(
    partition: number,
    after: AccountPageKey | null,
    limit: number,
  ): Promise<AccountSnapshot & { next: AccountPageKey | null }>;
}
export type DiscoveryDocument =
  | { owner: 'semantic'; kind: string; value: IndexedSubject }
  | { owner: 'accounts'; kind: 'account'; value: IndexedAccount };
export type AccountDiscoverySummary = {
  id: string;
  accountKind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  automated: boolean;
  operatorId: string | null;
  avatar: AvatarSummary | null;
  verifiedAgent: { id: string; label: string; type: string } | null;
};
export type DiscoverySummary =
  | { kind: 'subject'; value: SubjectSummary }
  | { kind: 'account'; value: AccountDiscoverySummary };
export type DiscoveryHit = { key: DiscoveryKey; summary: DiscoverySummary };
export type KindCountEvidence =
  | { kind: string; value: number; exact: true }
  | { kind: string; value: number; exact: false } // strictly positive
  | { kind: string; unavailable: true };
export type DiscoveryKindMetadata = {
  id: string;
  labels: Record<string, string>;
  icon: string;
  count?: KindCountEvidence;
};
export type DiscoveryPage = {
  hits: DiscoveryHit[];
  kinds: { values: DiscoveryKindMetadata[]; next: string | null };
  next: string | null;
  as_of: string;
};
/** Declaration of the opt-in wire; the current HTTP service does not activate this representation. */
export type DiscoveryRequest = SearchRequest & { representation: 'discovery-v1'; kindCursor?: string };
/** Reuse native reader authorization/deadline and token custody, never a caller-supplied permission flag. */
export type DiscoveryReadContext = Pick<SummaryReaderDependencies, 'access' | 'actor' | 'deadline'>;
export type DiscoveryCursorKeys = KeyRing;
export type DiscoveryDomain = 'text' | 'kind' | 'type' | 'statement' | 'owner' | 'collection' | 'zone' | 'realm';
export type DiscoveryTruth = boolean | 'not_applicable' | 'not_proven';
export type DiscoveryCondition =
  | { and: readonly DiscoveryCondition[] }
  | { or: readonly DiscoveryCondition[] }
  | { not: DiscoveryCondition }
  | { domain: DiscoveryDomain; value: unknown };

type RegistrationBase = {
  readonly metadata: Readonly<Omit<DiscoveryKindMetadata, 'count'>>;
  readonly domains: readonly DiscoveryDomain[];
};
export type DiscoveryRegistration = RegistrationBase &
  (
    | {
        readonly owner: 'semantic';
        readonly kind: string;
        readonly summary: 'subject';
        readonly source: SubjectSource;
        readonly hydrate: (
          ids: readonly string[],
          context: DiscoveryReadContext,
        ) => Promise<ReadonlyMap<string, SubjectSummary>>;
      }
    | {
        readonly owner: 'accounts';
        readonly kind: 'account';
        readonly summary: 'account';
        readonly source: AccountDiscoverySource;
        readonly hydrate: (
          ids: readonly string[],
          context: DiscoveryReadContext,
        ) => Promise<ReadonlyMap<string, AccountDiscoverySummary>>;
      }
  );
export type DiscoveryRegistryOptions = {
  release: Release;
  semantic: {
    source: SubjectSource;
    hydrate: Extract<DiscoveryRegistration, { owner: 'semantic' }>['hydrate'];
    /** Presentation metadata keyed by the actual released type ID. */
    icons: Readonly<Record<string, string>>;
  };
  accounts: {
    source: AccountDiscoverySource;
    hydrate: Extract<DiscoveryRegistration, { owner: 'accounts' }>['hydrate'];
    labels: Record<string, string>;
    icon: string;
  };
};
export interface DiscoveryRegistry {
  readonly entries: readonly DiscoveryRegistration[];
  get(kind: string): DiscoveryRegistration;
  key(value: DiscoveryKey): DiscoveryKey;
}

export type DiscoverySnapshot =
  | { owner: 'semantic'; snapshot: SubjectSnapshot }
  | { owner: 'accounts'; snapshot: AccountSnapshot };
type DocumentIdentity = {
  document_format: typeof DISCOVERY_DOCUMENT_FORMAT;
  id: string;
  kind: string;
  route: number;
  partition: number;
  /** Exact decimal native position, never a floating point or timestamp surrogate. */
  source_position: string;
};
export type IndexedDiscoveryDocument =
  | (DocumentIdentity & SubjectDocument & { owner: 'semantic' })
  | (DocumentIdentity & {
      owner: 'accounts';
      kind: 'account';
      account_kind: IndexedAccount['accountKind'];
      handle: string | null;
      display_name: string | null;
      revision: string;
    });
export type DiscoveryIndexAction =
  | { op: 'index'; id: string; version: bigint; document: IndexedDiscoveryDocument }
  | { op: 'delete'; id: string; version: bigint };

/** Inert mapping contract, shared by every configured kind in the discovery family. */
export type DiscoveryIndexDefinition = {
  settings: Record<string, unknown>;
  mappings: {
    _meta: {
      discovery_document_format: typeof DISCOVERY_DOCUMENT_FORMAT;
      name_sort_format: number;
      document_identity: string;
    };
    dynamic: 'strict';
    properties: Record<string, Record<string, unknown>>;
  };
};

/** Canonical mixed root: provisional DiscoveryCondition values are never admitted engine input. */
import type { FilterDocument } from '@rezics/filter';
import type { PublicFilterConsumerCaptureInput, PublicFilterConsumerQuery } from './public-filter-consumer-contract.ts';
type DiscoveryFilterLeaf = Exclude<FilterDocument, { and: unknown } | { or: unknown } | { not: unknown }>;
export type DiscoveryFilterDocument =
  | Readonly<{ and: readonly DiscoveryFilterDocument[] }>
  | Readonly<{ or: readonly DiscoveryFilterDocument[] }>
  | Readonly<{ not: DiscoveryFilterDocument }>
  | DiscoveryFilterLeaf
  | Readonly<{ kind: Readonly<{ in: readonly string[] }> }>;
export type DiscoveryConsumerCaptureInput = Omit<PublicFilterConsumerCaptureInput, 'filterDocument'> &
  Readonly<{
    representation: 'discovery-v1';
    filterDocument: DiscoveryFilterDocument | undefined;
    comparator: 'mixed-public-v1';
  }>;
export type DiscoveryEngineHit = Readonly<{
  key: DiscoveryKey;
  index: string;
  sourcePosition: string;
  revision: string;
  matched: readonly string[];
  sort: readonly (string | number | null)[];
}>;
export type DiscoveryEngineResult = Readonly<{ generation?: number; hits: readonly DiscoveryEngineHit[] }>;
export type DiscoveryConsumerQuery =
  | (Omit<Extract<PublicFilterConsumerQuery, { status: 'queried' }>, 'result'> &
      Readonly<{ result: DiscoveryEngineResult }>)
  | Exclude<PublicFilterConsumerQuery, { status: 'queried' }>;

import { FILTER_LIMITS, admitFilter, parseFilter, walkFilter } from '@rezics/filter';
import { compileFilter } from './filter.ts';
import { compileText } from './text.ts';
import type {
  PublicFilterProjectionMeaning,
  PublicFilterDependencyKey,
} from '../semantic/public-filter-source-contract.ts';
type EngineClause = Record<string, unknown>;
/** Full mixed grammar admission; compile each configured domain before combining native ranking. */
export function compileDiscoveryConsumerCapture(
  input: DiscoveryConsumerCaptureInput,
  meaning: PublicFilterProjectionMeaning,
  registry: DiscoveryRegistry | undefined,
): Readonly<{ query: EngineClause; dependencyKeys: readonly PublicFilterDependencyKey[] }> {
  if (
    input.representation !== 'discovery-v1' ||
    input.comparator !== 'mixed-public-v1' ||
    !Object.hasOwn(input, 'filterDocument') ||
    !Object.hasOwn(input, 'text') ||
    !['id', 'name', 'relevance'].includes(input.sort) ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 100 ||
    (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100))
  )
    throw new TypeError('Invalid canonical mixed capture');
  let leaves = 0;
  const keys: PublicFilterDependencyKey[] = [
    { kind: 'type' },
    { kind: 'order', order: input.sort },
    { kind: 'order', order: 'id' },
  ];
  function admit(node: DiscoveryFilterDocument, depth: number): DiscoveryFilterDocument {
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1)
      throw new TypeError('Invalid mixed filter node');
    if ('and' in node || 'or' in node) {
      if (depth >= FILTER_LIMITS.depth) throw new RangeError('Mixed filter depth exceeds limit');
      const children = 'and' in node ? node.and : node.or;
      if (
        !Array.isArray(children) ||
        children.length === 0 ||
        children.length > FILTER_LIMITS.leaves ||
        ('or' in node && children.length > FILTER_LIMITS.or)
      )
        throw new RangeError('Mixed Boolean width exceeds limit');
      return 'and' in node
        ? { and: children.map((child) => admit(child, depth + 1)) }
        : { or: children.map((child) => admit(child, depth + 1)) };
    }
    if ('not' in node) {
      if (depth >= FILTER_LIMITS.depth || 'not' in node.not) throw new RangeError('Invalid mixed negation');
      return { not: admit(node.not, depth + 1) };
    }
    if (++leaves > FILTER_LIMITS.leaves) throw new RangeError('Mixed filter leaves exceed limit');
    if ('kind' in node) {
      if (
        !node.kind ||
        Object.keys(node.kind).length !== 1 ||
        !Array.isArray(node.kind.in) ||
        node.kind.in.length < 1 ||
        node.kind.in.length > FILTER_LIMITS.in ||
        node.kind.in.some((kind) => typeof kind !== 'string' || !kind)
      )
        throw new TypeError('Invalid kind predicate');
      for (const kind of node.kind.in) registry?.get(kind);
      return { kind: { in: [...new Set(node.kind.in)] } };
    }
    const leaf = parseFilter(node);
    for (const child of walkFilter(leaf))
      if ('owner' in child || 'saved' in child)
        throw new TypeError('Public mixed capture requires expanded non-owner leaves');
    const accepted = admitFilter(leaf, meaning.release, { saved: false });
    const compiled = compileFilter(accepted, { prefix: `d${leaves}-`, relationOverflow: true });
    for (const item of compiled.leaves)
      if (item.facet === 'statement') {
        keys.push({ kind: 'property', property: item.property });
        for (const qualifier of item.qualifiers ?? []) {
          keys.push({ kind: 'property', property: qualifier.property });
          if (++leaves > FILTER_LIMITS.leaves) throw new RangeError('Mixed qualifiers exceed limit');
        }
      }
    return accepted;
  }
  const root = input.filterDocument === undefined ? undefined : admit(input.filterDocument, 0);
  const all: EngineClause = { match_all: {} };
  const none: EngineClause = { match_none: {} };
  const conjunction = (queries: EngineClause[]): EngineClause => ({ bool: { filter: queries } });
  const disjunction = (queries: EngineClause[]): EngineClause => ({
    bool: { should: queries, minimum_should_match: 1 },
  });
  function clauses(
    node: DiscoveryFilterDocument,
    kind: string,
    owner: 'semantic' | 'accounts',
  ): [EngineClause, EngineClause] {
    if ('not' in node) {
      const [yes, no] = clauses(node.not, kind, owner);
      return [no, yes];
    }
    if ('and' in node || 'or' in node) {
      const children = ('and' in node ? node.and : node.or).map((child) => clauses(child, kind, owner));
      return 'and' in node
        ? [conjunction(children.map((v) => v[0])), disjunction(children.map((v) => v[1]))]
        : [disjunction(children.map((v) => v[0])), conjunction(children.map((v) => v[1]))];
    }
    if ('kind' in node) return node.kind.in.includes(kind) ? [all, none] : [none, all];
    // not_applicable remains not_applicable through NOT and mixed Boolean evaluation.
    if (owner === 'accounts') return [none, none];
    return [
      compileFilter(node, { prefix: 'd', relationOverflow: true }).query,
      compileFilter({ not: node }, { prefix: 'dn', relationOverflow: true }).query,
    ];
  }
  const text = input.text === undefined ? undefined : compileText(input.text, { field: 'search_text', prefix: 't' });
  if (text)
    keys.push(
      { kind: 'field', field: 'labels' },
      { kind: 'field', field: 'aliases' },
      { kind: 'field', field: 'descriptions' },
    );
  const filter = registry
    ? disjunction(
        registry.entries.map((entry) =>
          conjunction([{ term: { kind: entry.kind } }, root ? clauses(root, entry.kind, entry.owner)[0] : all]),
        ),
      )
    : none;
  const query = { bool: { must: text?.query ?? all, filter } };
  // Optional compiled fields are evidence only, never admitted authority.
  if (input.filter !== undefined && JSON.stringify(input.filter) !== JSON.stringify(filter))
    throw new TypeError('Mixed filter DSL mismatch');
  if (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(text?.query))
    throw new TypeError('Mixed text DSL mismatch');
  return { query, dependencyKeys: keys };
}
