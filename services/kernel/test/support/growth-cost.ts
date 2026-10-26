export type Capture = {
  readonly statements: readonly string[];
  readonly plans: readonly unknown[];
  readonly backgroundStatements?: readonly string[];
  readonly backgroundPlans?: readonly unknown[];
};

export type RelationCost = {
  readonly rows: number;
  readonly blocks: number;
  readonly nodes: number;
  readonly sequentialScans: number;
};

export type Cost = {
  readonly statements: number;
  readonly controlStatements: number;
  readonly catalogStatements: number;
  readonly plans: number;
  readonly rows: number;
  readonly blocks: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly relations: Readonly<Record<string, RelationCost>>;
  readonly backgroundStatements?: number;
  readonly backgroundRows?: number;
  readonly backgroundBlocks?: number;
  readonly backgroundCosts?: Readonly<
    Record<string, { readonly rows: number; readonly blocks: number; readonly bounded: boolean }>
  >;
};

type PlanNode = Record<string, unknown>;
type NodeTotals = { readonly rows: number; readonly inclusiveHit: number; readonly inclusiveRead: number };
type MutableRelationCost = { rows: number; blocks: number; nodes: number; sequentialScans: number };
type Blocks = { hit: number; read: number };
/** Per CTE name: the producer's inclusive blocks, and the exclusive blocks of the `CTE Scan` nodes that read it. */
type CteBlocks = { readonly producers: Map<string, Blocks>; readonly scans: Map<string, Blocks> };

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

type PlanEntry = { readonly queryText: string | undefined; readonly plan: PlanNode };

function documentEntries(document: unknown): PlanEntry[] {
  if (Array.isArray(document)) {
    if (document.length === 0) throw new TypeError('EXPLAIN plan document is empty');
    return document.map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.Plan)) throw new TypeError('EXPLAIN plan document has no Plan');
      return {
        queryText: typeof entry['Query Text'] === 'string' ? entry['Query Text'] : undefined,
        plan: entry.Plan,
      };
    });
  }
  if (isRecord(document) && typeof document['Query Text'] === 'string' && isRecord(document.Plan))
    return [{ queryText: document['Query Text'], plan: document.Plan }];
  throw new TypeError('Unrecognized plan document');
}

function isCatalogOnlyPlan(root: PlanNode): boolean {
  let hasRelation = false;
  let catalogOnly = true;
  const visit = (node: PlanNode): void => {
    if (typeof node['Relation Name'] === 'string') {
      hasRelation = true;
      catalogOnly = catalogOnly && (node.Schema === 'pg_catalog' || node.Schema === 'information_schema');
    }
    const children = node.Plans;
    if (children !== undefined && !Array.isArray(children)) throw new TypeError('Plan node Plans must be an array');
    for (const child of children ?? []) {
      if (!isRecord(child)) throw new TypeError('Plan child must be an object');
      visit(child);
    }
  };
  visit(root);
  return hasRelation && catalogOnly;
}

export type CatalogClassification = {
  readonly catalogTexts: ReadonlySet<string>;
  readonly catalogStatements: number;
  readonly allowedStatements: number;
  readonly firstCatalogStatement: string | undefined;
};

function classifyCatalogStatements(capture: Capture): CatalogClassification {
  const entries = capture.plans.flatMap((document) => documentEntries(document));
  const nonControlStatements = capture.statements.filter((statement) => !isControlStatement(statement));
  const clientTexts = new Set(nonControlStatements);
  const plansByText = new Map<string, PlanEntry[]>();
  for (const entry of entries) {
    if (entry.queryText === undefined || !clientTexts.has(entry.queryText)) continue;
    const plans = plansByText.get(entry.queryText) ?? [];
    plans.push(entry);
    plansByText.set(entry.queryText, plans);
  }

  const catalogTexts = new Set<string>();
  for (const [text, plans] of plansByText) {
    if (plans.length > 0 && plans.every(({ plan }) => isCatalogOnlyPlan(plan))) catalogTexts.add(text);
  }

  const catalogStatements = nonControlStatements.filter((statement) => catalogTexts.has(statement)).length;
  const nonCatalogTexts = new Set(nonControlStatements.filter((statement) => !catalogTexts.has(statement)));
  const firstCatalogStatement = nonControlStatements.find((statement) => catalogTexts.has(statement));
  return {
    catalogTexts,
    catalogStatements,
    allowedStatements: nonCatalogTexts.size,
    firstCatalogStatement,
  };
}

export function catalogStatementBound(capture: Capture): CatalogClassification {
  return classifyCatalogStatements(capture);
}

/** The capture without the statements in `catalogTexts` and the plan documents that explain only those statements. */
export function withoutCatalogTexts(capture: Capture, catalogTexts: ReadonlySet<string>): Capture {
  return {
    statements: capture.statements.filter((statement) => !catalogTexts.has(statement)),
    plans: capture.plans.filter((document) =>
      documentEntries(document).some(({ queryText }) => queryText === undefined || !catalogTexts.has(queryText)),
    ),
  };
}

function addBlocks(blocks: Map<string, Blocks>, name: string, hit: number, read: number): void {
  const total = blocks.get(name) ?? { hit: 0, read: 0 };
  total.hit += hit;
  total.read += read;
  blocks.set(name, total);
}

