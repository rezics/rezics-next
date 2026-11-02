export const MAX_PLAN_NODES = 10_000;
export const MAX_PLAN_DEPTH = 256;

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

function isPlanNode(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk one native plan tree without using the JavaScript call stack. */
export function* walkPlanTree(
  root: unknown,
  location = 'Plan',
  order: 'preorder' | 'postorder' = 'preorder',
): IterableIterator<PlanWalkEntry> {
  const active = new Set<PlanNode>();
  const stack: Frame[] = [{ node: root, path: location, depth: 0, exit: false }];
  let count = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      const node = frame.node as PlanNode;
      active.delete(node);
      if (order === 'postorder') yield { node, path: frame.path, depth: frame.depth };
      continue;
    }

    if (!isPlanNode(frame.node)) throw new TypeError(`${frame.path}: plan node must be an object`);
    if (active.has(frame.node)) throw new TypeError(`${frame.path}: cyclic plan tree`);
    if (frame.depth > MAX_PLAN_DEPTH)
      throw new TypeError(`${frame.path}: plan tree exceeds maximum depth ${MAX_PLAN_DEPTH}`);
    count++;
    if (count > MAX_PLAN_NODES)
      throw new TypeError(`${frame.path}: plan tree exceeds maximum node count ${MAX_PLAN_NODES}`);

    const children = frame.node.Plans;
    if (children !== undefined && !Array.isArray(children))
      throw new TypeError(`${frame.path}.Plans: expected an array`);
    if (children !== undefined) {
      for (let index = 0; index < children.length; index++) {
        const childPath = `${frame.path}.Plans[${index}]`;
        if (!Object.hasOwn(children, index)) throw new TypeError(`${childPath}: sparse child array entry`);
        if (!isPlanNode(children[index])) throw new TypeError(`${childPath}: child must be an object`);
      }
    }

    active.add(frame.node);
    if (order === 'preorder') yield { node: frame.node, path: frame.path, depth: frame.depth };
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
