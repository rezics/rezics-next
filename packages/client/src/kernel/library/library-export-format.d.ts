export declare const LIBRARY_EXPORT_FORMAT: 'https://rezics.com/formats/library-export';
export declare const LIBRARY_EXPORT_LIMITS: {
  readonly records: 100000;
  readonly recordBytes: number;
  readonly maxRecordBytes: number;
  readonly pageBytes: 120000;
  readonly pageRows: 16;
};
export declare const exportSections: readonly [
  'entries',
  'labels',
  'assignments',
  'sessions',
  'holdings',
  'collections',
  'collectionPins',
  'bangumiUploads',
  'bangumiEvidence',
  'malImports',
  'units',
  'history',
  'occurrences',
  'malEvidence',
];
export declare const exportSectionsV2: readonly [
  ...typeof exportSections,
  'annotations',
  'provenance',
  'journals',
];
export type LibraryExportVersion = 1 | 2;
export type LibraryExportSectionV1 = (typeof exportSections)[number];
export type LibraryExportSectionV2 = (typeof exportSectionsV2)[number];
/** Archive recovery intentionally accepts version 1 only. */
export type LibraryExportSection = LibraryExportSectionV1;
export declare function sectionsForVersion(version: LibraryExportVersion): typeof exportSections | typeof exportSectionsV2;

export type LibraryExportManifestV1 = {
  format: typeof LIBRARY_EXPORT_FORMAT;
  version: 1;
  exportId: string;
  capturedAt: string;
  expiresAt: string;
  privacy: 'private';
  completeness: 'supported-native-facts';
  sections: LibraryExportSectionV1[];
  omissions: {
    readonly trash: string;
    readonly providerIdentifiers: string;
    readonly personalImportEvidence: string;
    readonly commerce: string;
    readonly publication: string;
    readonly reimport: string;
  };
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
  sections: LibraryExportSectionV2[];
  omissions: {
    readonly trash: string;
    readonly providerIdentifiers: string;
    readonly personalImportEvidence: string;
    readonly commerce: string;
    readonly publication: string;
    readonly reimport: string;
  };
};
export type LibraryExportManifest = LibraryExportManifestV1 | LibraryExportManifestV2;
export type LibraryExportFinalManifestV1 = LibraryExportManifestV1 & {
  fullExport: false;
  rows: number;
  recordBytes: number;
};
export type LibraryExportSectionTotals = Record<LibraryExportSectionV2, { rows: number; recordBytes: number }>;
export type LibraryExportFinalManifestV2 = LibraryExportManifestV2 & {
  fullExport: false;
  rows: number;
  recordBytes: number;
  sectionTotals: LibraryExportSectionTotals;
};
export type LibraryExportFinalManifest = LibraryExportFinalManifestV1 | LibraryExportFinalManifestV2;
export type LibraryArchiveManifest = LibraryExportFinalManifestV1;

export declare function libraryExportManifest(capture: {
  export_id: string;
  created_at: string;
  expires_at: string;
  format_version?: 1;
}): LibraryExportManifestV1;
export declare function libraryExportManifest(capture: {
  export_id: string;
  created_at: string;
  expires_at: string;
  format_version: 2;
}): LibraryExportManifestV2;
export declare function libraryExportManifest(capture: {
  export_id: string;
  created_at: string;
  expires_at: string;
  format_version: LibraryExportVersion;
}): LibraryExportManifest;
