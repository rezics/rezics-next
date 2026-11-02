import { MAX_GROWTH_CAPTURE_ENTRIES } from './growth-capture-budget.ts';

export const MAX_PLAN_NODES = 10_000;
export const MAX_PLAN_DEPTH = 256;
/** Aggregate nodes for one cost/report traversal; matches retained capture evidence entries. */
export const MAX_CAPTURE_PLAN_NODES = MAX_GROWTH_CAPTURE_ENTRIES;

export type PlanNode = Record<string, unknown>;

export type PlanWalkEntry = {
  readonly node: PlanNode;
  readonly path: string;
  readonly depth: number;
};

export type ExplainPlanEntry = {
  readonly queryText: string | undefined;
  readonly plan: PlanNode;
  readonly location: string;
};

type Frame = {
  readonly node: unknown;
  readonly path: string;
  readonly depth: number;
  readonly exit: boolean;
};

type NodeBudget = { used: number; readonly limit: number };

type CompiledPlan = {
  readonly root: unknown;
  readonly preorder: readonly PlanWalkEntry[];
  readonly postorder: readonly PlanWalkEntry[];
};

function isPlanNode(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeCountError(path: string, limit: number): TypeError {
  return new TypeError(`${path}: plan tree exceeds maximum node count ${limit}`);
}

function* traversePlanTree(
  root: unknown,
  location: string,
  total: NodeBudget,
): IterableIterator<{ readonly entry: PlanWalkEntry; readonly phase: 'preorder' | 'postorder' }> {
  const active = new Set<PlanNode>();
  const stack: Frame[] = [{ node: root, path: location, depth: 0, exit: false }];
  let treeCount = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      const node = frame.node as PlanNode;
      active.delete(node);
      yield { entry: { node, path: frame.path, depth: frame.depth }, phase: 'postorder' };
      continue;
    }

    if (!isPlanNode(frame.node)) throw new TypeError(`${frame.path}: plan node must be an object`);
    if (active.has(frame.node)) throw new TypeError(`${frame.path}: cyclic plan tree`);
    if (frame.depth > MAX_PLAN_DEPTH)
      throw new TypeError(`${frame.path}: plan tree exceeds maximum depth ${MAX_PLAN_DEPTH}`);
    treeCount++;
    total.used++;
    if (treeCount > MAX_PLAN_NODES) throw nodeCountError(frame.path, MAX_PLAN_NODES);
    if (total.used > total.limit) throw nodeCountError(frame.path, total.limit);

    const children = frame.node.Plans;
    if (children !== undefined && !Array.isArray(children))
      throw new TypeError(`${frame.path}.Plans: expected an array`);
    const room = Math.min(MAX_PLAN_NODES - treeCount, total.limit - total.used);
    const visitCount = children === undefined ? 0 : Math.min(children.length, room);
    if (children !== undefined) {
      for (let index = 0; index < visitCount; index++) {
        const childPath = `${frame.path}.Plans[${index}]`;
        if (!Object.hasOwn(children, index)) throw new TypeError(`${childPath}: sparse child array entry`);
        if (!isPlanNode(children[index])) throw new TypeError(`${childPath}: child must be an object`);
      }
      if (children.length > room) {
        const limit = MAX_PLAN_NODES - treeCount <= total.limit - total.used ? MAX_PLAN_NODES : total.limit;
        throw nodeCountError(`${frame.path}.Plans[${room}]`, limit);
      }
    }

    const entry = { node: frame.node, path: frame.path, depth: frame.depth };
    yield { entry, phase: 'preorder' };
    active.add(frame.node);
    stack.push({ ...frame, exit: true });
    if (children !== undefined)
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({
          node: children[index],
          path: `${frame.path}.Plans[${index}]`,
          depth: frame.depth + 1,
          exit: false,
        });
  }
}

/** Shared node envelope and compiled forest for one cost/report traversal of a capture. */
export class PlanWalkSession {
  readonly limit: number;
  readonly #total: NodeBudget;
  readonly #compiled = new Map<string, CompiledPlan>();

  constructor(limit = MAX_CAPTURE_PLAN_NODES) {
    this.limit = limit;
    this.#total = { used: 0, limit };
  }

  *walk(root: unknown, location: string, order: 'preorder' | 'postorder'): IterableIterator<PlanWalkEntry> {
    const cached = this.#compiled.get(location);
    if (cached !== undefined && cached.root === root) {
      yield* cached[order];
      return;
    }
    const preorder: PlanWalkEntry[] = [];
    const postorder: PlanWalkEntry[] = [];
    for (const { entry, phase } of traversePlanTree(root, location, this.#total)) {
      (phase === 'preorder' ? preorder : postorder).push(entry);
    }
    this.#compiled.set(location, { root, preorder, postorder });
    yield* order === 'preorder' ? preorder : postorder;
  }
}

export function createPlanWalkSession(limit = MAX_CAPTURE_PLAN_NODES): PlanWalkSession {
  return new PlanWalkSession(limit);
}

/** Walk one native plan tree without using the JavaScript call stack. */
export function* walkPlanTree(
  root: unknown,
  location = 'Plan',
  order: 'preorder' | 'postorder' = 'preorder',
  session?: PlanWalkSession,
): IterableIterator<PlanWalkEntry> {
  if (session !== undefined) {
    yield* session.walk(root, location, order);
    return;
  }
  const total: NodeBudget = { used: 0, limit: MAX_PLAN_NODES };
  for (const { entry, phase } of traversePlanTree(root, location, total)) if (phase === order) yield entry;
}

/** Admit one auto_explain JSON document: a Plan object, or a nonempty array of them. */
export function explainPlanEntries(document: unknown, location = 'plan'): ExplainPlanEntry[] {
  if (Array.isArray(document)) {
    if (document.length === 0) throw new TypeError(`${location}: EXPLAIN plan document is empty`);
    return document.map((entry, index) => {
      const path = `${location}[${index}]`;
      if (!isPlanNode(entry) || !isPlanNode(entry.Plan))
        throw new TypeError(`${path}: EXPLAIN plan document has no Plan`);
      return {
        queryText: typeof entry['Query Text'] === 'string' ? entry['Query Text'] : undefined,
        plan: entry.Plan,
        location: `${path}.Plan`,
      };
    });
  }
  if (isPlanNode(document) && typeof document['Query Text'] === 'string' && isPlanNode(document.Plan))
    return [{ queryText: document['Query Text'], plan: document.Plan, location: `${location}.Plan` }];
  throw new TypeError(`${location}: Unrecognized plan document`);
}

/** Schema-qualified ModifyTable relations from an admitted EXPLAIN document. */
export function collectModifyTargets(document: unknown, output: Set<string>, location = 'plan'): void {
  for (const { plan, location: planLocation } of explainPlanEntries(document, location)) {
    for (const { node, path } of walkPlanTree(plan, planLocation)) {
      if (node['Node Type'] !== 'ModifyTable') continue;
      const name = node['Relation Name'];
      if (typeof name !== 'string' || name.length === 0)
        throw new TypeError(`${path}: ModifyTable is missing Relation Name`);
      const schema = typeof node.Schema === 'string' && node.Schema.length > 0 ? node.Schema : 'public';
      output.add(`${schema}.${name}`);
    }
  }
}
