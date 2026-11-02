import {
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  requireDenseArray,
  requireNonNegativeFiniteNumber,
  sumFinite,
} from './growth-numeric.ts';
import { walkPlanTree, type PlanNode } from './growth-plan-walk.ts';

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
  requireNonNegativeFiniteNumber(value, `Plan node ${field}`);
  return value;
}

function optionalNumber(node: PlanNode, field: string, fallback = 0): number {
  const value = node[field];
  if (value === undefined) return fallback;
  requireNonNegativeFiniteNumber(value, `Plan node ${field}`);
  return value;
}

type PlanEntry = { readonly queryText: string | undefined; readonly plan: PlanNode; readonly location: string };

function documentEntries(document: unknown, location = 'plan'): PlanEntry[] {
  if (Array.isArray(document)) {
    if (document.length === 0) throw new TypeError('EXPLAIN plan document is empty');
    return document.map((entry, index) => {
      if (!isRecord(entry) || !isRecord(entry.Plan)) throw new TypeError('EXPLAIN plan document has no Plan');
      return {
        queryText: typeof entry['Query Text'] === 'string' ? entry['Query Text'] : undefined,
        plan: entry.Plan,
        location: `${location}[${index}].Plan`,
      };
    });
  }
  if (isRecord(document) && typeof document['Query Text'] === 'string' && isRecord(document.Plan))
    return [{ queryText: document['Query Text'], plan: document.Plan, location: `${location}.Plan` }];
  throw new TypeError('Unrecognized plan document');
}

