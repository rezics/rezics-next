import type { DiscoveryFilterDocument, FilterDocument, FilterQualifier, FilterRange } from '@rezics/filter';
import { compileFilter } from './filter.ts';

export type TaggedWorkOrder = 'name' | 'id' | 'rating';
export type TaggedWorkSource = 'native-catalogue' | 'concept-retained';
export type TaggedWorkExecution = 'direct' | 'preparing';

export type TaggedWorkConceptSelection = Readonly<{
  property: string;
  concept: string;
  scheme: string;
  includeChildren: boolean;
  qualifiers: readonly FilterQualifier[];
}>;

export type TaggedWorkQuantityLeaf = Readonly<{
  property: string;
  range: FilterRange;
  onConceptStatement: boolean;
}>;

export type TaggedWorkPlan = Readonly<{
  filter: DiscoveryFilterDocument;
  remaining: DiscoveryFilterDocument | undefined;
  kindLeaf: { readonly kind: { readonly in: readonly string[] } };
  kindCountLeaf: number;
  selectedKinds: readonly string[];
  sort: TaggedWorkOrder;
  limit: number;
  scanBound: number;
  source: TaggedWorkSource;
  execution: TaggedWorkExecution;
  conceptSelections: readonly TaggedWorkConceptSelection[];
  quantityLeaves: readonly TaggedWorkQuantityLeaf[];
  overflowProperties: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kindOperand(value: unknown): { kind: { in: readonly string[] } } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.kind)) return;
  const selected = value.kind.in;
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.some((entry) => typeof entry !== 'string' || !entry || entry === 'subject')
  )
    return;
  return { kind: { in: [...selected] } };
}

function walk(node: DiscoveryFilterDocument, visit: (leaf: DiscoveryFilterDocument) => void): void {
  if ('and' in node) node.and.forEach((child) => walk(child, visit));
  else if ('or' in node) node.or.forEach((child) => walk(child, visit));
  else if ('not' in node) walk(node.not, visit);
  else visit(node);
}

function conceptSelection(node: DiscoveryFilterDocument): TaggedWorkConceptSelection | undefined {
  if (!('statement' in node) || !('in' in node.statement) || !node.statement.concept) return;
  const concept = node.statement.in[0];
  if (typeof concept !== 'string' || !concept) return;
  return {
    property: node.statement.property,
    concept,
    scheme: node.statement.concept.scheme,
    includeChildren: node.statement.concept.includeChildren === true,
    qualifiers: node.statement.qualifiers ?? [],
  };
}

function quantityLeaf(node: DiscoveryFilterDocument, onConceptStatement: boolean): TaggedWorkQuantityLeaf | undefined {
  if (!('statement' in node)) return;
  if ('range' in node.statement && node.statement.range.type !== 'time')
    return { property: node.statement.property, range: node.statement.range, onConceptStatement };
  for (const qualifier of node.statement.qualifiers ?? []) {
    if ('range' in qualifier)
      return { property: qualifier.property, range: qualifier.range, onConceptStatement: 'concept' in node.statement };
  }
}

function overflowProperties(filter: DiscoveryFilterDocument): string[] {
  const properties = new Set<string>();
  walk(filter, (leaf) => {
    if ('statement' in leaf) {
      properties.add(leaf.statement.property);
      for (const qualifier of leaf.statement.qualifiers ?? []) properties.add(qualifier.property);
    }
  });
  return [...properties];
}

function nodeHasConcept(node: DiscoveryFilterDocument): boolean {
  const pending: DiscoveryFilterDocument[] = [node];
  while (pending.length) {
    const child = pending.pop()!;
    if ('and' in child) pending.push(...child.and);
    else if ('or' in child) pending.push(...child.or);
    else if ('not' in child) pending.push(child.not);
    else if ('statement' in child && 'in' in child.statement && child.statement.concept) return true;
  }
  return false;
}

/** True when the remaining conjuncts after the designated kind leaf include a scheme-bound concept. */
export function taggedWorkRemainingHasConcept(filter: DiscoveryFilterDocument, kindCountLeaf: number): boolean {
  if (!('and' in filter) || !Number.isInteger(kindCountLeaf) || kindCountLeaf < 0 || kindCountLeaf >= filter.and.length)
    return false;
  return filter.and.some((child, position) => position !== kindCountLeaf && nodeHasConcept(child));
}

