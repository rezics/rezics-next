import { type MediaImportRequest, type MediaImportStatus } from '@rezics/definitions/media-import';
import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
/** Trusted host configuration, never accepted as caller JSON. Runtime must
 * revalidate exact HTTPS hosts on every redirect and enforce fetch bounds.
 */
export type MediaImportFetchConfig = Readonly<{
    allowedHosts: readonly string[];
}>;
export interface MediaImportDependencies {
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock: () => Date;
    fetchConfig: MediaImportFetchConfig;
}
export type MediaImportContext = Readonly<{
    deadline: number;
    idempotencyKey: string;
    requestId: string;
}>;
export type MediaCropTuple = [left: number, top: number, width: number, height: number];
export declare function mediaCropTuple(fragment?: string): MediaCropTuple | null;
export declare function mediaCropFragment(crop: readonly (number | null)[] | null): string | undefined;
export declare class MediaImportConflictError extends Error {
    constructor();
}
/** Reserve in the command transaction. Cover claims remain in their caller's
 * command transaction; this port grants no publication permission.
 */
export declare function importMediaFromUrl(deps: MediaImportDependencies, actor: Actor, input: MediaImportRequest, context: MediaImportContext): Promise<CommandOutcome<{
    mediaId: string;
}>>;
/** GET media/{id}:importStatus must use media:read_reservation, the current
 * uploader formula and denials, with no anonymous fallback. Hidden/unknown
 * objects have the same null result. This port exposes no HTTP handler.
 */
export declare function readMediaImportStatus(deps: MediaImportDependencies, actor: Actor, id: string, context: Readonly<{
    deadline: number;
}>): Promise<MediaImportStatus | null>;
