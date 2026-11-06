import { WORKFLOW_RETENTION_CASCADE_TABLES, WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES } from '../contract/bounds.ts';
import { type WorkflowRetentionByteInventory, type WorkflowRetentionCompleteWork, type WorkflowRetentionPayloadFamily, type WorkflowRetentionPayloadInventory, type WorkflowRetentionStatementKind } from './retention.ts';
export type WorkflowRetentionAttemptOutcome = 'empty' | 'commit' | 'rollback';
export type WorkflowRetentionObservedKindCounts = Readonly<Record<WorkflowRetentionStatementKind, number>>;
export type WorkflowRetentionObservedWork = WorkflowRetentionCompleteWork & Readonly<{
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
export declare function emptyRetentionKindCounts(): WorkflowRetentionObservedKindCounts;
export declare function countRetentionStatementKinds(statements: readonly string[]): WorkflowRetentionObservedKindCounts;
export declare function retentionForegroundKindsFor(selected: number): readonly WorkflowRetentionStatementKind[];
export declare function retentionControlKindsFor(outcome: WorkflowRetentionAttemptOutcome): readonly WorkflowRetentionStatementKind[];
export declare function retentionAttemptOutcome(counts: WorkflowRetentionObservedKindCounts): WorkflowRetentionAttemptOutcome;
export declare function retentionObservedFromKinds(counts: WorkflowRetentionObservedKindCounts, inventory?: WorkflowRetentionPayloadInventory, bytes?: WorkflowRetentionByteInventory, fenceRows?: number): WorkflowRetentionObservedWork;
export declare function retentionObservedWork(statements: readonly string[], inventory?: WorkflowRetentionPayloadInventory, bytes?: WorkflowRetentionByteInventory, fenceRows?: number): WorkflowRetentionObservedWork;
export declare function retentionObservedMatchesDerived(observed: WorkflowRetentionObservedWork, derived: WorkflowRetentionCompleteWork): boolean;
export declare function walkRetentionPlan(plan: unknown): WorkflowRetentionPlanNode | undefined;
export declare function flattenRetentionPlan(plan: WorkflowRetentionPlanNode | undefined): WorkflowRetentionPlanNode[];
export declare function retentionPlanIndexNames(plan: unknown): string[];
export declare function retentionPlanNodeTypes(plan: unknown): string[];
export declare function retentionPlanRelationNames(plan: unknown): string[];
export declare function retentionPlanSequentialScans(plan: unknown): number;
export declare function retentionPlanHasSequentialScan(plan: unknown): boolean;
export declare function retentionPlanUsesIndex(plan: unknown, indexName: string): boolean;
export declare function classifyRetentionPlanDocument(document: unknown): WorkflowRetentionPlanDocument | undefined;
export declare function classifyRetentionPlanDocuments(documents: readonly unknown[]): WorkflowRetentionPlanDocument[];
export declare function retentionSelectorPlanProof(documents: readonly unknown[]): WorkflowRetentionSelectorPlanProof;
export declare function retentionDeletePlanProof(documents: readonly unknown[]): WorkflowRetentionDeletePlanProof;
export declare function retentionEngineEnvelope(selected: number, copies: number, heapPagesPerCopy?: number, packingResidual?: number): WorkflowRetentionEngineEnvelope;
export declare function retentionEngineEnvelopeFromInventory(selected: number, inventory: WorkflowRetentionPayloadInventory, heapPagesPerCopy?: number, packingResidual?: number): WorkflowRetentionEngineEnvelope;
export declare function retentionPayloadCopies(inventory: WorkflowRetentionPayloadInventory): number;
export declare function retentionBackgroundAttribution(statements?: number, rows?: number, blocks?: number): WorkflowRetentionBackgroundAttribution;
export declare function retentionLoadClass(input: {
    readonly packingResidual: number;
    readonly sequentialScanChanged: boolean;
    readonly backgroundGrew: boolean;
    readonly affineResidual: number;
}): WorkflowRetentionLoadClass;
export declare function retentionExactIdDeleteKinds(): readonly WorkflowRetentionStatementKind[];
export declare function retentionCascadeDeleteKinds(): readonly WorkflowRetentionStatementKind[];
export declare function retentionFamilyTables(): readonly WorkflowRetentionPayloadFamily[];
export declare function retentionExplicitDeleteTables(): typeof WORKFLOW_RETENTION_EXPLICIT_DELETE_TABLES;
export declare function retentionCascadeTables(): typeof WORKFLOW_RETENTION_CASCADE_TABLES;
export declare function retentionNestedFkEnvelope(selected: number): Readonly<{
    statements: number;
    points: number;
    parentStatements: number;
}>;
export declare function retentionHealthyApplicationEnvelope(selected: number): Readonly<{
    select: number;
    exactIdDeletes: number;
    application: number;
    nestedFk: number;
}>;
export declare function retentionControlEnvelope(outcome: WorkflowRetentionAttemptOutcome): Readonly<{
    begin: number;
    commit: number;
    rollback: number;
    control: number;
}>;
