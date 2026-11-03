import { calendarRangeBounds, FilterError, type FilterDocument, type FilterRange, walkFilter } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';
import { SearchUnavailableError } from './opensearch.ts';

type FilterClause =
  | { match_all: { _name: string } }
  | { terms: { type: string[]; _name: string } }
  | { terms: { statements: string[]; _name?: string } }
  | { term: Record<string, string> }
  | { terms: Record<string, string[]> }
  | { range: Record<string, { gte?: number | string; lte?: number | string }> }
  | { nested: { path: 'facts'; query: FilterClause; score_mode: 'none'; _name?: string } }
  | { bool: { filter?: FilterClause[]; must_not?: FilterClause[] } }
  | { bool: { should: FilterClause[]; minimum_should_match: 1; _name?: string } };

type FilterLeaf = FactClause & { name: string; negated: boolean };

export function compileFilter(
  filter: FilterDocument,
  {
    prefix,
    relationOverflow = false,
    calendarFormat,
  }: {
    prefix: string;
    relationOverflow?: boolean;
    /** Only a prepared physical generation with the calendar mapping may supply this capability. */
    calendarFormat?: 1;
  },
): { query: FilterClause; leaves: FilterLeaf[] } {
  const leaves: FilterLeaf[] = [];
  // Inbound edges are absent from the index. Both polarities retain every candidate
  // for current native evidence, including beneath mixed Boolean expressions.
  relationOverflow ||= [...walkFilter(filter)].some(
    (node) => 'statement' in node && 'in' in node.statement && node.statement.inverse === true,
  );

  function statementQuery(exact: FilterClause, property: string, name: string, negated: boolean): FilterClause {
    if (!relationOverflow) return exact;
    return {
      bool: {
        should: [negated ? { bool: { must_not: [exact] } } : exact, { term: { relation_facet_overflow: property } }],
        minimum_should_match: 1,
        _name: name,
      },
    };
  }

  function compile(node: FilterDocument, negated: boolean): FilterClause {
    // Push negation down before broadening literals: NOT (exact OR overflow) would lose candidates.
    if (relationOverflow && ('and' in node || 'or' in node)) {
      const isAnd = 'and' in node;
      const children = isAnd ? node.and : node.or;
      const clauses = children.map((child) => compile(child, negated));
      return isAnd !== negated ? { bool: { filter: clauses } } : { bool: { should: clauses, minimum_should_match: 1 } };
    }
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
    if ('not' in node)
      return relationOverflow ? compile(node.not, !negated) : { bool: { must_not: [compile(node.not, !negated)] } };

    const name = `${prefix}${leaves.length}`;
    if ('type' in node) {
      const values = [...node.type.in];
      leaves.push({ name, facet: 'type', values, negated });
      const exact = { terms: { type: values, _name: name } };
      return relationOverflow && negated ? { bool: { must_not: [exact] } } : exact;
    }
    if ('owner' in node) throw new Error('Catalogue filters do not support owner predicates');
    if ('saved' in node) throw new Error('Compile only admitted filters');
    const { property, qualifiers } = node.statement;
    // A concept leaf needs a complete retained descendant closure and a current native witness.
    // Until both are installed, refusing the query is safer than compiling only its root value.
    if ('in' in node.statement && node.statement.concept)
      throw new SearchUnavailableError('Concept membership preparation is unavailable');
    const condition: { values: string[] } | { range: FilterRange } =
      'in' in node.statement ? { values: [...node.statement.in] } : { range: node.statement.range };
    leaves.push({
      name,
      facet: 'statement',
      property,
      ...condition,
      ...('in' in node.statement && node.statement.inverse ? { inverse: true as const } : {}),
      ...(qualifiers ? { qualifiers } : {}),
      negated,
    });
    if ('in' in node.statement && node.statement.inverse) return { match_all: { _name: name } };
    // Name the broadened literal once, so marker-only matches retain the same lineage as exact matches.
    const named = relationOverflow ? {} : { _name: name };
    if ('values' in condition && !qualifiers?.length)
      return statementQuery(
        { terms: { statements: condition.values.map((value) => `${property}=${value}`), ...named } },
        property,
        name,
        negated,
      );

    const clauses: FilterClause[] = [{ term: { 'facts.property': property } }];
    if ('values' in condition) clauses.push({ terms: { 'facts.value': condition.values } });
    else if (condition.range.type === 'time') {
      const bounds = calendarRangeBounds(condition.range);
      if (!bounds) throw new FilterError('invalid_request', '/statement/range', 'invalid_format');
      // Existing callers remain closed until their preparation/publication lifecycle binds this format.
      if (calendarFormat !== 1)
        throw new SearchUnavailableError('Precise calendar filtering requires a prepared physical generation');
      if (bounds.lower !== undefined) clauses.push({ range: { 'facts.time_upper': { gte: bounds.lower } } });
      if (bounds.upper !== undefined) clauses.push({ range: { 'facts.time_lower': { lte: bounds.upper } } });
    } else {
      const { unit, ...bounds } = condition.range;
      if (unit !== undefined) clauses.push({ term: { 'facts.unit': unit } });
      clauses.push({ range: { [unit === undefined ? 'facts.year' : 'facts.amount']: bounds } });
    }
    for (const qualifier of qualifiers ?? [])
      clauses.push({ terms: { 'facts.qualifiers': qualifier.in.map((value) => `${qualifier.property}=${value}`) } });
    return statementQuery(
      { nested: { path: 'facts', query: { bool: { filter: clauses } }, score_mode: 'none', ...named } },
      property,
      name,
      negated,
    );
  }

  return { query: compile(filter, false), leaves };
}
