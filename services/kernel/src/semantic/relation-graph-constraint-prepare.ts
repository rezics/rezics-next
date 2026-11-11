import {
  relationGraphIndeterminate as unknownGraph,
  type RelationGraphEdge,
  type RelationGraphIndeterminate,
  type RelationGraphInput,
  type RelationGraphWitnessEdge,
} from './relation-graph-constraint-contract.ts';

type PreparedGraph = {
  status: 'prepared';
  outgoing: Map<string, RelationGraphWitnessEdge[]>;
  proposed: RelationGraphWitnessEdge | undefined;
  complete: boolean;
};

// Native identifiers and release/property pins are small; bound string work as well as row work.
const identifier = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Internal preparation only. No reads, callbacks, persistence, sorting or recursive mapping. */
export function prepareRelationGraph(
  input: RelationGraphInput,
  proposed?: RelationGraphEdge,
): PreparedGraph | RelationGraphIndeterminate {
  const { scope, budget, coverage } = input;
  for (const value of [budget.maxEdges, budget.maxMappings, budget.maxVertices, budget.maxSteps]) {
    if (!Number.isSafeInteger(value) || value < 0)
      return unknownGraph('invalid-input', 'Budgets must be nonnegative safe integers.');
  }
  if (
    !identifier(scope.context) || !identifier(scope.release) || !identifier(scope.property) ||
    (scope.orientation !== 'forward' && scope.orientation !== 'inverse')
  ) return unknownGraph('invalid-input', 'Expected one Context, release, property and orientation.');
  if (
    scope.definition.datatype !== 'item' || scope.definition.relation?.acyclic !== true ||
    scope.definition.relation.symmetric === true
  ) return unknownGraph('unsupported-property', 'Expected a declared acyclic directed item property.');
  if (coverage.selection !== 'effective' || coverage.observation !== 'coherent')
    return unknownGraph('insufficient-coverage', 'Effective selection and a coherent native observation are required.');
  if (input.edges.length > budget.maxEdges - (proposed === undefined ? 0 : 1))
    return unknownGraph('budget-exhausted', 'Edge input exceeds maxEdges.');
  if (input.identity.length > budget.maxMappings)
    return unknownGraph('budget-exhausted', 'Identity input exceeds maxMappings.');

  const identity = new Map<string, string>();
  for (const row of input.identity) {
    if (!identifier(row.original) || !identifier(row.canonical))
      return unknownGraph('invalid-input', 'Identity endpoints must be bounded nonempty identifiers.');
    const previous = identity.get(row.original);
    if (previous !== undefined && previous !== row.canonical)
      return unknownGraph('invalid-input', 'An original has conflicting canonical mappings.');
    identity.set(row.original, row.canonical);
  }
  for (const canonical of identity.values()) {
    const next = identity.get(canonical);
    if (next !== undefined && next !== canonical)
      return unknownGraph('invalid-input', 'Identity must be a final quotient map, not redirect chains.');
  }

  const outgoing = new Map<string, RelationGraphWitnessEdge[]>();
  function mapEdge(edge: RelationGraphEdge): RelationGraphWitnessEdge | RelationGraphIndeterminate {
    if (edge.property !== scope.property || !identifier(edge.subject) || !identifier(edge.target))
      return unknownGraph('invalid-input', 'Every edge must use the selected property and original endpoints.');
    const subject = identity.get(edge.subject);
    const target = identity.get(edge.target);
    if (subject === undefined || target === undefined)
      return unknownGraph('insufficient-coverage', 'An edge endpoint has no final canonical mapping.');
    for (const vertex of [subject, target]) {
      if (!outgoing.has(vertex)) {
        if (outgoing.size >= budget.maxVertices)
          return unknownGraph('budget-exhausted', 'Canonical vertices exceed maxVertices.');
        outgoing.set(vertex, []);
      }
    }
    return {
      original: { subject: edge.subject, target: edge.target, property: edge.property },
      from: scope.orientation === 'forward' ? subject : target,
      to: scope.orientation === 'forward' ? target : subject,
    };
  }
  for (const edge of input.edges) {
    const mapped = mapEdge(edge);
    if ('status' in mapped) return mapped;
    outgoing.get(mapped.from)!.push(mapped);
  }
  let mappedProposal: RelationGraphWitnessEdge | undefined;
  if (proposed !== undefined) {
    const mapped = mapEdge(proposed);
    if ('status' in mapped) return mapped;
    mappedProposal = mapped;
  }
  return {
    status: 'prepared', outgoing, proposed: mappedProposal,
    complete: coverage.extent === 'complete' && coverage.owners === 'complete',
  };
}
