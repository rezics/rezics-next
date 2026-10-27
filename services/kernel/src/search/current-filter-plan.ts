import type { FilterDocument, FilterQualifier } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';
import type { RelationFacetMatch } from './source.ts';

/** The current Boolean expression over deduplicated, first-occurrence-ordered fact leaves. */
export type CurrentFilterPlan = {
  leaves: FactClause[];
  indices: Map<string, number>;
  /** Leaves with at least one occurrence under an even number of NOT nodes. */
  positive: Set<number>;
  /** Require exactly one true/false/not_proven result per leaf before evaluating any Boolean node. */
  evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch;
};

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

/** OR current evidence, preserving not_proven when no alternative is true; empty evidence is false. */
export function anyCurrentMatch(values: readonly RelationFacetMatch[]): RelationFacetMatch {
  if (values.includes(true)) return true;
  return values.includes('not_proven') ? 'not_proven' : false;
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
  return JSON.stringify([
    'statement',
    clause.property,
    'values' in clause
      ? ['values', sortedValues(clause.values)]
      : ['range', clause.range.gte, clause.range.lte, clause.range.unit],
    normalizedQualifiers(clause.qualifiers),
  ]);
}

/** Accept only already admitted, expanded filters; saved nodes must reject. No source reads occur here. */
export function compileCurrentFilter(filter: FilterDocument): CurrentFilterPlan {
  const leaves: FactClause[] = [];
  const indices = new Map<string, number>();
  const positive = new Set<number>();
  type Evaluate = (values: readonly RelationFacetMatch[]) => RelationFacetMatch;
  function visit(node: FilterDocument, negated = false): Evaluate {
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
    const clause: FactClause =
      'type' in node
        ? { facet: 'type', values: node.type.in }
        : {
            facet: 'statement',
            property: node.statement.property,
            ...(node.statement.qualifiers ? { qualifiers: node.statement.qualifiers } : {}),
            ...('in' in node.statement ? { values: node.statement.in } : { range: node.statement.range }),
          };
    const key = currentClauseKey(clause);
    let index = indices.get(key);
    if (index === undefined) {
      index = leaves.length;
      indices.set(key, index);
      leaves.push(clause);
    }
    if (!negated) positive.add(index);
    const leaf = index;
    return (values) => values[leaf]!;
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
