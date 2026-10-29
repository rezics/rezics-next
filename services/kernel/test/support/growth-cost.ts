export type Capture = {
  readonly statements: readonly string[];
  readonly requestBytes?: readonly number[];
  readonly responseBytes?: readonly number[];
  readonly plans: readonly unknown[];
  /** Statement occurrence index parallel to each plan. */
  readonly planStatements?: readonly (number | undefined)[];
  readonly statementErrors?: readonly (string | null)[];
  readonly statementErrorMessages?: readonly (string | null)[];
  /** Backend process ID parallel to each statement and plan when capture(..., { includeBackends: true }) is used. */
  readonly statementBackends?: readonly (number | undefined)[];
  readonly planBackends?: readonly (number | undefined)[];
  readonly backgroundStatements?: readonly string[];
  readonly backgroundRequestBytes?: readonly number[];
  readonly backgroundResponseBytes?: readonly number[];
  readonly backgroundPlans?: readonly unknown[];
  /** Background statement occurrence index parallel to each background plan. */
  readonly backgroundPlanStatements?: readonly (number | undefined)[];
  readonly backgroundStatementErrors?: readonly (string | null)[];
  readonly backgroundStatementErrorMessages?: readonly (string | null)[];
  /** Backend process ID parallel to each background statement and plan, when backends are included. */
  readonly backgroundStatementBackends?: readonly (number | undefined)[];
  readonly backgroundPlanBackends?: readonly (number | undefined)[];
};

export type RelationCost = {
  readonly rows: number;
  readonly blocks: number;
  readonly nodes: number;
  readonly sequentialScans: number;
};

export type Cost = {
  readonly statements: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly failedStatements?: Readonly<Record<string, number>>;
  readonly controlStatements: number;
  readonly catalogStatements: number;
  readonly plans: number;
  readonly rows: number;
  readonly blocks: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly relations: Readonly<Record<string, RelationCost>>;
  readonly backgroundStatements?: number;
  readonly backgroundRequestBytes?: number;
  readonly backgroundResponseBytes?: number;
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
  /** JSON encoded [backend PID, query text] keys; used when backend metadata is present. */
  readonly catalogKeys: ReadonlySet<string>;
  readonly backendAware: boolean;
  readonly catalogStatements: number;
  readonly freshnessProbes: number;
  readonly allowedStatements: number;
  readonly firstCatalogStatement: string | undefined;
};

function isFreshnessProbeText(text: string): boolean {
  return [/\bAS\s+fresh_table\b/i, /\bAS\s+fresh_column\b/i, /\bAS\s+fresh_type\b/i].every((alias) => alias.test(text));
}

