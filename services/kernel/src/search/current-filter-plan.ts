import type { DiscoveryFilterDocument, FilterDocument, FilterQualifier, OwnerLeaf } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';
import type { RelationFacetMatch } from './source.ts';

/** The current Boolean expression over deduplicated, first-occurrence-ordered leaves. */
type CurrentPlan<Leaf> = {
  leaves: Leaf[];
  indices: Map<string, number>;
  /** Leaves with at least one occurrence under an even number of NOT nodes. */
  positive: Set<number>;
  /** Require exactly one true/false/not_proven result per leaf before evaluating any Boolean node. */
  evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch;
};

export type CurrentFilterPlan = CurrentPlan<FactClause>;

export type CurrentNativeLeaf =
  | Readonly<{ kind: 'catalogue'; clause: FactClause }>
  | Readonly<{ kind: 'owner'; leaf: OwnerLeaf }>;

export type CurrentOwnerFilterPlan = CurrentPlan<CurrentNativeLeaf>;
export type CurrentRealmLeaf = CurrentNativeLeaf | Readonly<{ kind: 'realm'; id: string }>;
export type CurrentRealmFilterPlan = CurrentPlan<CurrentRealmLeaf>;

/** Request-only Realm leaves share the current three-valued Boolean interpreter. */
export function compileCurrentRealmFilter(filter: DiscoveryFilterDocument): CurrentRealmFilterPlan {
  return compileCurrentPlan<CurrentRealmLeaf>(
    filter,
    (leaf) => leaf,
    (leaf) => (leaf.kind === 'realm' ? JSON.stringify(['realm', leaf.id]) : currentOwnerClauseKey(leaf)),
    (id) => ({ kind: 'realm', id }),
  );
}

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

/** OR current evidence, preserving not_proven when no alternative is true; empty evidence is false. */
export function anyCurrentMatch(values: readonly RelationFacetMatch[]): RelationFacetMatch {
  if (values.includes(true)) return true;
  return values.includes('not_proven') ? 'not_proven' : false;
}

/** Each pair is evidence about one native statement, including its own qualifier witness. */
export function currentConceptStatementsMatch(
  statements: readonly Readonly<{ membership: RelationFacetMatch; witness: RelationFacetMatch }>[],
  complete: boolean,
): RelationFacetMatch {
  const matches = statements.map(({ membership, witness }) => allMatch([membership, witness]));
  return anyCurrentMatch(complete ? matches : [...matches, 'not_proven']);
}

function allMatch(values: readonly RelationFacetMatch[]): RelationFacetMatch {
  if (values.includes(false)) return false;
  return values.includes('not_proven') ? 'not_proven' : true;
}

function normalizedQualifiers(qualifiers: readonly FilterQualifier[] = []): FilterQualifier[] {
  const clauses = new Map<string, FilterQualifier>();
  for (const { property, in: values } of qualifiers) {
    const clause = { property, in: sortedValues(values) };
    clauses.set(JSON.stringify(clause), clause);
  }
  return [...clauses.keys()].sort().map((key) => clauses.get(key)!);
}

/** The existing disclosure clause key, including set-normalized values and qualifier clauses. */
export function currentClauseKey(clause: FactClause): string {
  if (clause.facet === 'type') return JSON.stringify(['type', sortedValues(clause.values)]);
  const condition =
    'values' in clause
      ? ['values', sortedValues(clause.values)]
      : clause.range.type === 'time'
        ? ['time', clause.range.gte, clause.range.lte]
        : ['range', clause.range.gte, clause.range.lte, clause.range.unit];
  return JSON.stringify([
    'statement',
    clause.property,
    condition,
    ...('values' in clause && clause.concept
      ? [['concept', clause.concept.scheme, clause.concept.includeChildren ?? false]]
      : []),
    normalizedQualifiers(clause.qualifiers),
  ]);
}

