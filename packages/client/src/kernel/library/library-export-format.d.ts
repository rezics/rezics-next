/** Installed v1 archive vocabulary, shared by the producer and its inert decoder. */
export declare const LIBRARY_EXPORT_FORMAT: 'https://rezics.com/formats/library-export';
export declare const LIBRARY_EXPORT_LIMITS: {
    readonly records: 100000;
    readonly recordBytes: number;
    readonly pageBytes: 120000;
};
export declare const exportSections: readonly ['entries', 'labels', 'assignments', 'sessions', 'holdings', 'collections', 'collectionPins', 'bangumiUploads', 'bangumiEvidence', 'malImports', 'units', 'history', 'occurrences', 'malEvidence'];
export type LibraryExportSection = (typeof exportSections)[number];
export declare function libraryExportManifest(capture: {
    export_id: string;
    created_at: string;
    expires_at: string;
}): {
    format: "https://rezics.com/formats/library-export";
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
};
export type LibraryArchiveManifest = ReturnType<typeof libraryExportManifest> & {
    fullExport: false;
    rows: number;
    recordBytes: number;
};
