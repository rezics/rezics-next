import type { Actor } from '../request/access.ts';
import { createRatingIdentityRepairCommands, type RatingRepairReceipt } from './identity-repair.ts';
import { type IdentityRepairPage, type IdentityWorkRef } from './identity-work-frame.ts';
export declare const IDENTITY_REPAIR_MAX_PAGES = 16;
type Commands = ReturnType<typeof createRatingIdentityRepairCommands>;
type Pending = Readonly<{
    status: 'pending';
    reason: string;
}>;
export type IdentityRepairPageStep = Readonly<{
    status: 'committed';
    page: IdentityRepairPage;
    receipt: RatingRepairReceipt;
}> | Pending;
export type IdentityRepairGenerationResult = Readonly<{
    status: 'complete';
    ref: IdentityWorkRef;
    receipts: readonly RatingRepairReceipt[];
    pages: number;
}> | Readonly<{
    status: 'pending';
    reason: string;
    ref: IdentityWorkRef | null;
    receipts: readonly RatingRepairReceipt[];
    pages: number;
}>;
/** One admitted generation: select and commit each durable page, including the empty terminal page. */
export declare function runIdentityRepairGeneration(commands: Commands, actor: Actor, ref: IdentityWorkRef, nextKey: () => string, pageLimit?: number): Promise<IdentityRepairGenerationResult>;
/** Admit a generation and run its pages. Replacement must match the expected generation. */
export declare function admitIdentityRepairGeneration(commands: Commands, actor: Actor, input: Readonly<{
    workId: string;
    expectedGeneration: string | null;
}>, nextKey: () => string, pageLimit?: number): Promise<IdentityRepairGenerationResult>;
/** A later identity change or vote beyond the captured upper key starts a new generation. */
export declare function continueIdentityRepairGeneration(commands: Commands, actor: Actor, previous: IdentityWorkRef, nextKey: () => string, pageLimit?: number): Promise<IdentityRepairGenerationResult>;
export declare function identityRepairPageBinding(page: IdentityRepairPage): Readonly<{
    workId: string;
    generation: string;
    pageId: string;
    digest: string;
}>;
export {};
