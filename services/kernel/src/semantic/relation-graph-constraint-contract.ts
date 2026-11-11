import type { PropertyDefinition } from '@rezics/definitions';

/** One exact released property, never a display group or an inferred inverse family. */
export type RelationGraphScope = Readonly<{
  context: string;
  release: string;
  property: string;
  definition: Pick<PropertyDefinition, 'datatype' | 'relation'>;
  orientation: 'forward' | 'inverse';
}>;

/** Endpoints are permanent originals, even when either original currently redirects. */
export type RelationGraphEdge = Readonly<{
  subject: string;
  target: string;
  property: string;
}>;

export type RelationGraphIdentity = Readonly<{ original: string; canonical: string }>;

export type RelationGraphBudget = Readonly<{
  /** Counts supplied rows, including duplicates and the proposed closing edge. */
  maxEdges: number;
  /** Counts supplied mapping rows, including duplicates. */
  maxMappings: number;
  maxVertices: number;
  /** Bounds iterative search decisions; input preparation is separately row-bounded. */
  maxSteps: number;
}>;

export type RelationGraphInput = Readonly<{
  scope: RelationGraphScope;
  /**
   * Native effective selections for this Context and release, after acceptance, retraction,
   * rank, inheritance, defaults, replacement and suppression have been resolved. Include
   * all contributing original holders, including redirected originals. Do not pass raw
   * assertions, rejected display candidates, only a local overlay, or a viewer-filtered page.
   * Only resolved item values become edges; unresolved endpoints must not become fake IDs.
   * Inverse presentation rows must not be added as a second property or a second edge.
   */
  edges: readonly RelationGraphEdge[];
  /**
   * Direct final q(original), including explicit self mappings. For a quotient check supply
   * the proposed final map, not just the changed members or a chain of redirects. Absence
   * is unknown, never an implicit self mapping. Originals and input rows are never rewritten.
   */
  identity: readonly RelationGraphIdentity[];
  coverage: Readonly<{
    selection: 'effective' | 'unresolved';
    /** Complete edge domain for the selected graph, not merely the end of a local page. */
    extent: 'complete' | 'partial';
    /** Includes native evidence from every contributing owner/partition. */
    owners: 'complete' | 'partial';
    /** All supplied edges, release meaning and mappings describe one coherent observation. */
    observation: 'coherent' | 'unavailable';
  }>;
  budget: RelationGraphBudget;
}>;

export type RelationGraphWitnessEdge = Readonly<{
  original: RelationGraphEdge;
  from: string;
  to: string;
}>;

export type RelationGraphIndeterminate = Readonly<{
  status: 'indeterminate';
  reason: 'invalid-input' | 'unsupported-property' | 'insufficient-coverage' | 'budget-exhausted';
  detail: string;
}>;

export type RelationGraphResult =
  | Readonly<{
      status: 'cycle';
      kind: 'self-loop' | 'cycle';
      /** Ordered canonical cycle, retaining the original endpoints of each edge. Native-only evidence. */
      witness: readonly RelationGraphWitnessEdge[];
    }>
  | Readonly<{ status: 'clear' }>
  | RelationGraphIndeterminate;

export function relationGraphIndeterminate(
  reason: RelationGraphIndeterminate['reason'],
  detail: string,
): RelationGraphIndeterminate {
  return { status: 'indeterminate', reason, detail };
}
