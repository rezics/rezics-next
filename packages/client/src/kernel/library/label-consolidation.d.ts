import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export declare const LABEL_CONSOLIDATION_LIMITS: Readonly<{
    selection: 16;
    confirmationMinutes: 15;
    retainedPerOwner: 8;
}>;
export type LabelConsolidationSelection = {
    subjectId: string;
    assignmentId: string;
    revision: number;
};
type ItemStatus = 'pending' | 'applying' | 'moved' | 'target_applied_source_retained' | 'capacity_limited' | 'changed' | 'inaccessible';
export type LabelConsolidationResult = {
    confirmationId: string;
    sourceLabelId: string;
    targetLabelId: string;
    status: 'active' | 'completed' | 'cancelled';
    expiresAt: string;
    items: Array<{
        item: number;
        selected?: LabelConsolidationSelection;
        status: Exclude<ItemStatus, 'applying'> | 'processing';
        targetAssignment?: {
            id: string;
            revision: number;
        };
        targetUnchanged?: boolean;
        sourceUnassignRevision?: number;
    }>;
};
/** Immutable per-selection bindings that replay only their original native assign/unassign receipts. */
export declare function createLabelConsolidationCommands(deps: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
}): {
    confirm: (ownerActor: Actor, sourceValue: string, value: unknown, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
        confirmationId: `${string}-${string}-${string}-${string}-${string}`;
        expiresAt: string;
        status: 'active';
        itemCount: number;
    }>>;
    apply: (ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string, key: string) => Promise<{
        operation: import("../command/command.ts").CommandOutcome<{
            confirmationId: string;
            item: number;
        }>;
        result: LabelConsolidationResult;
    }>;
    retry: (ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string, itemNoValue: number, key: string) => Promise<{
        operation: import("../command/command.ts").CommandOutcome<{
            confirmationId: string;
            item: number;
        }>;
        result: LabelConsolidationResult;
    }>;
    cancel: (ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string, key: string) => Promise<{
        operation: import("../command/command.ts").CommandOutcome<{
            confirmationId: string;
            status: "cancelled" | "completed";
        }>;
        result: LabelConsolidationResult;
    }>;
    result: (ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string) => Promise<LabelConsolidationResult>;
};
/** Scheduled native expiry cleanup. One ordered due-index page per owner partition; parent cascade removes <=16 items. */
export declare function purgeExpiredLabelConsolidations({ pool, clock }: {
    pool: Pool;
    clock?: KernelClock;
}, { partition, limit, after }: {
    partition: number;
    limit: number;
    after: string | null;
}): Promise<{
    examined: number;
    removed: number;
    next: string | null;
}>;
export {};
