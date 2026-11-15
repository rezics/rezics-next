/** Installed Library export vocabulary, shared by the producer and its inert decoder. */
export declare const LIBRARY_EXPORT_FORMAT: 'https://rezics.com/formats/library-export';
export declare const LIBRARY_EXPORT_LIMITS: {
    readonly records: 100000;
    readonly recordBytes: number;
    readonly maxRecordBytes: 65536;
    readonly pageBytes: 120000;
    readonly pageRows: 16;
};
export declare const exportSections: readonly ['entries', 'labels', 'assignments', 'sessions', 'holdings', 'collections', 'collectionPins', 'bangumiUploads', 'bangumiEvidence', 'malImports', 'units', 'history', 'occurrences', 'malEvidence', 'annotations', 'provenance', 'journals', 'vndbUploads', 'vndbEvidence', 'anilistUploads', 'anilistEvidence', 'hostedReading'];
export type LibraryExportSection = (typeof exportSections)[number];
type Capture = {
    export_id: string;
    created_at: string;
    expires_at: string;
};
declare const omissions: {
    readonly trash: 'excluded; current live facts and retained session history only';
    readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
    readonly personalImportEvidence: 'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded';
    readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
    readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
    readonly reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution';
};
export type LibraryExportManifest = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    version: 1;
    coverage: 'private-library-owner-facts-v1';
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: [...typeof exportSections];
    omissions: typeof omissions;
};
export type LibraryExportFinalManifest = LibraryExportManifest & {
    fullExport: false;
    rows: number;
    recordBytes: number;
    sectionTotals: Record<LibraryExportSection, {
        rows: number;
        recordBytes: number;
    }>;
};
export declare function libraryExportManifest(capture: Capture): LibraryExportManifest;
export type LibraryArchiveManifest = LibraryExportFinalManifest;
export {};
