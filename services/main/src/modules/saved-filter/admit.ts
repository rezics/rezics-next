import type { FilterDocument, FilterNode } from '../../../../../model/definitions/filter-document-v1.ts';
import { checkedFilter, InvalidFilter } from '../facets/schema.ts';
import { resolveFacet } from '../facets/registry.ts';
import { SAVED_FILTER_COST } from './contract.ts';

/** A typed refusal of a document no Saved Filter can hold; never stored as an empty filter. */
export class SavedFilterInvalid extends Error {
  constructor(readonly refusal: string, message: string) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The node with each Condition's Facet named by the exact version it was admitted as. */
function exact(node: FilterNode): FilterNode {
  if ('facet' in node) {
    return { ...node, facet: resolveFacet(node.facet)!.id, ...(node.where ? { where: exact(node.where) as never } : {}) };
  }
  return 'all' in node ? { all: node.all.map(exact) } : { any: node.any.map(exact) };
}

/**
 * Admit a Saved Filter's document with the Query's Filter admission (shape,
 * Facet placement, operators, values, at most 32 nodes and depth 4; no graph
 * read) and retain exact DefinitionRefs: a later Facet version never changes
 * what a saved filter means. A filter needs at least one Condition.
 */
export function admitSavedFilter(filter: unknown): { document: FilterDocument; facets: string[] } {
  if (!record(filter)) throw new SavedFilterInvalid('invalid_filter', 'A Saved Filter is a Filter group');
  let facets: string[];
  try { facets = checkedFilter(filter as FilterDocument); }
  catch (error) {
    if (error instanceof InvalidFilter) throw new SavedFilterInvalid(error.refusal, error.message);
    throw error;
  }
  const document = exact(filter as FilterDocument) as FilterDocument;
  if (Buffer.byteLength(JSON.stringify(document)) > SAVED_FILTER_COST.documentBytes) {
    throw new SavedFilterInvalid('filter_too_large', 'Saved Filter exceeds its byte bound');
  }
  return { document, facets };
}
