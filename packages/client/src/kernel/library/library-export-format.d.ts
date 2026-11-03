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
export declare const exportSectionsV3: readonly [...typeof exportSectionsV2];
export declare const exportSectionsV4: readonly [
  ...typeof exportSectionsV3,
  'vndbUploads',
  'vndbEvidence',
  'anilistUploads',
  'anilistEvidence',
];
export type LibraryExportVersion = 1 | 2 | 3 | 4;
export type LibraryExportSectionV1 = (typeof exportSections)[number];
export type LibraryExportSectionV2 = (typeof exportSectionsV2)[number];
export type LibraryExportSectionV3 = (typeof exportSectionsV3)[number];
export type LibraryExportSectionV4 = (typeof exportSectionsV4)[number];
/** Archive recovery shares the installed V1 and V2 section vocabulary. */
export type LibraryExportSection = LibraryExportSectionV2;
export declare function sectionsForVersion(version: LibraryExportVersion):
  | typeof exportSections
  | typeof exportSectionsV2
  | typeof exportSectionsV3
  | typeof exportSectionsV4;

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
export type LibraryExportManifestV3 = {
  format: typeof LIBRARY_EXPORT_FORMAT;
  version: 3;
  coverage: 'private-library-owner-facts-v3';
  exportId: string;
  capturedAt: string;
  expiresAt: string;
  privacy: 'private';
  completeness: 'supported-native-facts';
  sections: LibraryExportSectionV3[];
  omissions: {
    readonly trash: string;
    readonly providerIdentifiers: string;
    readonly personalImportEvidence: string;
    readonly commerce: string;
    readonly publication: string;
    readonly reimport: string;
  };
};
export type LibraryExportManifestV4 = Omit<LibraryExportManifestV3, 'version' | 'coverage' | 'sections'> & {
  version: 4;
  coverage: 'private-library-owner-facts-v4';
  sections: LibraryExportSectionV4[];
};
export type LibraryExportManifest =
  | LibraryExportManifestV1
  | LibraryExportManifestV2
  | LibraryExportManifestV3
  | LibraryExportManifestV4;
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
export type LibraryExportFinalManifestV3 = LibraryExportManifestV3 & {
  fullExport: false;
  rows: number;
  recordBytes: number;
  sectionTotals: LibraryExportSectionTotals;
};
export type LibraryExportFinalManifestV4 = LibraryExportManifestV4 & {
  fullExport: false;
  rows: number;
  recordBytes: number;
  sectionTotals: Record<LibraryExportSectionV4, { rows: number; recordBytes: number }>;
};
export type LibraryExportFinalManifest =
  | LibraryExportFinalManifestV1
  | LibraryExportFinalManifestV2
  | LibraryExportFinalManifestV3
  | LibraryExportFinalManifestV4;
export type LibraryArchiveManifest = LibraryExportFinalManifestV1 | LibraryExportFinalManifestV2;

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
  format_version: 3;
}): LibraryExportManifestV3;
export declare function libraryExportManifest(capture: {
  export_id: string;
  created_at: string;
  expires_at: string;
  format_version: 4;
}): LibraryExportManifestV4;
export declare function libraryExportManifest(capture: {
  export_id: string;
  created_at: string;
  expires_at: string;
  format_version?: LibraryExportVersion;
}): LibraryExportManifest;