function catalogueRemaining(remaining: DiscoveryFilterDocument | undefined): FilterDocument | undefined {
  if (remaining === undefined) return;
  let valid = true;
  walk(remaining, (leaf) => {
    if ('kind' in leaf || 'realm' in leaf || 'ratingQuestion' in leaf || 'owner' in leaf || 'saved' in leaf)
      valid = false;
  });
  return valid ? (remaining as FilterDocument) : undefined;
}

/**
 * Bind one designated work-kind leaf, the remaining catalogue predicate, native source and order.
 * Descendant closures use retained concept membership; exact tags and quantities execute directly.
 * Rating order stays finite preparation until mixed rating seek is installed.
 */
export function admitTaggedWorkPlan(input: {
  filter: DiscoveryFilterDocument;
  kindCountLeaf: number;
  sort: string;
  limit: number;
  registeredKinds: ReadonlySet<string>;
}): TaggedWorkPlan {
  if (!('and' in input.filter)) throw new RangeError('Tagged work plans require a top-level AND');
  if (
    !Number.isInteger(input.kindCountLeaf) ||
    input.kindCountLeaf < 0 ||
    input.kindCountLeaf >= input.filter.and.length
  )
    throw new RangeError('Tagged work kindCountLeaf must name a top-level AND child');
  const kindLeaf = kindOperand(input.filter.and[input.kindCountLeaf]);
  if (!kindLeaf) throw new RangeError('Tagged work kindCountLeaf must be a kind leaf');
  if (kindLeaf.kind.in.some((kind) => !input.registeredKinds.has(kind)))
    throw new RangeError('Tagged work kinds must be registered');
  const children = input.filter.and.filter((_, position) => position !== input.kindCountLeaf);
  const remaining = children.length === 0 ? undefined : children.length === 1 ? children[0] : { and: children };
  const sort: TaggedWorkOrder =
    input.sort === 'rating' || input.sort === 'id' || input.sort === 'name' ? input.sort : 'name';
  if (sort !== input.sort && input.sort !== 'relevance') throw new RangeError('Tagged work order is not admitted');
  const concepts: TaggedWorkConceptSelection[] = [];
  const quantities: TaggedWorkQuantityLeaf[] = [];
  if (remaining)
    walk(remaining, (leaf) => {
      const concept = conceptSelection(leaf);
      if (concept) concepts.push(concept);
      const quantity = quantityLeaf(leaf, !!concept);
      if (quantity) quantities.push(quantity);
    });
  const descendants = concepts.some((selection) => selection.includeChildren);
  const source: TaggedWorkSource = descendants ? 'concept-retained' : 'native-catalogue';
  const catalogue = catalogueRemaining(remaining);
  if (remaining && !catalogue) throw new RangeError('Tagged work remaining predicate must be catalogue-only');
  const execution: TaggedWorkExecution = sort === 'rating' ? 'preparing' : 'direct';
  if (catalogue) compileFilter(catalogue, { prefix: 'tagged', relationOverflow: true });
  return {
    filter: input.filter,
    remaining,
    kindLeaf,
    kindCountLeaf: input.kindCountLeaf,
    selectedKinds: kindLeaf.kind.in,
    sort,
    limit: input.limit,
    scanBound: Math.min(600, 6 * input.limit + 3),
    source,
    execution,
    conceptSelections: concepts,
    quantityLeaves: quantities,
    overflowProperties: overflowProperties(input.filter),
  };
}

/** Remove only the designated top-level kind conjunct; nested kind leaves stay in the remaining tree. */
export function taggedWorkCountFilter(plan: TaggedWorkPlan): DiscoveryFilterDocument | undefined {
  return plan.remaining;
}

export function taggedWorkCatalogueFilter(plan: TaggedWorkPlan): FilterDocument | undefined {
  return catalogueRemaining(plan.remaining);
}

export function taggedWorkKindTypeFilter(plan: TaggedWorkPlan): FilterDocument {
  return { type: { in: [...plan.selectedKinds] } };
}

export function taggedWorkCaptureSize(plan: TaggedWorkPlan): number {
  return Math.min(200, plan.scanBound);
}

export function taggedWorkHitScanBound(plan: TaggedWorkPlan | undefined, limit: number): number {
  return plan?.scanBound ?? Math.min(600, 6 * limit + 3);
}
