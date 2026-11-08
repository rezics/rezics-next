/** Native Source capture adapter. Uses the existing Collection Source factory on the live pool. */
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import type { SourceCaptureCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
export declare function createNativeSourceCaptureAdapter(dependencies: {
    pool: Pool;
    access: Access;
    ordinaryPage?: boolean;
}): SourceCaptureCapability;
export type { LibraryActor };
