import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
export type LibraryExportDependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    workClient: WorkClient | (() => Promise<WorkClient>);
    clock?: KernelClock;
};
type State = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export declare const exportAuthorityTypes: string[];
/** No private artifact is retained: signed keysets replay only against the original unchanged source. */
export declare function createLibraryExport(deps: LibraryExportDependencies): {
    create(actor: Actor, requestKey: string, signal?: AbortSignal): Promise<{
        format: 'https://rezics.com/formats/library-export';
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: ("assignments" | "bangumiEvidence" | "bangumiUploads" | "collectionPins" | "collections" | "entries" | "history" | "holdings" | "labels" | "malEvidence" | "malImports" | "occurrences" | "sessions" | "units")[];
        omissions: {
            trash: string;
            providerIdentifiers: string;
            personalImportEvidence: string;
            commerce: string;
            publication: string;
            reimport: string;
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
    get(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: 'https://rezics.com/formats/library-export';
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: ("assignments" | "bangumiEvidence" | "bangumiUploads" | "collectionPins" | "collections" | "entries" | "history" | "holdings" | "labels" | "malEvidence" | "malImports" | "occurrences" | "sessions" | "units")[];
        omissions: {
            trash: string;
            providerIdentifiers: string;
            personalImportEvidence: string;
            commerce: string;
            publication: string;
            reimport: string;
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
        manifest: {
            format: 'https://rezics.com/formats/library-export';
            version: 1;
            exportId: string;
            capturedAt: string;
            expiresAt: string;
            privacy: 'private';
            completeness: 'supported-native-facts';
            sections: ("assignments" | "bangumiEvidence" | "bangumiUploads" | "collectionPins" | "collections" | "entries" | "history" | "holdings" | "labels" | "malEvidence" | "malImports" | "occurrences" | "sessions" | "units")[];
            omissions: {
                trash: string;
                providerIdentifiers: string;
                personalImportEvidence: string;
                commerce: string;
                publication: string;
                reimport: string;
            };
            fullExport: false;
            rows: number;
            recordBytes: number;
        } | null;
    }>;
    cancel(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: 'https://rezics.com/formats/library-export';
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: ("assignments" | "bangumiEvidence" | "bangumiUploads" | "collectionPins" | "collections" | "entries" | "history" | "holdings" | "labels" | "malEvidence" | "malImports" | "occurrences" | "sessions" | "units")[];
        omissions: {
            trash: string;
            providerIdentifiers: string;
            personalImportEvidence: string;
            commerce: string;
            publication: string;
            reimport: string;
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
};
export {};
