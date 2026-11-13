import type { HostedChapterTarget } from './hosted-chapters-model.ts';
export declare const HOSTED_MIGRATION_INPUT_PAGE_MAX = 100;
export declare const HOSTED_MIGRATION_INPUT_RETENTION_MS: number;
export type HostedMigrationFrontier = Readonly<{
    segment: 'base';
    afterOrdinal: number;
}> | Readonly<{
    segment: 'prefix';
    afterOffset: string;
}> | Readonly<{
    segment: 'complete';
}>;
export type HostedMigrationSourceIdentity = Readonly<{
    catalogueId: string;
    revisionId: string;
    kind: 'snapshot' | 'prefix';
    baseRevisionId: string;
    basePlacementCount: string;
    baseRootCount: string;
    highWater: string;
    expectedPlacementCount: string;
}>;
export type HostedMigrationSourceAddress = Readonly<{
    segment: 'base';
    revisionId: string;
    ordinal: number;
}> | Readonly<{
    segment: 'prefix';
    streamId: string;
    offset: string;
}>;
type HostedMigrationEntryBase = Readonly<{
    address: HostedMigrationSourceAddress;
    occurrenceId: string;
    parentId: string | null;
    position: number;
    ordinal: number;
}>;
export type HostedMigrationEntry = HostedMigrationEntryBase & (Readonly<{
    availability: 'unavailable';
    kind: 'part';
}> | Readonly<{
    availability: 'available';
    kind: 'part';
    title: string;
}> | Readonly<{
    availability: 'unavailable';
    kind: 'chapter';
}> | Readonly<{
    availability: 'available';
    kind: 'chapter';
    title: string;
    target: HostedChapterTarget;
}>);
export type HostedMigrationInputStatus = 'open' | 'complete' | 'incomplete' | 'consumed' | 'cancelled' | 'expired' | 'source_erased';
export type HostedMigrationInputCapture = Readonly<{
    catalogueId: string;
    expectedRevisionId: string;
}>;
export type HostedMigrationInputPage = Readonly<{
    frontier: HostedMigrationFrontier;
    limit?: number;
}>;
export type HostedMigrationInputRelease = Readonly<{
    disposition: 'consumed' | 'cancelled' | 'expired';
}>;
export type HostedMigrationInputCaptureResult = Readonly<{
    inputId: string;
    source: HostedMigrationSourceIdentity;
    frontier: HostedMigrationFrontier;
    expiresAt: string;
}>;
export type HostedMigrationInputPageResult = Readonly<{
    inputId: string;
    status: HostedMigrationInputStatus;
    source: HostedMigrationSourceIdentity;
    sourceCurrent: boolean;
    frontier: HostedMigrationFrontier;
    coverage: Readonly<{
        visited: string;
        expected: string;
        complete: boolean;
    }>;
    items: readonly HostedMigrationEntry[];
}>;
export type HostedMigrationInputReleaseResult = Readonly<{
    inputId: string;
    status: HostedMigrationInputStatus;
    source: HostedMigrationSourceIdentity;
    coverage: Readonly<{
        visited: string;
        expected: string;
        complete: boolean;
    }>;
}>;
export declare class InvalidHostedMigrationInputError extends Error {
    constructor(message?: string);
}
export declare class HostedMigrationInputUnavailableError extends Error {
    constructor();
}
export declare class HostedMigrationInputIncompleteError extends Error {
    constructor();
}
export {};