function costNode(
  node: PlanNode,
  root: boolean,
  relations: Map<string, MutableRelationCost>,
  ctes: CteBlocks,
): NodeTotals {
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
      return costNode(child, false, relations, ctes);
    }) ?? [];

  const childHit = children.reduce((sum, child) => sum + child.inclusiveHit, 0);
  const childRead = children.reduce((sum, child) => sum + child.inclusiveRead, 0);
  const exclusiveHit = Math.max(0, hit - childHit);
  const exclusiveRead = Math.max(0, read - childRead);
  const producer = typeof node['Subplan Name'] === 'string' ? /^CTE (.+)$/.exec(node['Subplan Name']) : null;
  if (producer) addBlocks(ctes.producers, producer[1]!, hit, read);
  if (nodeType === 'CTE Scan' && typeof node['CTE Name'] === 'string')
    addBlocks(ctes.scans, node['CTE Name'], exclusiveHit, exclusiveRead);
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
  const catalog = classifyCatalogStatements(capture);
  let plans = 0;

  for (const document of capture.plans) {
    for (const { queryText, plan } of documentEntries(document)) {
      if (queryText !== undefined && catalog.catalogTexts.has(queryText)) continue;
      plans++;
      const ctes: CteBlocks = { producers: new Map(), scans: new Map() };
      const totals = costNode(plan, true, relations, ctes);
      rows += totals.rows;
      sharedHit += totals.inclusiveHit;
      sharedRead += totals.inclusiveRead;
      // A producer runs lazily inside the scans that read it, so those buffers are already in the root. What no scan
      // pulled (a data-modifying CTE that runs at the end of the statement) is not.
      for (const [name, producer] of ctes.producers) {
        const scans = ctes.scans.get(name);
        sharedHit += Math.max(0, producer.hit - (scans?.hit ?? 0));
        sharedRead += Math.max(0, producer.read - (scans?.read ?? 0));
      }
    }
  }

  const backgroundCosts = new Map<string, { rows: number; blocks: number; bounded: boolean }>();
  let backgroundRows = 0;
  let backgroundBlocks = 0;
  for (const document of capture.backgroundPlans ?? []) {
    for (const entry of documentEntries(document)) {
      const key = entry.queryText ?? '<unknown background statement>';
      const planCost = costOf({
        statements: [],
        plans: [{ Plan: entry.plan, 'Query Text': entry.queryText }],
      });
      backgroundRows += planCost.rows;
      backgroundBlocks += planCost.blocks;
      const prior = backgroundCosts.get(key) ?? { rows: 0, blocks: 0, bounded: true };
      backgroundCosts.set(key, {
        rows: Math.max(prior.rows, planCost.rows),
        blocks: Math.max(prior.blocks, planCost.blocks),
        // DBOS history is not seeded by grow(), so its accumulated rows do not represent scale growth.
        bounded:
          prior.bounded && Object.keys(planCost.relations).some((relation) => !/^(?:dbos|auth_dbos)\./.test(relation)),
      });
    }
  }

  const cost = {
    statements: capture.statements.filter(
      (statement) => !isControlStatement(statement) && !catalog.catalogTexts.has(statement),
    ).length,
    controlStatements: capture.statements.filter(isControlStatement).length,
    catalogStatements: catalog.catalogStatements,
    plans,
    rows: Math.round(rows),
    blocks: sharedHit + sharedRead,
    sharedHit,
    sharedRead,
    relations: Object.fromEntries(relations),
  };
  return {
    ...cost,
    ...(capture.backgroundStatements !== undefined || capture.backgroundPlans !== undefined
      ? {
          backgroundStatements: (capture.backgroundStatements ?? []).length,
          backgroundRows,
          backgroundBlocks,
          backgroundCosts: Object.fromEntries(backgroundCosts),
        }
      : {}),
  };
}

function lowerMedian(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

export function medianCost(costs: readonly Cost[]): Cost {
  if (costs.length === 0) throw new RangeError('Cannot take the median of no costs');
  const blocks = lowerMedian(costs.map((cost) => cost.blocks));
  const representative = costs.find((cost) => cost.blocks === blocks)!;

  const median = {
    statements: lowerMedian(costs.map((cost) => cost.statements)),
    controlStatements: lowerMedian(costs.map((cost) => cost.controlStatements)),
    catalogStatements: lowerMedian(costs.map((cost) => cost.catalogStatements)),
    plans: lowerMedian(costs.map((cost) => cost.plans)),
    rows: lowerMedian(costs.map((cost) => cost.rows)),
    blocks,
    sharedHit: lowerMedian(costs.map((cost) => cost.sharedHit)),
    sharedRead: lowerMedian(costs.map((cost) => cost.sharedRead)),
    relations: representative.relations,
  };
  return {
    ...median,
    ...(costs.some((cost) => cost.backgroundStatements !== undefined)
      ? {
          backgroundStatements: lowerMedian(costs.map((cost) => cost.backgroundStatements ?? 0)),
          backgroundRows: lowerMedian(costs.map((cost) => cost.backgroundRows ?? 0)),
          backgroundBlocks: lowerMedian(costs.map((cost) => cost.backgroundBlocks ?? 0)),
          backgroundCosts: Object.fromEntries(
            [...new Set(costs.flatMap((cost) => Object.keys(cost.backgroundCosts ?? {})))].map((statement) => [
              statement,
              {
                rows: lowerMedian(costs.map((cost) => cost.backgroundCosts?.[statement]?.rows ?? 0)),
                blocks: lowerMedian(costs.map((cost) => cost.backgroundCosts?.[statement]?.blocks ?? 0)),
                bounded: costs.some((cost) => cost.backgroundCosts?.[statement]?.bounded ?? false),
              },
            ]),
          ),
        }
      : {}),
  };
}
