import { type Release, type ReleaseViolation } from '@rezics/definitions';
import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { AccessCheck, AccountActor } from '../request/access.ts';
export declare const GLOBAL_CONTEXT = "00000000-0000-8000-8000-000000000000";
export declare class DefinitionInputError extends Error {
    readonly violations: ReleaseViolation[];
    constructor(violations: ReleaseViolation[]);
}
export declare class DefinitionAccessDeniedError extends Error {
}
export declare class DefinitionNotFoundError extends Error {
}
export declare class StaleEditorialHeadError extends Error {
}
export declare function freeze(value: unknown): void;
/** A cache hit reads the digest only. The cache stores validated, digest-checked bodies, and a release is immutable. */
export declare function readRelease(pool: Pool | CommandTransaction, digest: string, options?: {
    composed?: boolean;
}): Promise<Release | null>;
export declare function activeRelease(pool: Pool | CommandTransaction): Promise<{
    digest: string;
    head: number;
    release: Release;
} | null>;
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
