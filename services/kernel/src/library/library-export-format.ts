/** Installed Library export vocabulary, shared by the producer and its inert decoder. */
export const LIBRARY_EXPORT_FORMAT = 'https://rezics.com/formats/library-export' as const;
export const LIBRARY_EXPORT_LIMITS = {
  records: 100_000,
  recordBytes: 32 * 1024 * 1024,
  maxRecordBytes: 65_536,
  pageBytes: 120_000,
  pageRows: 16,
} as const;
export const exportSections = [
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
] as const;
export const exportSectionsV2 = [...exportSections, 'annotations', 'provenance', 'journals'] as const;
export const exportSectionsV3 = [
  ...exportSectionsV2,
  'vndbUploads',
  'vndbEvidence',
  'anilistUploads',
  'anilistEvidence',
] as const;
export type LibraryExportVersion = 1 | 2 | 3;
export type LibraryExportSectionV3 = (typeof exportSectionsV3)[number];
export type LibraryExportSectionV1 = (typeof exportSections)[number];
export type LibraryExportSectionV2 = (typeof exportSectionsV2)[number];
/** The archive recovery consumer shares the installed V1 and V2 section vocabulary. */
export type LibraryExportSection = LibraryExportSectionV2;

export function sectionsForVersion(version: LibraryExportVersion) {
  return version === 1 ? exportSections : version === 2 ? exportSectionsV2 : exportSectionsV3;
}

type Capture = { export_id: string; created_at: string; expires_at: string };
type SectionTotals = Record<LibraryExportSectionV2, { rows: number; recordBytes: number }>;

const v1Omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport: 'unavailable; this format does not promise an installed re-import endpoint',
} as const;

const v2Omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers:
    'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport:
    'version 1 archive recovery plus reviewed version 2 annotations and journal dates; provenance remains unsupported',
} as const;

const v3Omissions = {
  ...v2Omissions,
  personalImportEvidence:
    'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded',
  reimport:
    'version 3 recovery unavailable to the installed V1/V2 archive consumer; evidence never authorizes execution',
} as const;

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

export type LibraryExportManifestV3 = Omit<
  LibraryExportManifestV2,
  'version' | 'coverage' | 'sections' | 'omissions'
> & {
  version: 3;
  coverage: 'private-library-owner-facts-v3';
  sections: [...typeof exportSectionsV3];
  omissions: typeof v3Omissions;
};
export type LibraryExportManifest = LibraryExportManifestV1 | LibraryExportManifestV2 | LibraryExportManifestV3;
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
  sectionTotals: Record<LibraryExportSectionV3, { rows: number; recordBytes: number }>;
};
export type LibraryExportFinalManifest =
  | LibraryExportFinalManifestV1
  | LibraryExportFinalManifestV2
  | LibraryExportFinalManifestV3;

export function libraryExportManifest(capture: Capture & { format_version?: 1 }): LibraryExportManifestV1;
export function libraryExportManifest(capture: Capture & { format_version: 2 }): LibraryExportManifestV2;
export function libraryExportManifest(capture: Capture & { format_version: 3 }): LibraryExportManifestV3;
export function libraryExportManifest(
  capture: Capture & { format_version?: LibraryExportVersion },
): LibraryExportManifest;

export function libraryExportManifest(
  capture: Capture & { format_version?: LibraryExportVersion },
): LibraryExportManifest {
  const common = {
    format: LIBRARY_EXPORT_FORMAT,
    exportId: capture.export_id,
    capturedAt: capture.created_at,
    expiresAt: capture.expires_at,
    privacy: 'private' as const,
    completeness: 'supported-native-facts' as const,
  };
  if (capture.format_version === 1 || capture.format_version === undefined)
    return {
      ...common,
      version: 1,
      sections: [...exportSections],
      omissions: v1Omissions,
    };
  if (capture.format_version === 3)
    return {
      ...common,
      version: 3,
      coverage: 'private-library-owner-facts-v3',
      sections: [...exportSectionsV3],
      omissions: v3Omissions,
    };
  return {
    ...common,
    version: 2,
    coverage: 'private-library-owner-facts-v2',
    sections: [...exportSectionsV2],
    omissions: v2Omissions,
  };
}

/** The native archive decoder recognizes both installed export vocabularies. */
export type LibraryArchiveManifest = LibraryExportFinalManifestV1 | LibraryExportFinalManifestV2;
