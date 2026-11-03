/** Installed v1 archive vocabulary, shared by the producer and its inert decoder. */
export const LIBRARY_EXPORT_FORMAT = 'https://rezics.com/formats/library-export' as const;
export const LIBRARY_EXPORT_LIMITS = { records: 100_000, recordBytes: 32 * 1024 * 1024, pageBytes: 120_000 } as const;
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
export type LibraryExportSection = (typeof exportSections)[number];

export function libraryExportManifest(capture: { export_id: string; created_at: string; expires_at: string }) {
  return {
    format: LIBRARY_EXPORT_FORMAT,
    version: 1 as const,
    exportId: capture.export_id,
    capturedAt: capture.created_at,
    expiresAt: capture.expires_at,
    privacy: 'private' as const,
    completeness: 'supported-native-facts' as const,
    sections: [...exportSections],
    omissions: {
      trash: 'excluded; current live facts and retained session history only',
      providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers',
      personalImportEvidence:
        'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded',
      commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
      publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
      reimport: 'unavailable; this format does not promise an installed re-import endpoint',
    },
  };
}

export type LibraryArchiveManifest = ReturnType<typeof libraryExportManifest> & {
  fullExport: false;
  rows: number;
  recordBytes: number;
};