/** Tagged native keys preserve exact owner pins; only state.in has set semantics. */
export function currentOwnerClauseKey(leaf: CurrentNativeLeaf): string {
  if (leaf.kind === 'catalogue') return JSON.stringify(['catalogue', currentClauseKey(leaf.clause)]);
  const owner = leaf.leaf.owner;
  if ('presence' in owner) return JSON.stringify(['owner', 'presence', owner.presence]);
  if ('state' in owner)
    return JSON.stringify([
      'owner',
      'state',
      owner.state.profileId,
      owner.state.stateSetId,
      sortedValues(owner.state.in),
    ]);
  if ('label' in owner) return JSON.stringify(['owner', 'label', owner.label.id]);
  if ('session' in owner) return JSON.stringify(['owner', 'session', owner.session.profileId, owner.session.lifecycle]);
  return JSON.stringify(['owner', 'holding', owner.holding.profileId, owner.holding.kind, owner.holding.status]);
}

/** Catalogue compilation rejects owner predicates at every depth, before any source I/O. */
export function compileCurrentFilter(filter: FilterDocument): CurrentFilterPlan {
  return compileCurrentPlan(
    filter,
    (leaf) => {
      if (leaf.kind === 'owner') throw new Error('Catalogue filters do not support owner predicates');
      return leaf.clause;
    },
    currentClauseKey,
  );
}

/** Native callers authorize and resolve every leaf; scalar evidence is not permission. No source reads. */
export function compileCurrentOwnerFilter(filter: FilterDocument): CurrentOwnerFilterPlan {
  return compileCurrentPlan(filter, (leaf) => leaf, currentOwnerClauseKey);
}

/** One interpreter for already admitted, expanded filters. */
function compileCurrentPlan<Leaf>(
  filter: DiscoveryFilterDocument,
  select: (leaf: CurrentNativeLeaf) => Leaf,
  keyOf: (leaf: Leaf) => string,
  realm?: (id: string) => Leaf,
): CurrentPlan<Leaf> {
  const leaves: Leaf[] = [];
  const indices = new Map<string, number>();
  const positive = new Set<number>();
  type Evaluate = (values: readonly RelationFacetMatch[]) => RelationFacetMatch;
  function visit(node: DiscoveryFilterDocument, negated = false): Evaluate {
    if ('and' in node) {
      const children = node.and.map((child) => visit(child, negated));
      return (values) => allMatch(children.map((child) => child(values)));
    }
    if ('or' in node) {
      const children = node.or.map((child) => visit(child, negated));
      return (values) => anyCurrentMatch(children.map((child) => child(values)));
    }
    if ('not' in node) {
      const child = visit(node.not, !negated);
      return (values) => {
        const result = child(values);
        return result === 'not_proven' ? result : !result;
      };
    }
    if ('saved' in node) throw new Error('Disclose only admitted, expanded filters');
    if ('kind' in node || 'ratingQuestion' in node) throw new Error('Not a Subject scope condition');
    if ('realm' in node && !realm) throw new Error('Realm requires native resource resolution');
    const native: CurrentNativeLeaf | null =
      'realm' in node
        ? null
        : 'owner' in node
          ? { kind: 'owner', leaf: node }
          : {
              kind: 'catalogue',
              clause:
                'type' in node
                  ? { facet: 'type', values: node.type.in }
                  : {
                      facet: 'statement',
                      property: node.statement.property,
                      ...(node.statement.qualifiers ? { qualifiers: node.statement.qualifiers } : {}),
                      ...('in' in node.statement
                        ? {
                            values: node.statement.in,
                            ...(node.statement.concept ? { concept: node.statement.concept } : {}),
                          }
                        : { range: node.statement.range }),
                    },
            };
    const leaf = native ? select(native) : realm!((node as { realm: { id: string } }).realm.id);
    const key = keyOf(leaf);
    let index = indices.get(key);
    if (index === undefined) {
      index = leaves.length;
      indices.set(key, index);
      leaves.push(leaf);
    }
    if (!negated) positive.add(index);
    const position = index;
    return (values) => values[position]!;
  }
  const evaluate = visit(filter);
  return {
    leaves,
    indices,
    positive,
    evaluate(values) {
      if (!Array.isArray(values) || values.length !== leaves.length)
        throw new Error('Malformed current filter results');
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (!Object.hasOwn(values, index) || (value !== true && value !== false && value !== 'not_proven'))
          throw new Error('Malformed current filter results');
      }
      return evaluate(values);
    },
  };
}
