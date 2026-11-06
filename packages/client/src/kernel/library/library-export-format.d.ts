/** Installed Library export vocabulary, shared by the producer and its inert decoder. */
export declare const LIBRARY_EXPORT_FORMAT: 'https://rezics.com/formats/library-export';
export declare const LIBRARY_EXPORT_LIMITS: {
    readonly records: 100000;
    readonly recordBytes: number;
    readonly maxRecordBytes: 65536;
    readonly pageBytes: 120000;
    readonly pageRows: 16;
};
export declare const exportSections: readonly ['entries', 'labels', 'assignments', 'sessions', 'holdings', 'collections', 'collectionPins', 'bangumiUploads', 'bangumiEvidence', 'malImports', 'units', 'history', 'occurrences', 'malEvidence'];
export declare const exportSectionsV2: readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence", "annotations", "provenance", "journals"];
export declare const exportSectionsV3: readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence", "annotations", "provenance", "journals"];
export declare const exportSectionsV4: readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence", "annotations", "provenance", "journals", "vndbUploads", "vndbEvidence", "anilistUploads", "anilistEvidence"];
export type LibraryExportVersion = 1 | 2 | 3 | 4;
export type LibraryExportSectionV1 = (typeof exportSections)[number];
export type LibraryExportSectionV2 = (typeof exportSectionsV2)[number];
export type LibraryExportSectionV3 = (typeof exportSectionsV3)[number];
export type LibraryExportSectionV4 = (typeof exportSectionsV4)[number];
/** All installed sections can be retained as evidence; recovery support is decided per section. */
export type LibraryExportSection = LibraryExportSectionV4;
export declare function sectionsForVersion(version: LibraryExportVersion): readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence"] | readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence", "annotations", "provenance", "journals"] | readonly ["entries", "labels", "assignments", "sessions", "holdings", "collections", "collectionPins", "bangumiUploads", "bangumiEvidence", "malImports", "units", "history", "occurrences", "malEvidence", "annotations", "provenance", "journals", "vndbUploads", "vndbEvidence", "anilistUploads", "anilistEvidence"];
type Capture = {
    export_id: string;
    created_at: string;
    expires_at: string;
};
type SectionTotals = Record<LibraryExportSectionV2, {
    rows: number;
    recordBytes: number;
}>;
declare const v1Omissions: {
    readonly trash: 'excluded; current live facts and retained session history only';
    readonly providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers';
    readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded';
    readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
    readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
    readonly reimport: 'unavailable; this format does not promise an installed re-import endpoint';
};
declare const v2Omissions: {
    readonly trash: 'excluded; current live facts and retained session history only';
    readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
    readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
    readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
    readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
    readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection; provenance remains unsupported';
};
declare const v3Omissions: {
    readonly trash: 'excluded; current live facts and retained session history only';
    readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
    readonly personalImportEvidence: 'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded';
    readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
    readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
    readonly reimport: 'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection and supported version 3 occurrence assessments; provenance remains unsupported';
};
declare const v4Omissions: {
    readonly trash: 'excluded; current live facts and retained session history only';
    readonly providerIdentifiers: 'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers';
    readonly commerce: 'excluded; orders and financial evidence use Commerce retention/export policy';
    readonly publication: 'excluded; stored rules only, no dynamic evaluation or working publication output';
    readonly personalImportEvidence: 'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded';
    readonly reimport: 'version 4 recovery unavailable to the installed V1/V2/V3 archive consumer; evidence never authorizes execution';
};
export type LibraryExportManifestV1 = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    version: 1;
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: [...typeof exportSections];
    omissions: typeof v1Omissions;
};
export type LibraryExportManifestV2 = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    version: 2;
    coverage: 'private-library-owner-facts-v2';
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: [...typeof exportSectionsV2];
    omissions: typeof v2Omissions;
};
export type LibraryExportManifestV3 = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    version: 3;
    coverage: 'private-library-owner-facts-v3';
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: [...typeof exportSectionsV3];
    omissions: typeof v3Omissions;
};
export type LibraryExportManifestV4 = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    version: 4;
    coverage: 'private-library-owner-facts-v4';
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: [...typeof exportSectionsV4];
    omissions: typeof v4Omissions;
};
export type LibraryExportManifest = LibraryExportManifestV1 | LibraryExportManifestV2 | LibraryExportManifestV3 | LibraryExportManifestV4;
export type LibraryExportFinalManifestV1 = LibraryExportManifestV1 & {
    fullExport: false;
    rows: number;
    recordBytes: number;
};
export type LibraryExportFinalManifestV2 = LibraryExportManifestV2 & {
    fullExport: false;
    rows: number;
    recordBytes: number;
    sectionTotals: SectionTotals;
};
export type LibraryExportFinalManifestV3 = LibraryExportManifestV3 & {
    fullExport: false;
    rows: number;
    recordBytes: number;
    sectionTotals: Record<LibraryExportSectionV3, {
        rows: number;
        recordBytes: number;
    }>;
};
export type LibraryExportFinalManifestV4 = LibraryExportManifestV4 & {
    fullExport: false;
    rows: number;
    recordBytes: number;
    sectionTotals: Record<LibraryExportSectionV4, {
        rows: number;
        recordBytes: number;
    }>;
};
export type LibraryExportFinalManifest = LibraryExportFinalManifestV1 | LibraryExportFinalManifestV2 | LibraryExportFinalManifestV3 | LibraryExportFinalManifestV4;
export declare function libraryExportManifest(capture: Capture & {
    format_version?: 1;
}): LibraryExportManifestV1;
export declare function libraryExportManifest(capture: Capture & {
    format_version: 2;
}): LibraryExportManifestV2;
export declare function libraryExportManifest(capture: Capture & {
    format_version: 3;
}): LibraryExportManifestV3;
export declare function libraryExportManifest(capture: Capture & {
    format_version: 4;
}): LibraryExportManifestV4;
export declare function libraryExportManifest(capture: Capture & {
    format_version?: LibraryExportVersion;
}): LibraryExportManifest;
/** Recovery validates the original completed manifest before selecting supported facts. */
export type LibraryArchiveManifest = LibraryExportFinalManifestV1 | LibraryExportFinalManifestV2 | LibraryExportFinalManifestV3 | LibraryExportFinalManifestV4;
export {};
