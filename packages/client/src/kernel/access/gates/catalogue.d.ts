import { type AccessWorkAccounting } from '../work.ts';
import type { Pool } from 'pg';
import { type CommandAuthorization, type AuthoritativeTime, type CommandOutcome } from '../../command/command.ts';
import type { AccountActor, AccessContext, Resource } from '../../request/access.ts';
export declare const GLOBAL_CONTEXT: Resource;
export declare function isExposureGroup(value: string): boolean;
export type ExposureState = {
    open: boolean;
    at: string;
};
/** The exposure read is a single temporal primary-key probe at the kernel's request T. */
export declare function readExposure(pool: Pool, group: string, at: Date | AuthoritativeTime, deadline: number, work?: AccessWorkAccounting, time?: AuthoritativeTime): Promise<ExposureState>;
export type ExposureMutationContext = AccessContext & {
    actor: AccountActor;
};
export type ExposureMutation = {
    group: string;
    key: string;
    authorization: CommandAuthorization;
};
export type ExposureValue = {
    group: string;
    open: boolean;
    changed: boolean;
};
/** Exposure openings share the Global Context partition and its native receipt fence. */
export declare function createExposureCommands(config: {
    pool: Pool;
    clock: () => Date;
}): {
    open: (context: ExposureMutationContext, input: ExposureMutation) => Promise<CommandOutcome<ExposureValue>>;
    close: (context: ExposureMutationContext, input: ExposureMutation) => Promise<CommandOutcome<ExposureValue>>;
};
