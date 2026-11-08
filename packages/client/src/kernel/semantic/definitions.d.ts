import { type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { type CommandAuthorization } from '../command/command.ts';
import type { AccessCheck, AccountActor } from '../request/access.ts';
export { DefinitionInputError, DefinitionAccessDeniedError, DefinitionNotFoundError, StaleEditorialHeadError, } from './contract/definition-values.ts';
export { freeze } from './core/freeze.ts';
export { activeRelease, readRelease } from './definition-release-read.ts';
export { GLOBAL_CONTEXT } from './contract/global-context.ts';
export type WriteOptions = {
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    authorize: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
};
/** The command options of a definition write on `target`: Global's own partition unless a Context's extension is written. */
export declare function commandOptions(options: WriteOptions, kind: string, action: string, target?: {
    partition: number;
    resource: {
        route: number;
        id: string;
    };
}): {
    partition: number;
    deadline?: number;
    receipt: {
        actorAccountId: string;
        kind: string;
        key: string;
        digest: Uint8Array<ArrayBufferLike>;
    };
    basis: {
        actorAccountId: string;
        clientId: string;
        requestedBy: string | null;
    };
    authorization: CommandAuthorization;
    clock: (() => Date) | undefined;
};
export declare function publishRelease(pool: Pool, options: WriteOptions & {
    release: unknown;
}): Promise<{
    digest: string;
    created: boolean;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
export declare function activateRelease(pool: Pool, options: WriteOptions & {
    releaseDigest: string;
    expectedHead: number | null;
}): Promise<{
    digest: string;
    head: number;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
/** Trusted setup only: the first activation and its release commit together, without an actor. */
export declare function bootstrapRelease(pool: Pool, release: Release, clock?: () => Date): Promise<string>;