function classifyCatalogStatements(capture: Capture): CatalogClassification {
  const backendAware = capture.statementBackends !== undefined && capture.planBackends !== undefined;
  const statementEntries = capture.statements.flatMap((text, index) =>
    !isControlStatement(text) ? [{ text, backend: capture.statementBackends?.[index] }] : [],
  );
  const clientKeys = new Set(statementEntries.map(({ text, backend }) => catalogKey(backendAware, backend, text)));
  const plansByKey = new Map<string, PlanEntry[]>();
  for (let index = 0; index < capture.plans.length; index++) {
    const backend = capture.planBackends?.[index];
    for (const entry of documentEntries(capture.plans[index])) {
      if (entry.queryText === undefined) continue;
      const key = catalogKey(backendAware, backend, entry.queryText);
      if (!clientKeys.has(key)) continue;
      const plans = plansByKey.get(key) ?? [];
      plans.push(entry);
      plansByKey.set(key, plans);
    }
  }

  const catalogTexts = new Set<string>();
  const catalogKeys = new Set<string>();
  const freshnessProbeKeys = new Set<string>();
  const catalogOnlyByText = new Map<string, boolean>();
  for (const [key, plans] of plansByKey) {
    const queryText = plans[0]!.queryText!;
    const catalogOnly = plans.length > 0 && plans.every(({ plan }) => isCatalogOnlyPlan(plan));
    if (catalogOnly) {
      catalogKeys.add(key);
      if (isFreshnessProbeText(queryText)) freshnessProbeKeys.add(key);
    }
    catalogOnlyByText.set(queryText, (catalogOnlyByText.get(queryText) ?? true) && catalogOnly);
  }
  for (const [text, catalogOnly] of catalogOnlyByText) if (catalogOnly) catalogTexts.add(text);

  const catalogStatements = statementEntries.filter(({ text, backend }) => {
    const key = catalogKey(backendAware, backend, text);
    return catalogKeys.has(key) && !freshnessProbeKeys.has(key);
  }).length;
  const freshnessProbes = statementEntries.filter(({ text, backend }) =>
    freshnessProbeKeys.has(catalogKey(backendAware, backend, text)),
  ).length;
  const nonCatalogTexts = new Set(
    statementEntries
      .filter(({ text, backend }) => !catalogKeys.has(catalogKey(backendAware, backend, text)))
      .map(({ text }) => text),
  );
  const firstCatalogStatement = statementEntries.find(
    ({ text, backend }) =>
      catalogKeys.has(catalogKey(backendAware, backend, text)) &&
      !freshnessProbeKeys.has(catalogKey(backendAware, backend, text)),
  )?.text;
  return {
    catalogTexts,
    catalogKeys,
    backendAware,
    catalogStatements,
    freshnessProbes,
    allowedStatements: nonCatalogTexts.size,
    firstCatalogStatement,
  };
}

function catalogKey(backendAware: boolean, backend: number | undefined, text: string): string {
  return backendAware ? JSON.stringify([backend ?? null, text]) : text;
}

function isCatalogQuery(classification: CatalogClassification, text: string, backend: number | undefined): boolean {
  return classification.catalogKeys.has(catalogKey(classification.backendAware, backend, text));
}

function hasMatchingStatement(
  statements: readonly string[],
  statementBackends: readonly (number | undefined)[] | undefined,
  planBackends: readonly (number | undefined)[] | undefined,
  queryText: string | undefined,
  backend: number | undefined,
): boolean {
  if (statementBackends === undefined || planBackends === undefined) return true;
  if (queryText === undefined) return false;
  return statements.some(
    (statement, index) =>
      catalogKey(true, statementBackends[index], statement) === catalogKey(true, backend, queryText),
  );
}

export function catalogStatementBound(capture: Capture): CatalogClassification {
  return classifyCatalogStatements(capture);
}

