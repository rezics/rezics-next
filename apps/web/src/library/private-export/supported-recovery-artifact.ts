import {
  EXPORT_FORMAT,
  EXPORT_SECTIONS_V1,
  EXPORT_SECTIONS_V3,
  EXPORT_V3_COVERAGE,
  encodedRecordBytes,
  type ExportRecord,
  type ExportSection,
  type ExportVersion,
} from './contract';

export type RecoveryArchiveBranch = 'collections' | 'entries' | 'progress';

const v1Omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers: 'stored personal import evidence only; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi and unexpired MAL row evidence; raw XML, credentials and internal review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport: 'unavailable; this format does not promise an installed re-import endpoint',
} as const;

const v3Omissions = {
  trash: 'excluded; current live facts and retained session history only',
  providerIdentifiers:
    'only explicitly reviewed owner observations and retained import evidence; no shared custody scan or inferred identifiers',
  personalImportEvidence:
    'retained Bangumi and unexpired MAL row evidence; raw uploads, credentials and internal review/apply capabilities excluded',
  commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
  publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
  reimport:
    'version 1 archive recovery plus reviewed version 2 annotations and journal dates/reflection and supported version 3 occurrence assessments; provenance remains unsupported',
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionOf(value: unknown): ExportVersion | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

/** Collection recovery admits V1/V2; Entry and progress recovery admit V1/V2/V3. New captures are V4. */
export function supportedRecoveryVersion(branch: RecoveryArchiveBranch, source: ExportVersion): 1 | 2 | 3 {
  if (branch === 'collections') return source === 2 ? 2 : 1;
  return source === 1 || source === 2 || source === 3 ? source : 3;
}

function sectionsFor(version: 1 | 2 | 3): readonly ExportSection[] {
  return version === 1 ? EXPORT_SECTIONS_V1 : EXPORT_SECTIONS_V3;
}

function selectedRecords(records: ExportRecord[], version: 1 | 2 | 3): ExportRecord[] {
  const allowed = new Set<string>(sectionsFor(version));
  const grouped = new Map<string, ExportRecord[]>();
  for (const row of records) {
    if (!allowed.has(row.section)) continue;
    const bucket = grouped.get(row.section);
    if (bucket) bucket.push(row);
    else grouped.set(row.section, [row]);
  }
  const selected: ExportRecord[] = [];
  for (const section of sectionsFor(version)) selected.push(...(grouped.get(section) ?? []));
  return selected;
}

function rebuild(source: Record<string, unknown>, records: ExportRecord[], version: 1 | 3) {
  const rows = records.length;
  const recordBytes = records.reduce((sum, row) => sum + encodedRecordBytes(row), 0);
  const common = {
    format: EXPORT_FORMAT,
    exportId: source.exportId,
    capturedAt: source.capturedAt,
    expiresAt: source.expiresAt,
    privacy: 'private' as const,
    completeness: 'supported-native-facts' as const,
    fullExport: false as const,
    rows,
    recordBytes,
  };
  if (version === 1)
    return {
      format: common.format,
      version: 1 as const,
      exportId: common.exportId,
      capturedAt: common.capturedAt,
      expiresAt: common.expiresAt,
      privacy: common.privacy,
      completeness: common.completeness,
      sections: [...EXPORT_SECTIONS_V1],
      omissions: { ...v1Omissions },
      fullExport: common.fullExport,
      rows,
      recordBytes,
    };
  const sectionTotals = Object.fromEntries(
    EXPORT_SECTIONS_V3.map((section) => {
      const rowsForSection = records.filter((row) => row.section === section);
      return [
        section,
        {
          rows: rowsForSection.length,
          recordBytes: rowsForSection.reduce((sum, row) => sum + encodedRecordBytes(row), 0),
        },
      ];
    }),
  );
  return {
    format: common.format,
    version: 3 as const,
    coverage: EXPORT_V3_COVERAGE,
    exportId: common.exportId,
    capturedAt: common.capturedAt,
    expiresAt: common.expiresAt,
    privacy: common.privacy,
    completeness: common.completeness,
    sections: [...EXPORT_SECTIONS_V3],
    omissions: { ...v3Omissions },
    fullExport: common.fullExport,
    rows,
    recordBytes,
    sectionTotals,
  };
}

/**
 * Keep downloaded V4 bytes unchanged. Recovery consumers receive the installed V1 or V3 envelope their decoder admits.
 * Unreadable file bytes stay original so the native decoder, not this projection, refuses them.
 */
export function projectArchiveForRecovery(bytes: Uint8Array, branch: RecoveryArchiveBranch): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bytes;
  }
  if (!record(parsed) || !record(parsed.manifest) || !Array.isArray(parsed.records)) return bytes;
  const sourceVersion = versionOf(parsed.manifest.version);
  if (!sourceVersion) return bytes;
  const target = supportedRecoveryVersion(branch, sourceVersion);
  if (target === sourceVersion) return bytes;
  const records = parsed.records.filter((row): row is ExportRecord => record(row) && typeof row.section === 'string');
  const selected = selectedRecords(records, target);
  const manifest = rebuild(parsed.manifest, selected, target === 2 ? 1 : target);
  return new TextEncoder().encode(JSON.stringify({ manifest, records: selected }));
}

export function recoveryArchiveFile(file: File, branch: RecoveryArchiveBranch): Promise<File> {
  return file.arrayBuffer().then((buffer) => {
    const projected = projectArchiveForRecovery(new Uint8Array(buffer), branch);
    return new File([projected], file.name, { type: file.type || 'application/json' });
  });
}

export function recoveryArchiveText(text: string, branch: RecoveryArchiveBranch): string {
  return new TextDecoder().decode(projectArchiveForRecovery(new TextEncoder().encode(text), branch));
}

export function recoveryArchiveBase64(base64: string, branch: RecoveryArchiveBranch): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const projected = projectArchiveForRecovery(bytes, branch);
  let binary = '';
  for (let offset = 0; offset < projected.length; offset += 8192)
    binary += String.fromCharCode(...projected.subarray(offset, offset + 8192));
  return btoa(binary);
}
