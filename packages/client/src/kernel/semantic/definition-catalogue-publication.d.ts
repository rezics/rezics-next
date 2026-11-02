import type { Pool } from 'pg';
import { type CatalogueArtifactReader, type KindCataloguePin } from '@rezics/definitions';
import { type CommandTransaction } from '../command/command.ts';
import { type WriteOptions } from './definitions.ts';
export type CatalogueArtifactKind = 'root' | 'node' | 'release' | 'declaration';
export type CatalogueBuildStatus = {
    pin: KindCataloguePin;
    state: 'building' | 'incomplete' | 'refused' | 'ready';
    phase: 'node' | 'release' | 'declaration';
    steps: string;
    nodes: string;
    releases: string;
    declarations: string;
    indexed_rows: string;
    examined_bytes: string;
    missing_digest: string | null;
    error: string | null;
};
export declare const catalogueKey: (value: string) => string;
/** UTF-16 BE preserves the package's exact JS string ordering, including supplementary characters. */
export declare function catalogueSort(value: string): Buffer;
export declare function catalogueArtifactReader(tx: CommandTransaction): CatalogueArtifactReader;
/** One bounded addressed artifact. Identity is computed here; submitted digests never certify bytes. */
export declare function publishCatalogueArtifact(pool: Pool, options: WriteOptions & {
    kind: CatalogueArtifactKind;
    artifact: unknown;
}): Promise<{
    digest: string;
    created: boolean;
} & {
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
export declare function startCatalogueBuild(pool: Pool, options: WriteOptions & {
    pin: KindCataloguePin;
}): Promise<CatalogueBuildStatus & {
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
export declare function readCatalogueBuild(tx: CommandTransaction, pin: KindCataloguePin): Promise<CatalogueBuildStatus | null>;
/** Mechanical continuation of the immutable, already authorized input, never a restored publisher Actor. */
export declare function advanceCatalogueBuild(tx: CommandTransaction, pin: KindCataloguePin): Promise<CatalogueBuildStatus>;
export declare function stepCatalogueBuild(pool: Pool, options: WriteOptions & {
    pin: KindCataloguePin;
}): Promise<CatalogueBuildStatus & {
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
export declare function runCatalogueBuildStep(pool: Pool, pin: KindCataloguePin, clock: () => Date, position?: string): Promise<CatalogueBuildStatus>;
/** A bounded mechanical step consumes only the durable authorized activation intent.
 * It cannot finish publication: that requires a new actual definitions:activate command.
 */
export declare function runCatalogueActivationStep(pool: Pool, pin: KindCataloguePin, activationId: string, clock: () => Date, position?: string): Promise<Readonly<{
    activationId: string;
    state: 'ready' | 'closing' | 'invalidating' | 'active';
    pending: boolean;
}>>;
export declare function activateCatalogue(pool: Pool, options: WriteOptions & {
    pin: KindCataloguePin;
    expectedHead: number | null;
}): Promise<{
    pin: Readonly<{
        format: typeof import("@rezics/definitions").CATALOGUE_FORMAT;
        rootDigest: string;
        kindSpec: typeof import("@rezics/definitions").KIND_FORMAT;
        reduction: typeof import("@rezics/definitions").KIND_REDUCTION;
    }>;
    head: number;
} & {
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    replayed: boolean;
}>;