/** The capture without catalog statements and the plan documents that explain only those statements. */
export function withoutCatalogTexts(
  capture: Capture,
  classification: CatalogClassification | ReadonlySet<string>,
): Capture {
  const catalog: CatalogClassification =
    'catalogKeys' in classification
      ? classification
      : {
          catalogTexts: classification,
          catalogKeys: classification,
          backendAware: false,
          catalogStatements: 0,
          freshnessProbes: 0,
          allowedStatements: 0,
          firstCatalogStatement: undefined,
        };
  const statements = capture.statements.flatMap((statement, index) =>
    !isCatalogQuery(catalog, statement, capture.statementBackends?.[index]) ? [index] : [],
  );
  const plans = capture.plans.flatMap((document, index) => {
    const backend = capture.planBackends?.[index];
    const owner = capture.planStatements?.[index];
    if (owner !== undefined && !statements.includes(owner)) return [];
    return documentEntries(document).some(
      ({ queryText }) =>
        hasMatchingStatement(capture.statements, capture.statementBackends, capture.planBackends, queryText, backend) &&
        (queryText === undefined || !isCatalogQuery(catalog, queryText, backend)),
    )
      ? [index]
      : [];
  });
  return {
    statements: statements.map((index) => capture.statements[index]!),
    ...(capture.requestBytes === undefined
      ? {}
      : { requestBytes: statements.map((index) => capture.requestBytes![index]!) }),
    ...(capture.responseBytes === undefined
      ? {}
      : { responseBytes: statements.map((index) => capture.responseBytes![index]!) }),
    plans: plans.map((index) => capture.plans[index]!),
    ...(capture.statementErrors === undefined
      ? {}
      : { statementErrors: statements.map((index) => capture.statementErrors![index]!) }),
    ...(capture.statementErrorMessages === undefined
      ? {}
      : { statementErrorMessages: statements.map((index) => capture.statementErrorMessages![index]!) }),
    ...(capture.statementBackends === undefined
      ? {}
      : { statementBackends: statements.map((index) => capture.statementBackends![index]) }),
    ...(capture.planBackends === undefined ? {} : { planBackends: plans.map((index) => capture.planBackends![index]) }),
    ...(capture.planStatements === undefined
      ? {}
      : {
          planStatements: plans.map((index) => {
            const original = capture.planStatements![index];
            if (original === undefined) return undefined;
            const mapped = statements.indexOf(original);
            return mapped < 0 ? undefined : mapped;
          }),
        }),
    ...(capture.backgroundStatements === undefined ? {} : { backgroundStatements: capture.backgroundStatements }),
    ...(capture.backgroundRequestBytes === undefined ? {} : { backgroundRequestBytes: capture.backgroundRequestBytes }),
    ...(capture.backgroundResponseBytes === undefined
      ? {}
      : { backgroundResponseBytes: capture.backgroundResponseBytes }),
    ...(capture.backgroundPlans === undefined ? {} : { backgroundPlans: capture.backgroundPlans }),
    ...(capture.backgroundPlanStatements === undefined
      ? {}
      : { backgroundPlanStatements: capture.backgroundPlanStatements }),
    ...(capture.backgroundStatementErrors === undefined
      ? {}
      : { backgroundStatementErrors: capture.backgroundStatementErrors }),
    ...(capture.backgroundStatementErrorMessages === undefined
      ? {}
      : { backgroundStatementErrorMessages: capture.backgroundStatementErrorMessages }),
    ...(capture.backgroundStatementBackends === undefined
      ? {}
      : { backgroundStatementBackends: capture.backgroundStatementBackends }),
    ...(capture.backgroundPlanBackends === undefined ? {} : { backgroundPlanBackends: capture.backgroundPlanBackends }),
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
  const backendAware = capture.statementBackends !== undefined && capture.planBackends !== undefined;
  let plans = 0;

  for (let index = 0; index < capture.plans.length; index++) {
    const document = capture.plans[index];
    const backend = capture.planBackends?.[index];
    for (const { queryText, plan } of documentEntries(document)) {
      if (
        backendAware &&
        !hasMatchingStatement(capture.statements, capture.statementBackends, capture.planBackends, queryText, backend)
      )
        continue;
      if (queryText !== undefined && isCatalogQuery(catalog, queryText, backend)) continue;
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
  const backgroundBackendAware =
    capture.backgroundStatementBackends !== undefined && capture.backgroundPlanBackends !== undefined;
  for (let index = 0; index < (capture.backgroundPlans ?? []).length; index++) {
    const document = capture.backgroundPlans![index];
    const backend = capture.backgroundPlanBackends?.[index];
    for (const entry of documentEntries(document)) {
      if (
        backgroundBackendAware &&
        !hasMatchingStatement(
          capture.backgroundStatements ?? [],
          capture.backgroundStatementBackends,
          capture.backgroundPlanBackends,
          entry.queryText,
          backend,
        )
      )
        continue;
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
      (statement, index) =>
        !isControlStatement(statement) && !isCatalogQuery(catalog, statement, capture.statementBackends?.[index]),
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
  const requestBytes = capture.requestBytes?.reduce((sum, value) => sum + value, 0);
  const responseBytes = capture.responseBytes?.reduce((sum, value) => sum + value, 0);
  const hasBackgroundWork =
    (capture.backgroundStatements?.length ?? 0) > 0 ||
    (capture.backgroundRequestBytes?.length ?? 0) > 0 ||
    (capture.backgroundResponseBytes?.length ?? 0) > 0;
  const backgroundRequestBytes = capture.backgroundRequestBytes?.reduce((sum, value) => sum + value, 0);
  const backgroundResponseBytes = capture.backgroundResponseBytes?.reduce((sum, value) => sum + value, 0);
  const failedStatements = new Map<string, number>();
  for (const error of capture.statementErrors ?? [])
    if (error !== null) failedStatements.set(error, (failedStatements.get(error) ?? 0) + 1);
  return {
    ...cost,
    ...(requestBytes === undefined ? {} : { requestBytes }),
    ...(responseBytes === undefined ? {} : { responseBytes }),
    ...(failedStatements.size === 0 ? {} : { failedStatements: Object.fromEntries(failedStatements) }),
    ...(capture.backgroundStatements !== undefined ||
    capture.backgroundPlans !== undefined ||
    capture.backgroundRequestBytes !== undefined ||
    capture.backgroundResponseBytes !== undefined
      ? {
          backgroundStatements: (capture.backgroundStatements ?? []).length,
          ...(hasBackgroundWork && backgroundRequestBytes !== undefined ? { backgroundRequestBytes } : {}),
          ...(hasBackgroundWork && backgroundResponseBytes !== undefined ? { backgroundResponseBytes } : {}),
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
  const requestBytes = costs.flatMap(({ requestBytes }) => (requestBytes === undefined ? [] : [requestBytes]));
  const responseBytes = costs.flatMap(({ responseBytes }) => (responseBytes === undefined ? [] : [responseBytes]));
  const backgroundRequestBytes = costs.flatMap(({ backgroundRequestBytes }) =>
    backgroundRequestBytes === undefined ? [] : [backgroundRequestBytes],
  );
  const backgroundResponseBytes = costs.flatMap(({ backgroundResponseBytes }) =>
    backgroundResponseBytes === undefined ? [] : [backgroundResponseBytes],
  );

  const median = {
    statements: lowerMedian(costs.map((cost) => cost.statements)),
    ...(requestBytes.length === 0 ? {} : { requestBytes: lowerMedian(requestBytes) }),
    ...(responseBytes.length === 0 ? {} : { responseBytes: lowerMedian(responseBytes) }),
    controlStatements: lowerMedian(costs.map((cost) => cost.controlStatements)),
    catalogStatements: lowerMedian(costs.map((cost) => cost.catalogStatements)),
    plans: lowerMedian(costs.map((cost) => cost.plans)),
    rows: lowerMedian(costs.map((cost) => cost.rows)),
    blocks,
    sharedHit: lowerMedian(costs.map((cost) => cost.sharedHit)),
    sharedRead: lowerMedian(costs.map((cost) => cost.sharedRead)),
    relations: representative.relations,
  };
  const failedStatements = new Map<string, number>();
  for (const code of new Set(costs.flatMap((cost) => Object.keys(cost.failedStatements ?? {}))))
    failedStatements.set(code, lowerMedian(costs.map((cost) => cost.failedStatements?.[code] ?? 0)));
  return {
    ...median,
    ...(failedStatements.size === 0 ? {} : { failedStatements: Object.fromEntries(failedStatements) }),
    ...(costs.some((cost) => cost.backgroundStatements !== undefined)
      ? {
          backgroundStatements: lowerMedian(costs.map((cost) => cost.backgroundStatements ?? 0)),
          ...(backgroundRequestBytes.length === 0
            ? {}
            : { backgroundRequestBytes: lowerMedian(backgroundRequestBytes) }),
          ...(backgroundResponseBytes.length === 0
            ? {}
            : { backgroundResponseBytes: lowerMedian(backgroundResponseBytes) }),
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
