import type { Pool } from 'pg';
import type { KernelClock } from '../../clock.ts';
import type { RatingCapabilities } from '../contract/capabilities.ts';
import { createRatingIdentityRepairCommands } from '../identity-repair.ts';
import { type IdentityRepairRead } from '../identity-repair-read.ts';
import { admitIdentityRepairGeneration, continueIdentityRepairGeneration, runIdentityRepairGeneration } from '../identity-repair-run.ts';
import { type RatingIdentityProducer } from '../segment-identity-guard.ts';
export type NativeIdentityRepairHost = Readonly<{
    commands: ReturnType<typeof createRatingIdentityRepairCommands>;
    read: IdentityRepairRead;
    producer: RatingIdentityProducer;
    admit: typeof admitIdentityRepairGeneration;
    run: typeof runIdentityRepairGeneration;
    continue: typeof continueIdentityRepairGeneration;
}>;
/** Ordinary installed commands: the bound Semantic producer, never a test-injected mapping authority. */
export declare function createInstalledIdentityRepairCommands(config: {
    pool: Pool;
    clock?: KernelClock;
    capabilities?: RatingCapabilities;
}): {
    admit: (actor: import("../../request/access.ts").Actor, input: {
        workId: string;
        expectedGeneration: string | null;
    }, key: string) => Promise<import("../../command/command.ts").CommandOutcome<{
        status: 'pending';
        reason: string;
    } | {
        status: 'admitted';
        frame: import("../identity-work-frame.ts").IdentityWorkFrame;
    }>>;
    select: (actor: import("../../request/access.ts").Actor, ref: import("../identity-work-frame.ts").IdentityWorkRef, key: string) => Promise<import("../../command/command.ts").CommandOutcome<{
        status: 'pending';
        reason: string;
    } | {
        status: 'selected';
        page: import("../identity-work-frame.ts").IdentityRepairPage;
    }>>;
    commit: (actor: import("../../request/access.ts").Actor, input: import("../identity-work-frame.ts").IdentityWorkRef & {
        pageId: string;
        digest: string;
    }, key: string) => Promise<import("../../command/command.ts").CommandOutcome<{
        status: 'pending';
        reason: string;
    } | {
        status: 'committed';
        receipt: import("../identity-repair.ts").RatingRepairReceipt;
    }> | {
        value: {
            status: 'pending';
            reason: string;
        };
    }>;
    cancel: (actor: import("../../request/access.ts").Actor, ref: import("../identity-work-frame.ts").IdentityWorkRef, key: string) => Promise<import("../../command/command.ts").CommandOutcome<{
        status: 'pending';
        reason: string;
    } | {
        status: 'admitted';
        frame: import("../identity-work-frame.ts").IdentityWorkFrame;
    }>>;
};
/** Native Rating identity-repair host used by module application and HTTP composition. */
export declare function createNativeIdentityRepairHost(config: {
    pool: Pool;
    clock?: KernelClock;
    capabilities?: RatingCapabilities;
}): NativeIdentityRepairHost;
