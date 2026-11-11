import {
  relationGraphIndeterminate as unknownGraph,
  type RelationGraphEdge,
  type RelationGraphInput,
  type RelationGraphResult,
  type RelationGraphWitnessEdge,
} from './relation-graph-constraint-contract.ts';
import { prepareRelationGraph } from './relation-graph-constraint-prepare.ts';

export type {
  RelationGraphScope,
  RelationGraphEdge,
  RelationGraphIdentity,
  RelationGraphBudget,
  RelationGraphInput,
  RelationGraphWitnessEdge,
  RelationGraphResult,
  RelationGraphIndeterminate,
} from './relation-graph-constraint-contract.ts';

function cycle(witness: RelationGraphWitnessEdge[]): RelationGraphResult {
  return { status: 'cycle', kind: witness.length === 1 ? 'self-loop' : 'cycle', witness };
}

function clear(complete: boolean): RelationGraphResult {
  return complete
    ? { status: 'clear' }
    : unknownGraph('insufficient-coverage', 'No cycle witnessed, but graph extent or other-owner coverage is partial.');
}

/**
 * Check whether one proposed effective edge u -> v closes a path v -> u under q.
 * Supply the effective graph AFTER any removals/replacements and BEFORE this edge.
 * Other additions in the same change must already be included. This checks the proposed
 * edge only; it does not certify that unrelated components were acyclic beforehand.
 *
 * A positive witness is valid even with partial edge coverage, provided every supplied
 * edge is effective. A clear result requires complete coverage. All results concern only
 * the supplied observation: they authorize no write. A native owner must still select
 * the mutation boundary and atomically fence relation, overlay and identity changes
 * across participating owners. Neither a page nor an asynchronously mirrored link index
 * supplies that guarantee. Global changes may require separate checks for affected Contexts.
 *
 * Preparation is O(mapping rows + edge rows); iterative search and witness storage are
 * bounded by maxSteps and maxVertices. Duplicate edges consume budget, not extra vertices.
 */
export function checkRelationClosingEdge(
  input: RelationGraphInput,
  proposed: RelationGraphEdge,
): RelationGraphResult {
  const graph = prepareRelationGraph(input, proposed);
  if (graph.status !== 'prepared') return graph;
  const edge = graph.proposed!;
  if (edge.from === edge.to) return cycle([edge]);

  const seen = new Set<string>([edge.to]);
  const parents = new Map<string, RelationGraphWitnessEdge>();
  const stack = [{ vertex: edge.to, next: 0 }];
  let steps = 0;
  while (stack.length) {
    if (steps >= input.budget.maxSteps)
      return unknownGraph('budget-exhausted', 'Closing-edge traversal exhausted maxSteps.');
    steps++;
    const frame = stack[stack.length - 1]!;
    const next = graph.outgoing.get(frame.vertex)![frame.next++];
    if (next === undefined) {
      stack.pop();
      continue;
    }
    if (seen.has(next.to)) continue;
    parents.set(next.to, next);
    if (next.to === edge.from) {
      const reversePath: RelationGraphWitnessEdge[] = [];
      let vertex = edge.from;
      while (vertex !== edge.to) {
        const parent = parents.get(vertex)!;
        reversePath.push(parent);
        vertex = parent.from;
      }
      reversePath.reverse();
      return cycle([edge, ...reversePath]);
    }
    seen.add(next.to);
    stack.push({ vertex: next.to, next: 0 });
  }
  return clear(graph.complete);
}

/**
 * Check the whole supplied effective graph after applying a final identity quotient.
 * Finds both collapsed self-loops and multi-edge cycles. A cycle can predate the quotient;
 * this function makes no causal claim about the identity change. No destructive merge or
 * representative-dependent fact reduction is performed. Canonical parallel edges are safe.
 *
 * Uses iterative three-color DFS over every supplied component. Only an edge to the active
 * path closes a cycle; revisiting a completed vertex (for example a diamond) does not.
 * Input coverage and concurrent-owner requirements are the same as checkRelationClosingEdge.
 */
export function checkRelationIdentityQuotient(input: RelationGraphInput): RelationGraphResult {
  const graph = prepareRelationGraph(input);
  if (graph.status !== 'prepared') return graph;
  const finished = new Set<string>();
  const active = new Map<string, number>();
  const path: RelationGraphWitnessEdge[] = [];
  let steps = 0;
  for (const root of graph.outgoing.keys()) {
    if (finished.has(root)) continue;
    const stack = [{ vertex: root, next: 0 }];
    active.set(root, 0);
    while (stack.length) {
      if (steps >= input.budget.maxSteps)
        return unknownGraph('budget-exhausted', 'Identity-quotient traversal exhausted maxSteps.');
      steps++;
      const frame = stack[stack.length - 1]!;
      const edge = graph.outgoing.get(frame.vertex)![frame.next++];
      if (edge === undefined) {
        finished.add(frame.vertex);
        active.delete(frame.vertex);
        stack.pop();
        if (stack.length) path.pop();
        continue;
      }
      const ancestor = active.get(edge.to);
      if (ancestor !== undefined) return cycle([...path.slice(ancestor), edge]);
      if (finished.has(edge.to)) continue;
      active.set(edge.to, stack.length);
      path.push(edge);
      stack.push({ vertex: edge.to, next: 0 });
    }
  }
  return clear(graph.complete);
}
