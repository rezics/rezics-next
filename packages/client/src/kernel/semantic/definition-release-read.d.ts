import { type Extension } from '@rezics/definitions/extension';
import { type Release } from '@rezics/definitions';
import { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
/** A cache hit reads the digest only. The cache stores validated, digest-checked bodies, and a release is immutable. */
export declare function readRelease(pool: Pool | CommandTransaction, digest: string, options?: {
    composed?: boolean;
}): Promise<Release | null>;
export declare function activeRelease(pool: Pool | CommandTransaction): Promise<{
    digest: string;
    head: number;
    release: Release;
} | null>;
type Layer = {
    digest: string;
    release: Release;
};
type Db = Pool | CommandTransaction;
/** Compatibility cache probe. Current Context custody requires the asynchronous native read below. */
export declare function composedRelease(_digest: string): Release | null;
export declare function contextRoute(context: string): number | null;
/** Independently reread one published extension body; never the current head. */
export declare function readPublishedExtension(db: Db, context: string, digest: string): Promise<Extension | null>;
/** Current availability and head are point probes; the immutable body is read once per digest per process. */
export declare function activeExtension(db: Db, context: string): Promise<{
    digest: string;
    head: number;
    extension: Extension;
} | null>;
/** Retained definition meaning/birth evidence, never current Context read eligibility. */
export declare function storedActiveExtension(db: Db, route: number, context: string): Promise<{
    digest: string;
    head: number;
    extension: Extension;
} | null>;
/**
 * `base` as `context` sees it: Global's extension, then the Context's own. Without an extension the base comes back
 * unchanged, so a warm request pays each Context's current availability and extension head probes.
 */
export declare function layeredRelease(db: Db, base: Layer, context: string, persist?: boolean): Promise<Layer>;
/**
 * The active release with the terms `context` sees; Global's view is the default. A write passes `persist`, so the
 * composed digest it stores is registered; a read never writes.
 */
export declare function effectiveRelease(pool: Pool, context?: string, persist?: boolean, deadline?: number): Promise<{
    digest: string;
    head: number;
    release: Release;
} | null>;
/** The Context whose extension a statement on `property` would use, when the property is a Context term. */
export declare function propertyContext(property: string): string | null;
/**
 * The published release a digest builds on. A subject's own revisions record this one, so reading the subject in
 * another Context never picks up the relation types of the Context that last edited it.
 */
export declare function baseOf(digest: string): string;
/** Resolve a stored composed digest again, in a process that has not composed it yet. */
export declare function readComposedRelease(db: Db, digest: string): Promise<Release | null>;
export {};
