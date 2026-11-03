import {
  EXPORT_PAGE_RECORD_BYTES,
  EXPORT_PAGE_ROWS,
  EXPORT_ROW_BYTES,
  EXPORT_STREAM_BYTES,
  EXPORT_STREAM_RECORDS,
  artifactFilename,
  encodedBytes,
  encodedRecordBytes,
  isExportRecord,
  sectionsForExportVersion,
  type ExportArtifact,
  type ExportManifest,
  type ExportRecord,
  type ExportVersion,
} from './contract';

export type AssemblyFailure = { kind: 'limit' | 'invalid' };
type SectionCount = { rows: number; recordBytes: number };

/** Stores bounded pages once and serializes the full artifact only after verified completion. */
export class ExportAssembly {
  private chunks: ExportRecord[][] = [];
  private records = 0;
  private bytes = 0;
  private lastPageBytes = 0;
  private version: ExportVersion | null = null;
  private sectionTotals = new Map<string, SectionCount>();
  private artifact: ExportArtifact | null = null;

  bind(version: ExportVersion): AssemblyFailure | null {
    if (this.version !== null && this.version !== version) return { kind: 'invalid' };
    this.version = version;
    if (this.sectionTotals.size === 0) {
      const sections = sectionsForExportVersion(version);
      for (const section of sections) this.sectionTotals.set(section, { rows: 0, recordBytes: 0 });
    }
    return null;
  }

  addPage(records: readonly ExportRecord[], version: ExportVersion): AssemblyFailure | null {
    if (this.artifact || this.version !== version) return { kind: 'invalid' };
    if (records.length > EXPORT_PAGE_ROWS) return { kind: 'limit' };

    let pageBytes = 0;
    const pageTotals = new Map<string, SectionCount>();
    for (const record of records) {
      if (!isExportRecord(record) || !this.sectionTotals.has(record.section) || !recordMatchesVersion(record, version))
        return { kind: 'invalid' };
      const recordBytes = encodedRecordBytes(record);
      if (version !== 1 && recordBytes > EXPORT_ROW_BYTES) return { kind: 'limit' };
      pageBytes += recordBytes;
      const sectionTotal = pageTotals.get(record.section) ?? { rows: 0, recordBytes: 0 };
      sectionTotal.rows += 1;
      sectionTotal.recordBytes += recordBytes;
      pageTotals.set(record.section, sectionTotal);
    }

    if (pageBytes > EXPORT_PAGE_RECORD_BYTES) return { kind: 'limit' };
    if (this.records + records.length > EXPORT_STREAM_RECORDS) return { kind: 'limit' };
    if (this.bytes + pageBytes > EXPORT_STREAM_BYTES) return { kind: 'limit' };

    if (records.length > 0) this.chunks.push([...records]);
    this.records += records.length;
    this.bytes += pageBytes;
    this.lastPageBytes = pageBytes;
    for (const [section, added] of pageTotals) {
      const total = this.sectionTotals.get(section)!;
      total.rows += added.rows;
      total.recordBytes += added.recordBytes;
    }
    return null;
  }

  finalize(manifest: ExportManifest): ExportArtifact | AssemblyFailure {
    if (this.artifact) return this.artifact;
    if (this.version !== manifest.version || manifest.rows !== this.records || manifest.recordBytes !== this.bytes)
      return { kind: 'invalid' };

    if (manifest.version !== 1) {
      const sections = manifest.sections;
      for (const section of sections) {
        const actual = this.sectionTotals.get(section);
        const declared =
          manifest.version === 4
            ? manifest.sectionTotals[section]
            : manifest.sectionTotals[section as keyof typeof manifest.sectionTotals];
        if (!actual || declared.rows !== actual.rows || declared.recordBytes !== actual.recordBytes)
          return { kind: 'invalid' };
      }
    }

    const records = this.chunks.flat();
    if (records.length !== this.records) return { kind: 'invalid' };
    // JSON.stringify and TextEncoder each make one bounded whole-artifact copy at finalization.
    const serialized = JSON.stringify({ manifest, records });
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength > EXPORT_STREAM_BYTES + encodedBytes(manifest) + records.length + 64) return { kind: 'limit' };

    this.artifact = {
      filename: artifactFilename(manifest.exportId),
      mediaType: 'application/json',
      bytes,
    };
    this.chunks = [];
    this.lastPageBytes = 0;
    return this.artifact;
  }

  current(): ExportArtifact | null {
    return this.artifact;
  }

  chunksView(): readonly ExportRecord[][] {
    return this.chunks;
  }

  recordCount(): number {
    return this.records;
  }

  recordBytes(): number {
    return this.bytes;
  }

  retainedRecordBytes(): number {
    return this.artifact ? 0 : this.bytes;
  }

  retainedPageBytes(): number {
    return this.artifact ? 0 : this.lastPageBytes;
  }

  clear(): void {
    this.chunks = [];
    this.records = 0;
    this.bytes = 0;
    this.lastPageBytes = 0;
    this.version = null;
    this.sectionTotals.clear();
    this.artifact = null;
  }
}

function recordMatchesVersion(record: ExportRecord, version: ExportVersion): boolean {
  if (record.section !== 'journals') return true;
  const journal = record.journal;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return false;
  const value = journal as Record<string, unknown>;
  const hasAssessment = Object.hasOwn(value, 'assessment');
  if (version < 3) return !hasAssessment;
  const assessment = value.assessment;
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) return false;
  const details = assessment as Record<string, unknown>;
  const units = details.units;
  return (
    Object.keys(details).length === 2 &&
    Object.hasOwn(details, 'meaningRevision') &&
    Object.hasOwn(details, 'units') &&
    details.meaningRevision === 1 &&
    (units === null || (typeof units === 'number' && Number.isInteger(units) && units >= 0 && units <= 20))
  );
}

export function deliverLocalFile(file: ExportArtifact): boolean {
  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: file.mediaType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function parseAssembledArtifact(
  bytes: Uint8Array,
): { manifest: ExportManifest; records: ExportRecord[] } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const body = value as { manifest?: ExportManifest; records?: ExportRecord[] };
    if (!body.manifest || !Array.isArray(body.records)) return null;
    return { manifest: body.manifest, records: body.records };
  } catch {
    return null;
  }
}
