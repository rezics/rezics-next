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
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV1[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'unavailable; this format does not promise an installed re-import endpoint';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 2;
        coverage: 'private-library-owner-facts-v2';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV2[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 3;
        coverage: 'private-library-owner-facts-v3';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV3[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; version 3 manifests, including assessments, and provenance are unsupported';
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
    get(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV1[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'unavailable; this format does not promise an installed re-import endpoint';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 2;
        coverage: 'private-library-owner-facts-v2';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV2[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 3;
        coverage: 'private-library-owner-facts-v3';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV3[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; version 3 manifests, including assessments, and provenance are unsupported';
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
            format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
            version: 1;
            exportId: string;
            capturedAt: string;
            expiresAt: string;
            privacy: 'private';
            completeness: 'supported-native-facts';
            sections: import("./library-export-format.ts").LibraryExportSectionV1[];
            omissions: {
                readonly trash: 'excluded; current live facts and retained session history only';
                readonly providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers';
                readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded';
                readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
                readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
                readonly reimport: 'unavailable; this format does not promise an installed re-import endpoint';
            };
            fullExport: false;
            rows: number;
            recordBytes: number;
            sectionTotals?: {
                [k: string]: {
                    rows: number;
                    recordBytes: number;
                };
            };
        } | {
            format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
            version: 2;
            coverage: 'private-library-owner-facts-v2';
            exportId: string;
            capturedAt: string;
            expiresAt: string;
            privacy: 'private';
            completeness: 'supported-native-facts';
            sections: import("./library-export-format.ts").LibraryExportSectionV2[];
            omissions: {
                readonly trash: 'excluded; current live facts and retained session history only';
                readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
                readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
                readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
                readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
                readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported';
            };
            fullExport: false;
            rows: number;
            recordBytes: number;
            sectionTotals?: {
                [k: string]: {
                    rows: number;
                    recordBytes: number;
                };
            };
        } | {
            format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
            version: 3;
            coverage: 'private-library-owner-facts-v3';
            exportId: string;
            capturedAt: string;
            expiresAt: string;
            privacy: 'private';
            completeness: 'supported-native-facts';
            sections: import("./library-export-format.ts").LibraryExportSectionV3[];
            omissions: {
                readonly trash: 'excluded; current live facts and retained session history only';
                readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
                readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
                readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
                readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
                readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; version 3 manifests, including assessments, and provenance are unsupported';
            };
            fullExport: false;
            rows: number;
            recordBytes: number;
            sectionTotals?: {
                [k: string]: {
                    rows: number;
                    recordBytes: number;
                };
            };
        } | null;
    }>;
    cancel(actor: Actor, id: string, signal?: AbortSignal): Promise<{
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV1[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'unavailable; this format does not promise an installed re-import endpoint';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 2;
        coverage: 'private-library-owner-facts-v2';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV2[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported';
        };
        state: State;
        fullExport: false;
        first: string | null;
    } | {
        format: typeof import("./library-export-format.ts").LIBRARY_EXPORT_FORMAT;
        version: 3;
        coverage: 'private-library-owner-facts-v3';
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: import("./library-export-format.ts").LibraryExportSectionV3[];
        omissions: {
            readonly trash: 'excluded; current live facts and retained session history only';
            readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
            readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
            readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
            readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
            readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; version 3 manifests, including assessments, and provenance are unsupported';
        };
        state: State;
        fullExport: false;
        first: string | null;
    }>;
};
export {};
