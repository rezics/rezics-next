/**
 * The sparse, round-trippable Query descriptor. Editors may display a subset of
 * these fields, but must preserve every field they did not edit. Absence means
 * no Condition; it never supplies a sort, scope or page default.
 *
 * Main validates this shape and admits each Facet before selecting a bounded
 * execution template. A Saved Filter retains `filter`, exact Facet refs and
 * Context revisions when that resource is introduced, never a continuation.
 */
export type FilterValue = string | { provider: string; namespace: string; key: string };

export interface FilterCondition {
  facet: string;
  any?: FilterValue[];
  all?: FilterValue[];
  none?: FilterValue[];
  range?: { min?: string; max?: string };
  bind?: Record<string, string>;
  interpretation?: { definition: string } | { context: string; semanticRevision: string };
  applicability?: string[];
  /** All nested Conditions describe the same occurrence and co-participant. */
  where?: FilterGroup;
}

export type FilterNode = FilterCondition | FilterGroup;
export type FilterGroup = { all: FilterNode[] } | { any: FilterNode[] };
export type FilterDocument = FilterGroup;

export interface ResourceQuery {
  context: 'global' | { realm: string };
  scope: { kind: 'all' } | { kind: 'realm'; realm: string } | { kind: 'mine' };
  filter?: FilterDocument;
  text?: { phrase: string } | { title: string; body: string };
  sort: 'relevance' | 'newest' | 'updated' | 'top-rated';
  /** The standing rating Context a top-rated or Mine page ranks by. */
  ratingContext?: string;
  /** The reader a Mine page lists. Required with scope mine. */
  actingSubject?: string;
  page: { size: number; continuation?: unknown };
  /** Explicit unsupported selectors are admitted as typed refusals. */
  sourcePolicy?: unknown;
  asOf?: unknown;
}
