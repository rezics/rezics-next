import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { exportSections, type LibraryExportFinalManifest } from './library-export-format.ts';
export type LibraryExportDependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    workClient: WorkClient | (() => Promise<WorkClient>);
    clock?: KernelClock;
};
type State = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export declare function exportAuthorityTypes(): string[];
/** No private artifact is retained: signed keysets replay only against the original unchanged source. */
export declare function createLibraryExport(deps: LibraryExportDependencies): {
    create(actor: Actor, requestKey: string, signal?: AbortSignal): Promise<{
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        coverage: 'private-library-owner-facts-v1';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: [...typeof exportSections];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution';
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
    get(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        coverage: 'private-library-owner-facts-v1';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: [...typeof exportSections];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution';
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
    page(actor: Actor, id: string, token: string, signal?: AbortSignal): Promise<{
        exportId: string;
        state: "cancelled" | "expired" | "limit" | "stale";
        records: never[];
        next: null;
        manifest: null;
    } | {
        exportId: string;
        state: "collecting" | "ready";
        records: import("./library-export-source.ts").ExportRecord[];
        next: string | null;
        manifest: LibraryExportFinalManifest | null;
    }>;
    cancel(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        coverage: 'private-library-owner-facts-v1';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: [...typeof exportSections];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution';
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
};
export {};
