import type { FilterDocument, FilterRange } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';

type FilterClause =
  | { terms: { type: string[]; _name: string } }
  | { terms: { statements: string[]; _name: string } }
  | { term: Record<string, string> }
  | { terms: Record<string, string[]> }
  | { range: Record<string, { gte?: number; lte?: number }> }
  | { nested: { path: 'facts'; query: FilterClause; score_mode: 'none'; _name: string } }
  | { bool: { filter?: FilterClause[]; must_not?: FilterClause[] } }
  | { bool: { should: FilterClause[]; minimum_should_match: 1 } };

type FilterLeaf = FactClause & { name: string; negated: boolean };

export function compileFilter(
  filter: FilterDocument,
  { prefix }: { prefix: string },
): { query: FilterClause; leaves: FilterLeaf[] } {
  const leaves: FilterLeaf[] = [];

  function compile(node: FilterDocument, negated: boolean): FilterClause {
    if ('and' in node) {
      const clauses: FilterClause[] = [];
      const excluded: FilterClause[] = [];
      for (const child of node.and) {
        if ('not' in child) excluded.push(compile(child.not, !negated));
        else clauses.push(compile(child, negated));
      }
      return {
        bool: { ...(clauses.length ? { filter: clauses } : {}), ...(excluded.length ? { must_not: excluded } : {}) },
      };
    }
    if ('or' in node) {
      return { bool: { should: node.or.map((child) => compile(child, negated)), minimum_should_match: 1 } };
    }
    if ('not' in node) return { bool: { must_not: [compile(node.not, !negated)] } };

    const name = `${prefix}${leaves.length}`;
    if ('type' in node) {
      const values = [...node.type.in];
      leaves.push({ name, facet: 'type', values, negated });
      return { terms: { type: values, _name: name } };
    }
    if ('saved' in node) throw new Error('Compile only admitted filters');
    const { property, qualifiers } = node.statement;
    const condition: { values: string[] } | { range: FilterRange } =
      'in' in node.statement ? { values: [...node.statement.in] } : { range: node.statement.range };
    leaves.push({ name, facet: 'statement', property, ...condition, ...(qualifiers ? { qualifiers } : {}), negated });
    if ('values' in condition && !qualifiers?.length)
      return { terms: { statements: condition.values.map((value) => `${property}=${value}`), _name: name } };

    const clauses: FilterClause[] = [{ term: { 'facts.property': property } }];
    if ('values' in condition) clauses.push({ terms: { 'facts.value': condition.values } });
    else {
      const { unit, ...bounds } = condition.range;
      if (unit !== undefined) clauses.push({ term: { 'facts.unit': unit } });
      clauses.push({ range: { [unit === undefined ? 'facts.year' : 'facts.amount']: bounds } });
    }
    for (const qualifier of qualifiers ?? [])
      clauses.push({ terms: { 'facts.qualifiers': qualifier.in.map((value) => `${qualifier.property}=${value}`) } });
    return { nested: { path: 'facts', query: { bool: { filter: clauses } }, score_mode: 'none', _name: name } };
  }

  return { query: compile(filter, false), leaves };
}
