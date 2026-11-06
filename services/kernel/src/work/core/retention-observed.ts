import {
  WORKFLOW_RETENTION_CASCADE_TABLES,
  WORKFLOW_RETENTION_DELETE_DATA_STATEMENTS,
  WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES,
  WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
  WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS,
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_SELECT_STATEMENTS,
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  WORKFLOW_RETENTION_STATUS_DELETE_POINTS,
} from '../contract/bounds.ts';
import {
  classifyRetentionStatement,
  emptyWorkflowRetentionBytes,
  emptyWorkflowRetentionInventory,
  isRetentionCascadeDelete,
  isRetentionForegroundDelete,
  retentionCompleteBatchWork,
  retentionControlStatementCount,
  retentionDeleteTableFor,
  retentionIndexProbes,
  retentionInterruptedBatchWork,
  retentionOwnedRows,
  retentionPayloadRows,
  type WorkflowRetentionByteInventory,
  type WorkflowRetentionCompleteWork,
  type WorkflowRetentionPayloadFamily,
  type WorkflowRetentionPayloadInventory,
  type WorkflowRetentionStatementKind,
} from './retention.ts';

export type WorkflowRetentionAttemptOutcome = 'empty' | 'commit' | 'rollback';

export type WorkflowRetentionObservedKindCounts = Readonly<Record<WorkflowRetentionStatementKind, number>>;

export type WorkflowRetentionObservedWork = WorkflowRetentionCompleteWork &
  Readonly<{
    kinds: WorkflowRetentionObservedKindCounts;
    exactIdDeletes: number;
    cascadeDeletes: number;
    beginStatements: number;
    commitStatements: number;
    outcome: WorkflowRetentionAttemptOutcome;
    backgroundStatements: number;
    backgroundRows: number;
    backgroundBlocks: number;
  }>;

export type WorkflowRetentionPlanNode = Readonly<{
  nodeType: string;
  indexName?: string | undefined;
  relationName?: string | undefined;
  schema?: string | undefined;
  alias?: string | undefined;
  actualRows?: number | undefined;
  sharedHit?: number | undefined;
  sharedRead?: number | undefined;
  children: readonly WorkflowRetentionPlanNode[];
}>;

export type WorkflowRetentionPlanDocument = Readonly<{
  query: string;
  kind: WorkflowRetentionStatementKind;
  table?: string | undefined;
  plan?: WorkflowRetentionPlanNode | undefined;
  nodes: readonly string[];
  indexes: readonly string[];
  relations: readonly string[];
  sequentialScans: number;
}>;

export type WorkflowRetentionSelectorPlanProof = Readonly<{
  indexed: boolean;
  indexOnly: boolean;
  sequential: boolean;
  indexes: readonly string[];
  nodes: readonly string[];
}>;

export type WorkflowRetentionDeletePlanProof = Readonly<{
  exactIdDeletes: readonly WorkflowRetentionStatementKind[];
  nestedFkDeletes: readonly WorkflowRetentionStatementKind[];
  sequentialRelations: readonly string[];
  indexes: readonly string[];
}>;

export type WorkflowRetentionEngineEnvelope = Readonly<{
  intercept: number;
  slope: number;
  copies: number;
  predictedBlocks: number;
  indexProbes: number;
  packingResidual: number;
}>;

export type WorkflowRetentionLoadClass = 'affine' | 'packing' | 'plan-transition' | 'background';

export type WorkflowRetentionBackgroundAttribution = Readonly<{
  statements: number;
  rows: number;
  blocks: number;
  independent: boolean;
}>;

const statementKinds: readonly WorkflowRetentionStatementKind[] = [
  'select',
  'begin',
  'commit',
  'rollback',
  'delete-workflow_input',
  'delete-workflow_output',
  'delete-operation_outputs',
  'delete-workflow_status',
  'cascade-workflow_events',
  'cascade-workflow_events_history',
  'cascade-notifications',
  'cascade-streams',
  'other',
];

const emptyKinds = Object.freeze(
  Object.fromEntries(statementKinds.map((kind) => [kind, 0])) as WorkflowRetentionObservedKindCounts,
);

const exactIdKinds = [
  'delete-workflow_input',
  'delete-workflow_output',
  'delete-operation_outputs',
  'delete-workflow_status',
] as const satisfies readonly WorkflowRetentionStatementKind[];

