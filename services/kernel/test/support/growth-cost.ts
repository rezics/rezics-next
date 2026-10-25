export type Capture = { readonly statements: readonly string[]; readonly plans: readonly unknown[] };

export type RelationCost = {
  readonly rows: number;
  readonly blocks: number;
  readonly nodes: number;
  readonly sequentialScans: number;
};

export type Cost = {
  readonly statements: number;
  readonly controlStatements: number;
  readonly plans: number;
  readonly rows: number;
  readonly blocks: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly relations: Readonly<Record<string, RelationCost>>;
};

type PlanNode = Record<string, unknown>;
type NodeTotals = {
  readonly rows: number;
  readonly hit: number;
  readonly read: number;
  readonly inclusiveHit: number;
  readonly inclusiveRead: number;
};
type MutableRelationCost = { rows: number; blocks: number; nodes: number; sequentialScans: number };

const rowScans = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Tid Scan',
  'Tid Range Scan',
  'Sample Scan',
]);

export function isControlStatement(text: string): boolean {
  return /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK|SAVEPOINT|RELEASE|SET\s+LOCAL|SET\s+TRANSACTION)\b/i.test(
    text,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredNumber(node: PlanNode, field: string): number {
  const value = node[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Plan node is missing ${field}`);
  return value;
}

function optionalNumber(node: PlanNode, field: string, fallback = 0): number {
  const value = node[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Plan node has invalid ${field}`);
  return value;
}

function documentRoots(document: unknown): PlanNode[] {
  if (Array.isArray(document)) {
    if (document.length === 0) throw new TypeError('EXPLAIN plan document is empty');
    return document.map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.Plan)) throw new TypeError('EXPLAIN plan document has no Plan');
      return entry.Plan;
    });
  }
  if (isRecord(document) && typeof document['Query Text'] === 'string' && isRecord(document.Plan))
    return [document.Plan];
  throw new TypeError('Unrecognized plan document');
}

function costNode(node: PlanNode, root: boolean, relations: Map<string, MutableRelationCost>): NodeTotals {
  const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
  const actualRows = requiredNumber(node, 'Actual Rows');
  const loops = optionalNumber(node, 'Actual Loops', 1);
  const hit = optionalNumber(node, 'Shared Hit Blocks');
  const read = optionalNumber(node, 'Shared Read Blocks');

  if (root && node['Shared Hit Blocks'] === undefined) throw new TypeError('Plan root is missing Shared Hit Blocks');

  const childNodes = node.Plans;
  if (childNodes !== undefined && !Array.isArray(childNodes)) throw new TypeError('Plan node Plans must be an array');
  const children =
    (childNodes as unknown[] | undefined)?.map((child) => {
      if (!isRecord(child)) throw new TypeError('Plan child must be an object');
      return costNode(child, false, relations);
    }) ?? [];

  const childHit = children.reduce((sum, child) => sum + child.inclusiveHit, 0);
  const childRead = children.reduce((sum, child) => sum + child.inclusiveRead, 0);
  const exclusiveHit = Math.max(0, hit - childHit);
  const exclusiveRead = Math.max(0, read - childRead);
  const removedByFilter = optionalNumber(node, 'Rows Removed by Filter');
  const removedByRecheck = optionalNumber(node, 'Rows Removed by Index Recheck');
  const examined = rowScans.has(nodeType) ? (actualRows + removedByFilter + removedByRecheck) * loops : 0;

  if (rowScans.has(nodeType) || nodeType === 'ModifyTable') {
    const relationName = node['Relation Name'];
    if (typeof relationName === 'string') {
      const schema = node.Schema;
      const key = typeof schema === 'string' ? `${schema}.${relationName}` : relationName;
      addRelation(
        relations,
        key,
        nodeType === 'ModifyTable' ? actualRows * loops : examined,
        exclusiveHit + exclusiveRead,
        nodeType === 'Seq Scan' ? 1 : 0,
      );
    }
  } else if (nodeType === 'Bitmap Index Scan') {
    const indexName = node['Index Name'];
    if (typeof indexName === 'string') addRelation(relations, `index:${indexName}`, 0, exclusiveHit + exclusiveRead);
  }

  return {
    rows: examined + children.reduce((sum, child) => sum + child.rows, 0),
    hit: exclusiveHit + children.reduce((sum, child) => sum + child.hit, 0),
    read: exclusiveRead + children.reduce((sum, child) => sum + child.read, 0),
    inclusiveHit: hit,
    inclusiveRead: read,
  };
}

function addRelation(
  relations: Map<string, MutableRelationCost>,
  key: string,
  rows: number,
  blocks: number,
  sequentialScans = 0,
): void {
  const relation = relations.get(key) ?? { rows: 0, blocks: 0, nodes: 0, sequentialScans: 0 };
  relation.rows += rows;
  relation.blocks += blocks;
  relation.nodes++;
  relation.sequentialScans += sequentialScans;
  relations.set(key, relation);
}

export function costOf(capture: Capture): Cost {
  const relations = new Map<string, MutableRelationCost>();
  let rows = 0;
  let sharedHit = 0;
  let sharedRead = 0;

  for (const document of capture.plans) {
    for (const root of documentRoots(document)) {
      const totals = costNode(root, true, relations);
      rows += totals.rows;
      sharedHit += totals.hit;
      sharedRead += totals.read;
    }
  }

  return {
    statements: capture.statements.filter((statement) => !isControlStatement(statement)).length,
    controlStatements: capture.statements.filter(isControlStatement).length,
    plans: capture.plans.length,
    rows: Math.round(rows),
    blocks: sharedHit + sharedRead,
    sharedHit,
    sharedRead,
    relations: Object.fromEntries(relations),
  };
}

function lowerMedian(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

export function medianCost(costs: readonly Cost[]): Cost {
  if (costs.length === 0) throw new RangeError('Cannot take the median of no costs');
  const blocks = lowerMedian(costs.map((cost) => cost.blocks));
  const representative = costs.find((cost) => cost.blocks === blocks)!;

  return {
    statements: lowerMedian(costs.map((cost) => cost.statements)),
    controlStatements: lowerMedian(costs.map((cost) => cost.controlStatements)),
    plans: lowerMedian(costs.map((cost) => cost.plans)),
    rows: lowerMedian(costs.map((cost) => cost.rows)),
    blocks,
    sharedHit: lowerMedian(costs.map((cost) => cost.sharedHit)),
    sharedRead: lowerMedian(costs.map((cost) => cost.sharedRead)),
    relations: representative.relations,
  };
}
