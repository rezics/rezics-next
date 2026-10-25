import type { Resource } from '../request/access.ts';
import type { ResourceCreationPort } from './parent-creation.ts';
export declare const MAX_CREATION_RESOURCES = 16;
export type ResourceCreationEntry = Readonly<{
    resource: Readonly<Resource>;
    type: string;
    creator: string;
    creation: ResourceCreationPort;
}>;
declare const resourceCreationManifest: unique symbol;
/** Opaque server declaration; JSON and structural copies carry no authority. */
export type ResourceCreationManifest = {
    readonly [resourceCreationManifest]: true;
};
/** Snapshot at most sixteen same-partition declarations without invoking their
 * validators or granting permission. Only declared metadata is retained; callers
 * cannot enumerate or serialize the private entries through the frozen token.
 * Catalogue resolution and actual new-INSERT proof belong to initialization.
 */
export declare function createResourceCreationManifest(entries: readonly ResourceCreationEntry[]): ResourceCreationManifest;
export declare class CreationManifestUnavailableError extends Error {
    constructor();
}
/** Internal Access lookup: a structural copy or inherited token has no entries. */
export declare function creationManifestEntries(manifest: ResourceCreationManifest): readonly ResourceCreationEntry[];
export {};