function isCatalogOnlyPlan(root: PlanNode, location: string): boolean {
  let hasRelation = false;
  let catalogOnly = true;
  for (const { node } of walkPlanTree(root, location)) {
    if (typeof node['Relation Name'] === 'string') {
      hasRelation = true;
      catalogOnly = catalogOnly && (node.Schema === 'pg_catalog' || node.Schema === 'information_schema');
    }
  }
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
const nativeCatalogOccurrences = new WeakMap<CatalogClassification, ReadonlySet<number>>();

function isFreshnessProbeText(text: string): boolean {
  return [/\bAS\s+fresh_table\b/i, /\bAS\s+fresh_column\b/i, /\bAS\s+fresh_type\b/i].every((alias) => alias.test(text));
}

function classifyCatalogStatements(capture: Capture, planCollection = 'plans'): CatalogClassification {
  const backendAware = capture.statementBackends !== undefined && capture.planBackends !== undefined;
  const statementEntries = capture.statements.flatMap((text, index) =>
    !isControlStatement(text) ? [{ index, text, backend: capture.statementBackends?.[index] }] : [],
  );
  const catalogTexts = new Set<string>();
  const catalogKeys = new Set<string>();
  const catalogStatementIndexes = new Set<number>();
  const freshnessProbeKeys = new Set<string>();
  const catalogOnlyByText = new Map<string, boolean>();
  if (capture.planStatements !== undefined) {
    const plansByStatement = new Map<number, PlanEntry[]>();
    const catalogOnlyByKey = new Map<string, boolean>();
    const textByKey = new Map<string, string>();
    for (let planIndex = 0; planIndex < capture.plans.length; planIndex++) {
      const owner = capture.planStatements[planIndex];
      if (owner === undefined || !Number.isInteger(owner) || owner < 0 || owner >= capture.statements.length) continue;
      const plans = plansByStatement.get(owner) ?? [];
      plans.push(...documentEntries(capture.plans[planIndex], `${planCollection}[${planIndex}]`));
      plansByStatement.set(owner, plans);
    }
    for (const { index, text, backend } of statementEntries) {
      const plans = plansByStatement.get(index);
      const key = catalogKey(backendAware, backend, text);
      const catalogOnly =
        plans !== undefined &&
        plans.length > 0 &&
        plans.every(({ plan, location }) => isCatalogOnlyPlan(plan, location));
      catalogOnlyByText.set(text, (catalogOnlyByText.get(text) ?? true) && catalogOnly);
      catalogOnlyByKey.set(key, (catalogOnlyByKey.get(key) ?? true) && catalogOnly);
      textByKey.set(key, text);
      if (catalogOnly) {
        catalogStatementIndexes.add(index);
      }
    }
    for (const [key, catalogOnly] of catalogOnlyByKey)
      if (catalogOnly) {
        catalogKeys.add(key);
        if (isFreshnessProbeText(textByKey.get(key)!)) freshnessProbeKeys.add(key);
      }
    for (const [text, catalogOnly] of catalogOnlyByText) if (catalogOnly) catalogTexts.add(text);
  } else {
    const clientKeys = new Set(statementEntries.map(({ text, backend }) => catalogKey(backendAware, backend, text)));
    const plansByKey = new Map<string, PlanEntry[]>();
    for (let index = 0; index < capture.plans.length; index++) {
      const backend = capture.planBackends?.[index];
      for (const entry of documentEntries(capture.plans[index], `${planCollection}[${index}]`)) {
        if (entry.queryText === undefined) continue;
        const key = catalogKey(backendAware, backend, entry.queryText);
        if (!clientKeys.has(key)) continue;
        const plans = plansByKey.get(key) ?? [];
        plans.push(entry);
        plansByKey.set(key, plans);
      }
    }
    for (const [key, plans] of plansByKey) {
      const queryText = plans[0]!.queryText!;
      const catalogOnly = plans.length > 0 && plans.every(({ plan, location }) => isCatalogOnlyPlan(plan, location));
      if (catalogOnly) {
        catalogKeys.add(key);
        if (isFreshnessProbeText(queryText)) freshnessProbeKeys.add(key);
      }
      catalogOnlyByText.set(queryText, (catalogOnlyByText.get(queryText) ?? true) && catalogOnly);
    }
    for (const [text, catalogOnly] of catalogOnlyByText) if (catalogOnly) catalogTexts.add(text);
    for (const { index, text, backend } of statementEntries)
      if (catalogKeys.has(catalogKey(backendAware, backend, text))) catalogStatementIndexes.add(index);
  }

  const catalogStatements = statementEntries.filter(({ index, text, backend }) => {
    if (capture.planStatements !== undefined) return catalogStatementIndexes.has(index) && !isFreshnessProbeText(text);
    const key = catalogKey(backendAware, backend, text);
    return catalogKeys.has(key) && !freshnessProbeKeys.has(key);
  }).length;
  const freshnessProbes = statementEntries.filter(({ index, text, backend }) =>
    capture.planStatements !== undefined
      ? catalogStatementIndexes.has(index) && isFreshnessProbeText(text)
      : freshnessProbeKeys.has(catalogKey(backendAware, backend, text)),
  ).length;
  const nonCatalogTexts = new Set(
    statementEntries
      .filter(({ index, text, backend }) =>
        capture.planStatements !== undefined
          ? !catalogStatementIndexes.has(index)
          : !catalogKeys.has(catalogKey(backendAware, backend, text)),
      )
      .map(({ text }) => text),
  );
  const firstCatalogStatement = statementEntries.find(({ index, text, backend }) =>
    capture.planStatements !== undefined
      ? catalogStatementIndexes.has(index) && !isFreshnessProbeText(text)
      : catalogKeys.has(catalogKey(backendAware, backend, text)) &&
        !freshnessProbeKeys.has(catalogKey(backendAware, backend, text)),
  )?.text;
  const classification: CatalogClassification = {
    catalogTexts,
    catalogKeys,
    backendAware,
    catalogStatements,
    freshnessProbes,
    allowedStatements: nonCatalogTexts.size,
    firstCatalogStatement,
  };
  nativeCatalogOccurrences.set(classification, catalogStatementIndexes);
  return classification;
}

function catalogKey(backendAware: boolean, backend: number | undefined, text: string): string {
  return backendAware ? JSON.stringify([backend ?? null, text]) : text;
}

function isCatalogQuery(classification: CatalogClassification, text: string, backend: number | undefined): boolean {
  return classification.catalogKeys.has(catalogKey(classification.backendAware, backend, text));
}

function statementKeys(
  statements: readonly string[],
  statementBackends: readonly (number | undefined)[] | undefined,
  backendAware: boolean,
): Set<string> {
  return new Set(statements.map((statement, index) => catalogKey(backendAware, statementBackends?.[index], statement)));
}

function hasMatchingStatement(
  keys: ReadonlySet<string>,
  backendAware: boolean,
  queryText: string | undefined,
  backend: number | undefined,
): boolean {
  if (!backendAware) return true;
  if (queryText === undefined) return false;
  return keys.has(catalogKey(true, backend, queryText));
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
  const nativeCatalogIndexes = nativeCatalogOccurrences.get(catalog);
  const statements = capture.statements.flatMap((statement, index) => {
    const excluded =
      capture.planStatements !== undefined
        ? nativeCatalogIndexes?.has(index) === true
        : isCatalogQuery(catalog, statement, capture.statementBackends?.[index]);
    return excluded ? [] : [index];
  });
  const remappedStatements = new Map<number, number>();
  statements.forEach((original, index) => remappedStatements.set(original, index));
  const backendAware = capture.statementBackends !== undefined && capture.planBackends !== undefined;
  const matchingStatements = statementKeys(capture.statements, capture.statementBackends, backendAware);
  const plans = capture.plans.flatMap((document, index) => {
    const backend = capture.planBackends?.[index];
    const owner = capture.planStatements?.[index];
    if (capture.planStatements !== undefined) {
      if (owner === undefined || owner < 0 || owner >= capture.statements.length) return [index];
      return remappedStatements.has(owner) ? [index] : [];
    }
    if (owner !== undefined && !remappedStatements.has(owner)) return [];
    return documentEntries(document).some(
      ({ queryText }) =>
        hasMatchingStatement(matchingStatements, backendAware, queryText, backend) &&
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
            return remappedStatements.get(original);
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
  total.hit = checkedAdd(total.hit, hit, `Inclusive hit blocks for CTE ${name}`);
  total.read = checkedAdd(total.read, read, `Inclusive read blocks for CTE ${name}`);
  blocks.set(name, total);
}

function costNode(
  root: PlanNode,
  relations: Map<string, MutableRelationCost>,
  ctes: CteBlocks,
  location: string,
): NodeTotals {
  const totalsByNode = new Map<PlanNode, NodeTotals>();
  for (const { node, depth } of walkPlanTree(root, location, 'postorder')) {
    const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
    const actualRows = requiredNumber(node, 'Actual Rows');
    const loops = optionalNumber(node, 'Actual Loops', 1);
    const hit = optionalNumber(node, 'Shared Hit Blocks');
    const read = optionalNumber(node, 'Shared Read Blocks');
    if (depth === 0 && node['Shared Hit Blocks'] === undefined)
      throw new TypeError('Plan root is missing Shared Hit Blocks');

    const childNodes = (node.Plans as PlanNode[] | undefined) ?? [];
    const children = childNodes.map((child) => totalsByNode.get(child)!);
    const childHit = children.reduce((sum, child) => checkedAdd(sum, child.inclusiveHit, 'Child shared hit blocks'), 0);
    const childRead = children.reduce(
      (sum, child) => checkedAdd(sum, child.inclusiveRead, 'Child shared read blocks'),
      0,
    );
    const exclusiveHit = Math.max(0, checkedSubtract(hit, childHit, 'Exclusive shared hit blocks'));
    const exclusiveRead = Math.max(0, checkedSubtract(read, childRead, 'Exclusive shared read blocks'));
    const producer = typeof node['Subplan Name'] === 'string' ? /^CTE (.+)$/.exec(node['Subplan Name']) : null;
    if (producer) addBlocks(ctes.producers, producer[1]!, hit, read);
    if (nodeType === 'CTE Scan' && typeof node['CTE Name'] === 'string')
      addBlocks(ctes.scans, node['CTE Name'], exclusiveHit, exclusiveRead);
    const removedByFilter = optionalNumber(node, 'Rows Removed by Filter');
    const removedByRecheck = optionalNumber(node, 'Rows Removed by Index Recheck');
    const rowsPerLoop = rowScans.has(nodeType)
      ? checkedAdd(
          checkedAdd(actualRows, removedByFilter, 'Rows examined before recheck'),
          removedByRecheck,
          'Rows examined per loop',
        )
      : 0;
    const examined = rowScans.has(nodeType) && loops > 0 ? checkedMultiply(rowsPerLoop, loops, 'Rows examined') : 0;

    if (rowScans.has(nodeType) || nodeType === 'ModifyTable') {
      const relationName = node['Relation Name'];
      if (typeof relationName === 'string') {
        const schema = node.Schema;
        const key = typeof schema === 'string' ? `${schema}.${relationName}` : relationName;
        addRelation(
          relations,
          key,
          nodeType === 'ModifyTable' && loops > 0
            ? checkedMultiply(actualRows, loops, 'Rows modified')
            : nodeType === 'ModifyTable'
              ? 0
              : examined,
          checkedAdd(exclusiveHit, exclusiveRead, 'Exclusive relation blocks'),
          nodeType === 'Seq Scan' && loops > 0 ? 1 : 0,
        );
      }
    } else if (nodeType === 'Bitmap Index Scan') {
      const indexName = node['Index Name'];
      if (typeof indexName === 'string')
        addRelation(
          relations,
          `index:${indexName}`,
          0,
          checkedAdd(exclusiveHit, exclusiveRead, 'Exclusive index blocks'),
        );
    }

    totalsByNode.set(node, {
      rows: children.reduce((sum, child) => checkedAdd(sum, child.rows, 'Child rows examined'), examined),
      inclusiveHit: hit,
      inclusiveRead: read,
    });
  }
  return totalsByNode.get(root)!;
}

function addRelation(
  relations: Map<string, MutableRelationCost>,
  key: string,
  rows: number,
  blocks: number,
  sequentialScans = 0,
): void {
  const relation = relations.get(key) ?? { rows: 0, blocks: 0, nodes: 0, sequentialScans: 0 };
  relation.rows = checkedAdd(relation.rows, rows, `Rows for relation ${key}`);
  relation.blocks = checkedAdd(relation.blocks, blocks, `Blocks for relation ${key}`);
  relation.nodes++;
  relation.sequentialScans = checkedAdd(
    relation.sequentialScans,
    sequentialScans,
    `Sequential scans for relation ${key}`,
  );
  relations.set(key, relation);
}

function validateByteMeasurements(values: readonly number[] | undefined, expected: number, label: string): void {
  if (values === undefined) return;
  requireDenseArray(values, label);
  if (values.length !== expected) throw new TypeError(`${label} must have one value per statement`);
  for (let index = 0; index < values.length; index += 1)
    requireNonNegativeFiniteNumber(values[index], `${label} at index ${index}`);
}

export function costOf(capture: Capture): Cost {
  return costOfAt(capture, 'plans');
}

function costOfAt(capture: Capture, planCollection: string): Cost {
  validateByteMeasurements(capture.requestBytes, capture.statements.length, 'Request bytes');
  validateByteMeasurements(capture.responseBytes, capture.statements.length, 'Response bytes');
  validateByteMeasurements(
    capture.backgroundRequestBytes,
    capture.backgroundStatements?.length ?? 0,
    'Background request bytes',
  );
  validateByteMeasurements(
    capture.backgroundResponseBytes,
    capture.backgroundStatements?.length ?? 0,
    'Background response bytes',
  );
  const relations = new Map<string, MutableRelationCost>();
  let rows = 0;
  let sharedHit = 0;
  let sharedRead = 0;
  const catalog = classifyCatalogStatements(capture, planCollection);
  const nativeCatalogIndexes = nativeCatalogOccurrences.get(catalog);
  const backendAware = capture.statementBackends !== undefined && capture.planBackends !== undefined;
  const matchingStatements = statementKeys(capture.statements, capture.statementBackends, backendAware);
  let plans = 0;

  for (let index = 0; index < capture.plans.length; index++) {
    const document = capture.plans[index];
    const backend = capture.planBackends?.[index];
    const owner = capture.planStatements?.[index];
    for (const { queryText, plan, location } of documentEntries(document, `${planCollection}[${index}]`)) {
      let included = true;
      if (capture.planStatements !== undefined) {
        if (
          owner !== undefined &&
          Number.isInteger(owner) &&
          owner >= 0 &&
          owner < capture.statements.length &&
          nativeCatalogIndexes?.has(owner) === true
        )
          included = false;
      } else {
        if (backendAware && !hasMatchingStatement(matchingStatements, true, queryText, backend)) included = false;
        if (queryText !== undefined && isCatalogQuery(catalog, queryText, backend)) included = false;
      }
      const ctes: CteBlocks = { producers: new Map(), scans: new Map() };
      const totals = costNode(plan, included ? relations : new Map<string, MutableRelationCost>(), ctes, location);
      if (!included) continue;
      plans++;
      rows = checkedAdd(rows, totals.rows, 'Total examined rows');
      sharedHit = checkedAdd(sharedHit, totals.inclusiveHit, 'Total shared hit blocks');
      sharedRead = checkedAdd(sharedRead, totals.inclusiveRead, 'Total shared read blocks');
      // A producer runs lazily inside the scans that read it, so those buffers are already in the root. What no scan
      // pulled (a data-modifying CTE that runs at the end of the statement) is not.
      for (const [name, producer] of ctes.producers) {
        const scans = ctes.scans.get(name);
        sharedHit = checkedAdd(
          sharedHit,
          Math.max(0, checkedSubtract(producer.hit, scans?.hit ?? 0, `Unscanned CTE ${name} hit blocks`)),
          'Total shared hit blocks including CTE work',
        );
        sharedRead = checkedAdd(
          sharedRead,
          Math.max(0, checkedSubtract(producer.read, scans?.read ?? 0, `Unscanned CTE ${name} read blocks`)),
          'Total shared read blocks including CTE work',
        );
      }
    }
  }

  const backgroundCosts = new Map<string, { rows: number; blocks: number; bounded: boolean }>();
  let backgroundRows = 0;
  let backgroundBlocks = 0;
  const backgroundBackendAware =
    capture.backgroundStatementBackends !== undefined && capture.backgroundPlanBackends !== undefined;
  const backgroundStatementKeys = statementKeys(
    capture.backgroundStatements ?? [],
    capture.backgroundStatementBackends,
    backgroundBackendAware,
  );
  for (let index = 0; index < (capture.backgroundPlans ?? []).length; index++) {
    const document = capture.backgroundPlans![index];
    const backend = capture.backgroundPlanBackends?.[index];
    for (const entry of documentEntries(document, `backgroundPlans[${index}]`)) {
      const included = !(
        capture.backgroundPlanStatements === undefined &&
        backgroundBackendAware &&
        !hasMatchingStatement(backgroundStatementKeys, true, entry.queryText, backend)
      );
      const key = entry.queryText ?? '<unknown background statement>';
      const planCost = costOfAt(
        {
          statements: [],
          plans: [[{ Plan: entry.plan, ...(entry.queryText === undefined ? {} : { 'Query Text': entry.queryText }) }]],
        },
        `backgroundPlans[${index}]`,
      );
      if (!included) continue;
      backgroundRows = checkedAdd(backgroundRows, planCost.rows, 'Total background examined rows');
      backgroundBlocks = checkedAdd(backgroundBlocks, planCost.blocks, 'Total background blocks');
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

  const totalBlocks = checkedAdd(sharedHit, sharedRead, 'Total shared blocks');
  const cost = {
    statements: capture.statements.filter(
      (statement, index) =>
        !isControlStatement(statement) &&
        (capture.planStatements !== undefined
          ? nativeCatalogIndexes?.has(index) !== true
          : !isCatalogQuery(catalog, statement, capture.statementBackends?.[index])),
    ).length,
    controlStatements: capture.statements.filter(isControlStatement).length,
    catalogStatements: catalog.catalogStatements,
    plans,
    rows: Math.round(rows),
    blocks: totalBlocks,
    sharedHit,
    sharedRead,
    relations: Object.fromEntries(relations),
  };
  const requestBytes =
    capture.requestBytes === undefined ? undefined : sumFinite(capture.requestBytes, 'Request bytes');
  const responseBytes =
    capture.responseBytes === undefined ? undefined : sumFinite(capture.responseBytes, 'Response bytes');
  const hasBackgroundWork =
    (capture.backgroundStatements?.length ?? 0) > 0 ||
    (capture.backgroundRequestBytes?.length ?? 0) > 0 ||
    (capture.backgroundResponseBytes?.length ?? 0) > 0;
  const backgroundRequestBytes =
    capture.backgroundRequestBytes === undefined
      ? undefined
      : sumFinite(capture.backgroundRequestBytes, 'Background request bytes');
  const backgroundResponseBytes =
    capture.backgroundResponseBytes === undefined
      ? undefined
      : sumFinite(capture.backgroundResponseBytes, 'Background response bytes');
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
  if (values.length === 0) throw new RangeError('Cannot take the median of no values');
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

function validateCostEvidence(cost: Cost, index: number): void {
  if (!isRecord(cost)) throw new TypeError(`Cost repetition ${index} must be an object`);
  const coreFields = [
    'statements',
    'controlStatements',
    'catalogStatements',
    'plans',
    'rows',
    'blocks',
    'sharedHit',
    'sharedRead',
  ] as const;
  for (const field of coreFields) requireNonNegativeFiniteNumber(cost[field], `Cost ${field} at repetition ${index}`);
  const optionalFields = [
    'requestBytes',
    'responseBytes',
    'backgroundStatements',
    'backgroundRequestBytes',
    'backgroundResponseBytes',
    'backgroundRows',
    'backgroundBlocks',
  ] as const;
  for (const field of optionalFields)
    if (cost[field] !== undefined) requireNonNegativeFiniteNumber(cost[field], `Cost ${field} at repetition ${index}`);

  if (!isRecord(cost.relations)) throw new TypeError(`Cost relations at repetition ${index} must be an object`);
  for (const [name, relation] of Object.entries(cost.relations)) {
    if (!isRecord(relation)) throw new TypeError(`Cost relation ${name} at repetition ${index} must be an object`);
    for (const field of ['rows', 'blocks', 'nodes', 'sequentialScans'] as const)
      requireNonNegativeFiniteNumber(relation[field], `Cost relation ${name} ${field} at repetition ${index}`);
  }

  if (cost.failedStatements !== undefined) {
    if (!isRecord(cost.failedStatements))
      throw new TypeError(`Cost failed statement counts at repetition ${index} must be an object`);
    for (const [sqlstate, value] of Object.entries(cost.failedStatements))
      requireNonNegativeFiniteNumber(value, `Failed statement count ${sqlstate} at repetition ${index}`);
  }
  if (cost.backgroundCosts !== undefined) {
    if (!isRecord(cost.backgroundCosts))
      throw new TypeError(`Cost background costs at repetition ${index} must be an object`);
    for (const [name, background] of Object.entries(cost.backgroundCosts)) {
      if (!isRecord(background))
        throw new TypeError(`Background cost ${name} at repetition ${index} must be an object`);
      requireNonNegativeFiniteNumber(background.rows, `Background rows for ${name} at repetition ${index}`);
      requireNonNegativeFiniteNumber(background.blocks, `Background blocks for ${name} at repetition ${index}`);
      if (typeof background.bounded !== 'boolean')
        throw new TypeError(`Background bounded flag for ${name} at repetition ${index} must be boolean`);
    }
  }
}

export function medianCost(costs: readonly Cost[]): Cost {
  requireDenseArray(costs, 'Cost repetitions');
  if (costs.length === 0) throw new RangeError('Cannot take the median of no costs');
  costs.forEach(validateCostEvidence);
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
