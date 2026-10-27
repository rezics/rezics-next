// SPDX-License-Identifier: Apache-2.0
import canonicalize from 'canonicalize';
import {
  type CompositionDocument,
  type CompositionNode,
  type CompositionRegistry,
  type PageContext,
  type PageRead,
  platformRegistry,
} from './registry.ts';

export const MAX_PAGE_READS = 16;

/** Subjects the distinct reads of one page may return in total. */
export const MAX_PAGE_COST = 128;

/** Subjects one read can return: one subject, or a search read's limit. */
export function readCost(read: PageRead): number {
  return read.kind === 'subject' || read.kind === 'reactions' || read.kind === 'account'
    ? 1
    : read.kind === 'search'
      ? read.body.limit
      : read.limit;
}

export interface PageReadPlan {
  reads: Record<string, PageRead>;
  nodes: Record<string, string>;
}

export class PageReadLimitError extends Error {
  constructor() {
    super(`A page may need at most ${MAX_PAGE_READS} distinct reads`);
  }
}

/** Valid documents only: visit the parent first, then slots in registry order. */
function* walkNodes(registry: CompositionRegistry, document: CompositionDocument): Generator<CompositionNode> {
  const components = new Map(registry.components.map((component) => [component.type, component]));
  function* visit(nodes: CompositionNode[]): Generator<CompositionNode> {
    for (const node of nodes) {
      yield node;
      for (const slot of components.get(node.type)!.slots) yield* visit(node.props[slot] as CompositionNode[]);
    }
  }
  yield* visit(document.content);
}

/** Plan code-owned reads for a valid document without executing them or changing the document. */
export function planReads(
  registry: CompositionRegistry,
  document: CompositionDocument,
  page: PageContext,
): PageReadPlan {
  const components = new Map(registry.components.map((component) => [component.type, component]));
  const keys = new Map<string, string>();
  const reads: Record<string, PageRead> = {};
  const nodes = new Map<string, string>();
  for (const node of walkNodes(registry, document)) {
    const read = components.get(node.type)!.read?.(node.props, page);
    if (read === undefined || read === null) continue;
    const canonical = canonicalize(read)!;
    let key = keys.get(canonical);
    if (key === undefined) {
      if (keys.size === MAX_PAGE_READS) throw new PageReadLimitError();
      key = `r${keys.size}`;
      keys.set(canonical, key);
      reads[key] = read;
    }
    nodes.set(node.props.id, key);
  }
  return { reads, nodes: Object.fromEntries(nodes) };
}

/** Properties handled by Statements on a valid platform document, once in document order. */
export function shownProperties(document: CompositionDocument): string[] {
  const properties = new Set<string>();
  for (const node of walkNodes(platformRegistry, document)) {
    if (node.type === 'Statements') {
      for (const property of node.props.properties as string[]) properties.add(property);
    }
  }
  return [...properties];
}
