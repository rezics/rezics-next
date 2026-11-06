import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Actor } from '../request/access.ts';
import { type IdentityRepairPage, type IdentityWorkFrame, type IdentityWorkRef, type IdentityVoteKey } from './identity-work-frame.ts';
import { type RatingIdentityProducer } from './segment-identity-guard.ts';
export type RatingRepairReceipt = IdentityWorkRef & {
    pageId: string;
    digest: string;
    transactionId: string;
    checkpoint: IdentityVoteKey | null;
    terminal: boolean;
    mode: IdentityRepairPage['mode'];
    obligationId: string | null;
    mappingDigest: string | null;
};
type Pending = {
    status: 'pending';
    reason: string;
};
type FrameResult = {
    status: 'admitted';
    frame: IdentityWorkFrame;
} | Pending;
type SelectionResult = {
    status: 'selected';
    page: IdentityRepairPage;
} | Pending;
type CommitResult = {
    status: 'committed';
    receipt: RatingRepairReceipt;
} | Pending;
/** One explicit bounded step per call. The controller owns scheduling, reconciliation and replacement.
 * The producer is trusted service configuration, never input from a caller or a released observation.
 */
export declare function createRatingIdentityRepairCommands(config: {
    pool: Pool;
    clock?: KernelClock;
    capabilities?: RatingCapabilities;
    producer?: RatingIdentityProducer;
}): {
    admit: (actor: Actor, input: {
        workId: string;
        expectedGeneration: string | null;
    }, key: string) => Promise<import("../command/command.ts").CommandOutcome<FrameResult>>;
    select: (actor: Actor, ref: IdentityWorkRef, key: string) => Promise<import("../command/command.ts").CommandOutcome<SelectionResult>>;
    commit: (actor: Actor, input: IdentityWorkRef & {
        pageId: string;
        digest: string;
    }, key: string) => Promise<import("../command/command.ts").CommandOutcome<CommitResult> | {
        value: Pending;
    }>;
    cancel: (actor: Actor, ref: IdentityWorkRef, key: string) => Promise<import("../command/command.ts").CommandOutcome<FrameResult>>;
};
export {};
