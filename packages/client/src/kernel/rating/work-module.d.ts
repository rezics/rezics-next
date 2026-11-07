import { type RatingCounter } from '../access/rating-counter.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import type { Effect } from '../events/effects.ts';
import type { RatingCapabilities } from './contract/capabilities.ts';
export { createRatingIdentityRepairCommands } from './identity-repair.ts';
export { createIdentityRepairRead } from './identity-repair-read.ts';
export { admitIdentityRepairGeneration, continueIdentityRepairGeneration, runIdentityRepairGeneration, } from './identity-repair-run.ts';
export { createInstalledIdentityRepairCommands, createNativeIdentityRepairHost } from './adapters/identity-repair.ts';
export declare const RATING_COUNTER_SECRET_ENV = "KERNEL_RATING_COUNTER_SECRET";
type Runtime = Readonly<{
    context: WorkContext;
    counter: RatingCounter;
    capabilities: RatingCapabilities;
}>;
/** Descriptions and factories are collected before the work host starts any service. */
export declare function ratingWorkDeclarations(): {
    effects: readonly Readonly<{
        name: string;
        requiresClient?: boolean;
        create(runtime: Runtime): Effect;
    }>[];
    workflows: {
        name: string;
        register: ({ context, counter, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>) => void;
    }[];
    services: ({
        name: string;
        start({ context, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>): Promise<{
            stop(): Promise<void>;
        }>;
    } | {
        name: string;
        start: ({ context, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>) => {
            pause(): Promise<void>;
            resume(): void;
            stop(): Promise<void>;
        };
    })[];
};
/** Pools, clients and process shutdown belong to the host. It starts and reverses our declared services. */
export declare function createRatingWorkModule(ratingCounter?: RatingCounter, capabilities?: RatingCapabilities, declarations?: {
    effects: readonly Readonly<{
        name: string;
        requiresClient?: boolean;
        create(runtime: Runtime): Effect;
    }>[];
    workflows: {
        name: string;
        register: ({ context, counter, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>) => void;
    }[];
    services: ({
        name: string;
        start({ context, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>): Promise<{
            stop(): Promise<void>;
        }>;
    } | {
        name: string;
        start: ({ context, capabilities }: Readonly<{
            context: WorkContext;
            counter: RatingCounter;
            capabilities: RatingCapabilities;
        }>) => {
            pause(): Promise<void>;
            resume(): void;
            stop(): Promise<void>;
        };
    })[];
}): WorkModule;
/** Compatibility registration is inert until its host supplies the runtime. */
export declare const ratingWorkModule: WorkModule;
