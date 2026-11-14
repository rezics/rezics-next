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
  'annotations',
  'provenance',
  'journals',
  'vndbUploads',
  'vndbEvidence',
  'anilistUploads',
  'anilistEvidence',
] as const;
export type LibraryExportSection = (typeof exportSections)[number];
type Capture = { export_id: string; created_at: string; expires_at: string };
const omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers:
    'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution',
} as const;
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
  sectionTotals: Record<LibraryExportSection, { rows: number; recordBytes: number }>;
};
export function libraryExportManifest(capture: Capture): LibraryExportManifest {
  return {
    format: LIBRARY_EXPORT_FORMAT,
    version: 1,
    coverage: 'private-library-owner-facts-v1',
    exportId: capture.export_id,
    capturedAt: capture.created_at,
    expiresAt: capture.expires_at,
    privacy: 'private',
    completeness: 'supported-native-facts',
    sections: [...exportSections],
    omissions,
  };
}
export type LibraryArchiveManifest = LibraryExportFinalManifest;