const cascadeKinds = [
  'cascade-workflow_events',
  'cascade-workflow_events_history',
  'cascade-notifications',
  'cascade-streams',
] as const satisfies readonly WorkflowRetentionStatementKind[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function emptyRetentionKindCounts(): WorkflowRetentionObservedKindCounts {
  return emptyKinds;
}

export function countRetentionStatementKinds(
  statements: readonly string[],
): WorkflowRetentionObservedKindCounts {
  const counts = { ...emptyKinds };
  for (const statement of statements) counts[classifyRetentionStatement(statement)] += 1;
  return counts;
}

export function retentionForegroundKindsFor(selected: number): readonly WorkflowRetentionStatementKind[] {
  if (selected === 0) return ['select'];
  return ['select', ...exactIdKinds];
}

export function retentionControlKindsFor(
  outcome: WorkflowRetentionAttemptOutcome,
): readonly WorkflowRetentionStatementKind[] {
  if (outcome === 'empty') return [];
  if (outcome === 'rollback') return ['begin', 'rollback'];
  return ['begin', 'commit'];
}

export function retentionAttemptOutcome(
  counts: WorkflowRetentionObservedKindCounts,
): WorkflowRetentionAttemptOutcome {
  if (counts.rollback > 0) return 'rollback';
  if (counts.select > 0 && counts['delete-workflow_status'] === 0 && counts.begin === 0) return 'empty';
  return 'commit';
}

export function retentionObservedFromKinds(
  counts: WorkflowRetentionObservedKindCounts,
  inventory: WorkflowRetentionPayloadInventory = emptyWorkflowRetentionInventory(),
  bytes: WorkflowRetentionByteInventory = emptyWorkflowRetentionBytes(),
  fenceRows = inventory.workflow_status,
): WorkflowRetentionObservedWork {
  const selected = inventory.workflow_status;
  const outcome = retentionAttemptOutcome(counts);
  const derived =
    outcome === 'rollback'
      ? retentionInterruptedBatchWork(selected, inventory, bytes, false)
      : retentionCompleteBatchWork(selected, inventory, bytes, fenceRows);
  const applicationStatements = counts.select + exactIdKinds.reduce((sum, kind) => sum + counts[kind], 0);
  const beginStatements = counts.begin;
  const commitStatements = counts.commit;
  const rollbackStatements = counts.rollback;
  const controlStatements = beginStatements + commitStatements + rollbackStatements;
  const exactIdDeletes = exactIdKinds.reduce((sum, kind) => sum + counts[kind], 0);
  const cascadeDeletes = cascadeKinds.reduce((sum, kind) => sum + counts[kind], 0);
  return {
    ...derived,
    kinds: counts,
    statements: applicationStatements + controlStatements,
    applicationStatements,
    controlStatements,
    selectStatements: counts.select,
    deleteStatements: exactIdDeletes === 0 ? 0 : exactIdDeletes + controlStatements,
    exactIdDeletes,
    cascadeDeletes,
    beginStatements,
    commitStatements,
    rollbackStatements,
    outcome,
    backgroundStatements: 0,
    backgroundRows: 0,
    backgroundBlocks: 0,
  };
}

export function retentionObservedWork(
  statements: readonly string[],
  inventory: WorkflowRetentionPayloadInventory = emptyWorkflowRetentionInventory(),
  bytes: WorkflowRetentionByteInventory = emptyWorkflowRetentionBytes(),
  fenceRows = 0,
): WorkflowRetentionObservedWork {
  return retentionObservedFromKinds(countRetentionStatementKinds(statements), inventory, bytes, fenceRows);
}

export function retentionObservedMatchesDerived(
  observed: WorkflowRetentionObservedWork,
  derived: WorkflowRetentionCompleteWork,
): boolean {
  return (
    observed.selected === derived.selected &&
    observed.applicationStatements === derived.applicationStatements &&
    observed.controlStatements === derived.controlStatements &&
    observed.selectStatements === derived.selectStatements &&
    observed.nestedFkStatements === derived.nestedFkStatements &&
    observed.deletionRows === derived.deletionRows &&
    observed.payloadBytes === derived.payloadBytes &&
    observed.fenceRows === derived.fenceRows &&
    observed.backgroundStatements === 0
  );
}

export function walkRetentionPlan(plan: unknown): WorkflowRetentionPlanNode | undefined {
  if (Array.isArray(plan)) return walkRetentionPlan(plan[0]);
  const entry = asRecord(plan);
  if (!entry) return undefined;
  const nodeType = readString(entry['Node Type']);
  if (!nodeType) return undefined;
  const nested = entry.Plans;
  const children = Array.isArray(nested)
    ? nested.flatMap((child) => {
        const node = walkRetentionPlan(child);
        return node ? [node] : [];
      })
    : [];
  const buffers = asRecord(entry['Shared Hit Blocks'])
    ? undefined
    : asRecord(entry['Buffers']) ?? asRecord(entry);
  return {
    nodeType,
    indexName: readString(entry['Index Name']),
    relationName: readString(entry['Relation Name']),
    schema: readString(entry['Schema']),
    alias: readString(entry['Alias']),
    actualRows: readNumber(entry['Actual Rows']),
    sharedHit: readNumber(entry['Shared Hit Blocks']) ?? readNumber(buffers?.['Shared Hit Blocks']),
    sharedRead: readNumber(entry['Shared Read Blocks']) ?? readNumber(buffers?.['Shared Read Blocks']),
    children,
  };
}

export function flattenRetentionPlan(plan: WorkflowRetentionPlanNode | undefined): WorkflowRetentionPlanNode[] {
  if (!plan) return [];
  return [plan, ...plan.children.flatMap(flattenRetentionPlan)];
}

export function retentionPlanIndexNames(plan: unknown): string[] {
  return [...new Set(flattenRetentionPlan(walkRetentionPlan(plan)).flatMap((node) => (node.indexName ? [node.indexName] : [])))];
}

export function retentionPlanNodeTypes(plan: unknown): string[] {
  return flattenRetentionPlan(walkRetentionPlan(plan)).map((node) => node.nodeType);
}

export function retentionPlanRelationNames(plan: unknown): string[] {
  return [
    ...new Set(
      flattenRetentionPlan(walkRetentionPlan(plan)).flatMap((node) => (node.relationName ? [node.relationName] : [])),
    ),
  ];
}

export function retentionPlanSequentialScans(plan: unknown): number {
  return flattenRetentionPlan(walkRetentionPlan(plan)).filter((node) => node.nodeType === 'Seq Scan').length;
}

export function retentionPlanHasSequentialScan(plan: unknown): boolean {
  return retentionPlanSequentialScans(plan) > 0;
}

export function retentionPlanUsesIndex(plan: unknown, indexName: string): boolean {
  return retentionPlanIndexNames(plan).includes(indexName);
}

export function classifyRetentionPlanDocument(document: unknown): WorkflowRetentionPlanDocument | undefined {
  const roots = Array.isArray(document) ? document : [document];
  for (const root of roots) {
    const entry = asRecord(root);
    if (!entry || entry.Plan === undefined) continue;
    const query = readString(entry['Query Text']) ?? '';
    const kind = classifyRetentionStatement(query);
    return {
      query,
      kind,
      table: retentionDeleteTableFor(kind),
      plan: walkRetentionPlan(entry.Plan),
      nodes: retentionPlanNodeTypes(entry.Plan),
      indexes: retentionPlanIndexNames(entry.Plan),
      relations: retentionPlanRelationNames(entry.Plan),
      sequentialScans: retentionPlanSequentialScans(entry.Plan),
    };
  }
  return undefined;
}

export function classifyRetentionPlanDocuments(
  documents: readonly unknown[],
): WorkflowRetentionPlanDocument[] {
  return documents.flatMap((document) => {
    const classified = classifyRetentionPlanDocument(document);
    return classified ? [classified] : [];
  });
}

export function retentionSelectorPlanProof(
  documents: readonly unknown[],
): WorkflowRetentionSelectorPlanProof {
  const selector = classifyRetentionPlanDocuments(documents).filter((document) => document.kind === 'select');
  const indexes = [...new Set(selector.flatMap((document) => document.indexes))];
  const nodes = [...new Set(selector.flatMap((document) => document.nodes))];
  return {
    indexed: indexes.includes(WORKFLOW_RETENTION_SELECTOR_INDEX),
    indexOnly: nodes.includes('Index Only Scan'),
    sequential: selector.some((document) => document.sequentialScans > 0),
    indexes,
    nodes,
  };
}

export function retentionDeletePlanProof(documents: readonly unknown[]): WorkflowRetentionDeletePlanProof {
  const classified = classifyRetentionPlanDocuments(documents);
  const exactIdDeletes = classified
    .filter((document) => isRetentionForegroundDelete(document.kind))
    .map((document) => document.kind);
  const nestedFkDeletes = classified
    .filter((document) => isRetentionCascadeDelete(document.kind))
    .map((document) => document.kind);
  const sequentialRelations = [
    ...new Set(
      classified.flatMap((document) =>
        document.sequentialScans > 0 ? document.relations : [],
      ),
    ),
  ];
  return {
    exactIdDeletes,
    nestedFkDeletes,
    sequentialRelations,
    indexes: [...new Set(classified.flatMap((document) => document.indexes))],
  };
}

export function retentionEngineEnvelope(
  selected: number,
  copies: number,
  heapPagesPerCopy = 1,
  packingResidual = 0,
): WorkflowRetentionEngineEnvelope {
  const indexProbes = retentionIndexProbes(selected);
  const intercept = selected === 0 ? 1 : indexProbes;
  const slope = selected === 0 ? 0 : Math.max(0, heapPagesPerCopy);
  return {
    intercept,
    slope,
    copies,
    predictedBlocks: intercept + slope * copies,
    indexProbes,
    packingResidual: Math.max(0, packingResidual),
  };
}

export function retentionEngineEnvelopeFromInventory(
  selected: number,
  inventory: WorkflowRetentionPayloadInventory,
  heapPagesPerCopy = 1,
  packingResidual = 0,
): WorkflowRetentionEngineEnvelope {
  return retentionEngineEnvelope(selected, retentionOwnedRows(inventory), heapPagesPerCopy, packingResidual);
}

export function retentionPayloadCopies(inventory: WorkflowRetentionPayloadInventory): number {
  return retentionPayloadRows(inventory);
}

export function retentionBackgroundAttribution(
  statements = 0,
  rows = 0,
  blocks = 0,
): WorkflowRetentionBackgroundAttribution {
  return {
    statements,
    rows,
    blocks,
    independent: statements === 0 && rows === 0 && blocks === 0,
  };
}

export function retentionLoadClass(input: {
  readonly packingResidual: number;
  readonly sequentialScanChanged: boolean;
  readonly backgroundGrew: boolean;
  readonly affineResidual: number;
}): WorkflowRetentionLoadClass {
  if (input.backgroundGrew) return 'background';
  if (input.sequentialScanChanged) return 'plan-transition';
  if (input.packingResidual > input.affineResidual && input.packingResidual > 0) return 'packing';
  return 'affine';
}

export function retentionExactIdDeleteKinds(): readonly WorkflowRetentionStatementKind[] {
  return exactIdKinds;
}

export function retentionCascadeDeleteKinds(): readonly WorkflowRetentionStatementKind[] {
  return cascadeKinds;
}

export function retentionFamilyTables(): readonly WorkflowRetentionPayloadFamily[] {
  return WORKFLOW_RETENTION_PAYLOAD_FAMILIES.map((family) => family.table);
}

export function retentionExplicitDeleteTables(): typeof WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES {
  return WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES;
}

export function retentionCascadeTables(): typeof WORKFLOW_RETENTION_CASCADE_TABLES {
  return WORKFLOW_RETENTION_CASCADE_TABLES;
}

export function retentionNestedFkEnvelope(selected: number): Readonly<{
  statements: number;
  points: number;
  parentStatements: number;
}> {
  if (selected === 0) return { statements: 0, points: 0, parentStatements: 0 };
  return {
    statements: WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
    points: WORKFLOW_RETENTION_STATUS_DELETE_POINTS,
    parentStatements: 1,
  };
}

export function retentionHealthyApplicationEnvelope(selected: number): Readonly<{
  select: number;
  exactIdDeletes: number;
  application: number;
  nestedFk: number;
}> {
  if (selected === 0) {
    return { select: WORKFLOW_RETENTION_SELECT_STATEMENTS, exactIdDeletes: 0, application: 1, nestedFk: 0 };
  }
  return {
    select: WORKFLOW_RETENTION_SELECT_STATEMENTS,
    exactIdDeletes: WORKFLOW_RETENTION_DELETE_DATA_STATEMENTS,
    application: WORKFLOW_RETENTION_NONEMPTY_APPLICATION_STATEMENTS,
    nestedFk: WORKFLOW_RETENTION_NESTED_FK_STATEMENTS,
  };
}

export function retentionControlEnvelope(
  outcome: WorkflowRetentionAttemptOutcome,
): Readonly<{ begin: number; commit: number; rollback: number; control: number }> {
  if (outcome === 'empty') return { begin: 0, commit: 0, rollback: 0, control: 0 };
  if (outcome === 'rollback') return { begin: 1, commit: 0, rollback: 1, control: retentionControlStatementCount(1) };
  return { begin: 1, commit: 1, rollback: 0, control: retentionControlStatementCount(1) };
}
