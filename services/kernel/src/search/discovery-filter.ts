import { isDeepStrictEqual } from 'node:util';
import {
  parseDiscoveryFilter,
  admitDiscoveryFilter,
  type DiscoveryFilterDocument,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import { FilterError } from '@rezics/filter';
import type { DiscoveryCondition, DiscoveryRegistry, DiscoveryConsumerCaptureInput } from './discovery.ts';
import { compileText } from './text.ts';
import { discoveryNativeQuery } from './discovery-query.ts';
import { compileFilter } from './filter.ts';
import type {
  PublicFilterDependencyKey,
  PublicFilterProjectionMeaning,
} from '../semantic/public-filter-source-contract.ts';

type Query = Record<string, unknown>;
const none: Query = { match_none: {} };
const and = (queries: Query[]): Query => ({ bool: { filter: queries } });
const or = (queries: Query[]): Query => ({ bool: { should: queries, minimum_should_match: 1 } });
const not = (query: Query): Query => ({ bool: { must_not: [query] } });

/** Both polarities are compiled: NOT unknown must never become an Account complement. */
export function compileDiscoveryFilter(
  filter: DiscoveryFilterDocument,
  registry: DiscoveryRegistry,
  release: FilterRelease,
): { query: Query; condition: DiscoveryCondition } {
  let ordinal = 0;
  type Compiled = { yes: Query; no: Query; condition: DiscoveryCondition };
  function compile(node: DiscoveryFilterDocument): Compiled {
    if ('not' in node) {
      const child = compile(node.not);
      return { yes: child.no, no: child.yes, condition: { not: child.condition } };
    }
    if ('and' in node || 'or' in node) {
      const conjunction = 'and' in node;
      const children = (conjunction ? node.and : node.or).map(compile);
      return {
        yes: (conjunction ? and : or)(children.map((child) => child.yes)),
        no: (conjunction ? or : and)(children.map((child) => child.no)),
        condition: conjunction
          ? { and: children.map((child) => child.condition) }
          : { or: children.map((child) => child.condition) },
      };
    }
    const prefix = `f${ordinal++}_`;
    if ('kind' in node) {
      node.kind.in.forEach((kind) => registry.get(kind));
      const yes = { terms: { kind: [...node.kind.in] } };
      return { yes, no: not(yes), condition: { domain: 'kind', value: node.kind.in } };
    }
    if ('realm' in node) throw new FilterError('unsupported_query', '/realm', 'unsupported');
    if ('ratingQuestion' in node) throw new FilterError('unsupported_query', '/ratingQuestion', 'unsupported');
    if ('saved' in node || 'owner' in node)
      throw new FilterError('unsupported_query', 'owner' in node ? '/owner' : '/saved', 'unsupported');
    // Released catalogue bases match their configured subtypes, without inventing an Account type.
    const leaf: FilterDocument =
      'type' in node
        ? {
            type: {
              in: registry.entries.flatMap((entry) =>
                entry.owner === 'semantic' &&
                node.type.in.some((type) => type === entry.kind || release.types[entry.kind]?.bases?.includes(type))
                  ? [entry.kind]
                  : [],
              ),
            },
          }
        : node;
    const owner = { term: { owner: 'semantic' } };
    return {
      yes: and([owner, compileFilter(leaf, { prefix, relationOverflow: true }).query]),
      no: and([owner, compileFilter({ not: leaf }, { prefix, relationOverflow: true }).query]),
      condition: { domain: 'type' in leaf ? 'type' : 'statement', value: leaf },
    };
  }
  const result = compile(filter);
  return {
    query: and([{ terms: { kind: registry.entries.map((entry) => entry.kind) } }, result.yes]),
    condition: result.condition,
  };
}

/** The unfiltered mixed population is registry bounded; it never includes unregistered producers. */
export function discoveryPopulation(registry: DiscoveryRegistry): Query {
  return registry.entries.length ? { terms: { kind: registry.entries.map((entry) => entry.kind) } } : none;
}

type CurrentPredicate = boolean | FilterDocument;

/** Specialize an admitted tree before the existing current catalogue matcher, retaining both truth polarities.
 * A false result is no proof of the complement: Account-unsupported leaves have neither polarity.
 */
export function currentDiscoveryFilter(
  filter: DiscoveryFilterDocument,
  registry: DiscoveryRegistry,
  kind: string,
  release: FilterRelease,
): CurrentPredicate {
  const entry = registry.get(kind);
  function combine(conjunction: boolean, predicates: CurrentPredicate[]): CurrentPredicate {
    if (predicates.includes(!conjunction)) return !conjunction;
    const children = predicates.filter((predicate): predicate is FilterDocument => typeof predicate !== 'boolean');
    if (!children.length) return conjunction;
    if (children.length === 1) return children[0]!;
    return conjunction ? { and: children } : { or: children };
  }
  function specialize(node: DiscoveryFilterDocument): { yes: CurrentPredicate; no: CurrentPredicate } {
    if ('not' in node) {
      const child = specialize(node.not);
      return { yes: child.no, no: child.yes };
    }
    if ('and' in node || 'or' in node) {
      const conjunction = 'and' in node;
      const children = (conjunction ? node.and : node.or).map(specialize);
      return {
        yes: combine(
          conjunction,
          children.map((child) => child.yes),
        ),
        no: combine(
          !conjunction,
          children.map((child) => child.no),
        ),
      };
    }
    if ('kind' in node) {
      const yes = node.kind.in.includes(kind);
      return { yes, no: !yes };
    }
    if ('realm' in node) throw new FilterError('unsupported_query', '/realm', 'unsupported');
    if ('ratingQuestion' in node) throw new FilterError('unsupported_query', '/ratingQuestion', 'unsupported');
    if ('saved' in node || 'owner' in node)
      throw new FilterError('unsupported_query', 'owner' in node ? '/owner' : '/saved', 'unsupported');
    if (entry.owner === 'accounts') return { yes: false, no: false };
    if ('type' in node) {
      const yes = node.type.in.some((type) => type === kind || release.types[kind]?.bases?.includes(type));
      return { yes, no: !yes };
    }
    return { yes: node, no: { not: node } };
  }
  return specialize(filter).yes;
}

/** Derive native evidence from the exact admitted root. Size/frontier remain execution data. */
export function compileDiscoveryCapture(
  input: DiscoveryConsumerCaptureInput,
  registry: DiscoveryRegistry,
  release: FilterRelease,
): DiscoveryConsumerCaptureInput {
  if (
    input.representation !== 'discovery-v1' ||
    input.comparator !== 'mixed-public-v1' ||
    !['id', 'name', 'relevance'].includes(input.sort) ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 200 ||
    !Number.isInteger(input.pageSize) ||
    input.pageSize! < 1 ||
    input.pageSize! > 100
  )
    throw new RangeError('Invalid mixed capture');
  const filterDocument = input.filterDocument
    ? admitDiscoveryFilter(input.filterDocument, release, new Set(registry.entries.map((entry) => entry.kind)))
    : undefined;
  const compiled = filterDocument ? compileDiscoveryFilter(filterDocument, registry, release) : undefined;
  const text = input.text ? compileText(input.text, { field: 'search_text', prefix: 't' }) : undefined;
  const filter = compiled?.query ?? discoveryPopulation(registry);
  if (
    (input.query !== undefined && !isDeepStrictEqual(input.query, text?.query)) ||
    (input.filter !== undefined && !isDeepStrictEqual(input.filter, filter))
  )
    throw new TypeError('Compiled mixed evidence disagrees with the admitted root');
  const properties = new Set<string>();
  function visit(node: DiscoveryFilterDocument): void {
    if ('and' in node) node.and.forEach(visit);
    else if ('or' in node) node.or.forEach(visit);
    else if ('not' in node) visit(node.not);
    else if ('statement' in node) properties.add(node.statement.property);
  }
  if (filterDocument) visit(filterDocument);
  return {
    ...input,
    filterDocument,
    filter,
    ...(text ? { query: text.query } : {}),
    overflowProperties: [...properties],
  };
}

/** Native consumer and custody derive identical dependencies from the immutable mixed root.
 * Custody can validate dependency coverage without a registry; native execution still requires the actual registry.
 */
export function compileDiscoveryConsumerCapture(
  input: DiscoveryConsumerCaptureInput,
  meaning: PublicFilterProjectionMeaning,
  registry: DiscoveryRegistry | undefined,
): Readonly<{ query: Query; dependencyKeys: readonly PublicFilterDependencyKey[] }> {
  if (!Object.hasOwn(input, 'filterDocument') || !Object.hasOwn(input, 'text'))
    throw new TypeError('Mixed capture requires the exact root');
  const keys: PublicFilterDependencyKey[] = [
    { kind: 'type' },
    { kind: 'order', order: input.sort },
    { kind: 'order', order: 'id' },
  ];
  const kinds = new Set<string>();
  function visit(node: DiscoveryFilterDocument, dependencies: boolean): void {
    if ('and' in node) node.and.forEach((child) => visit(child, dependencies));
    else if ('or' in node) node.or.forEach((child) => visit(child, dependencies));
    else if ('not' in node) visit(node.not, dependencies);
    else if ('kind' in node) node.kind.in.forEach((kind) => kinds.add(kind));
    else if ('realm' in node) throw new FilterError('unsupported_query', '/realm', 'unsupported');
    else if ('ratingQuestion' in node) throw new FilterError('unsupported_query', '/ratingQuestion', 'unsupported');
    else {
      if ('owner' in node || 'saved' in node) throw new TypeError('Mixed public capture requires expanded leaves');
      if (dependencies)
        for (const leaf of compileFilter(node, { prefix: 'd', relationOverflow: true }).leaves) {
          if (leaf.facet !== 'statement') continue;
          keys.push({ kind: 'property', property: leaf.property });
          for (const qualifier of leaf.qualifiers ?? []) keys.push({ kind: 'property', property: qualifier.property });
        }
    }
  }
  // Public admission runs before traversing caller structures for dependency extraction.
  if (!registry) {
    if (
      input.representation !== 'discovery-v1' ||
      input.comparator !== 'mixed-public-v1' ||
      !['id', 'name', 'relevance'].includes(input.sort) ||
      !Number.isInteger(input.size) ||
      input.size < 1 ||
      input.size > 200 ||
      !Number.isInteger(input.pageSize) ||
      input.pageSize! < 1 ||
      input.pageSize! > 100
    )
      throw new RangeError('Invalid mixed capture');
    // The closed parser bounds structure before collecting names; Source owns configured-domain authority.
    const parsed = input.filterDocument === undefined ? undefined : parseDiscoveryFilter(input.filterDocument);
    if (parsed) visit(parsed, false);
    const admitted = parsed === undefined ? undefined : admitDiscoveryFilter(parsed, meaning.release, kinds);
    if (admitted) visit(admitted, true);
  }
  const plan = registry ? compileDiscoveryCapture(input, registry, meaning.release) : input;
  if (registry && plan.filterDocument) visit(plan.filterDocument, true);
  if (input.text !== undefined)
    keys.push(
      { kind: 'field', field: 'labels' },
      { kind: 'field', field: 'aliases' },
      { kind: 'field', field: 'descriptions' },
    );
  const text = input.text === undefined ? undefined : compileText(input.text, { field: 'search_text', prefix: 't' });
  return {
    query: discoveryNativeQuery({
      filter: plan.filter ?? none,
      ...(text ? { query: text.query } : {}),
      ...(input.boost === undefined ? {} : { boost: input.boost }),
    }),
    dependencyKeys: keys,
  };
}
