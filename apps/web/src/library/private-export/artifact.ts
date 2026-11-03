import {
  EXPORT_PAGE_RECORD_BYTES,
  EXPORT_STREAM_BYTES,
  EXPORT_STREAM_RECORDS,
  artifactFilename,
  encodedBytes,
  type ExportArtifact,
  type ExportManifest,
  type ExportRecord,
} from './contract';

export type AssemblyLimit = { kind: 'limit' };

/**
 * Bounded sequential assembly. Each page is stored as its own chunk so the visit never
 * recopies the collected prefix. Final JSON is produced once after a complete manifest.
 */
export class ExportAssembly {
  private chunks: ExportRecord[][] = [];
  private records = 0;
  private bytes = 0;
  private artifact: ExportArtifact | null = null;

  addPage(records: readonly ExportRecord[]): AssemblyLimit | null {
    if (this.artifact) return { kind: 'limit' };
    const pageBytes = encodedBytes(records);
    if (records.length && pageBytes > EXPORT_PAGE_RECORD_BYTES) return { kind: 'limit' };
    if (this.records + records.length > EXPORT_STREAM_RECORDS) return { kind: 'limit' };
    if (this.bytes + pageBytes > EXPORT_STREAM_BYTES) return { kind: 'limit' };
    this.chunks.push(records.map((record) => record));
    this.records += records.length;
    this.bytes += pageBytes;
    return null;
  }

  finalize(manifest: ExportManifest): ExportArtifact | AssemblyLimit {
    if (this.artifact) return this.artifact;
    if (manifest.rows !== this.records) return { kind: 'limit' };
    const payload = { manifest, records: this.chunks.flat() };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.byteLength > EXPORT_STREAM_BYTES + encodedBytes(manifest) + 64) return { kind: 'limit' };
    this.artifact = {
      filename: artifactFilename(manifest.exportId),
      mediaType: 'application/json',
      bytes,
    };
    this.chunks = [];
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

  clear(): void {
    this.chunks = [];
    this.records = 0;
    this.bytes = 0;
    this.artifact = null;
  }
}

export function deliverLocalFile(file: ExportArtifact): boolean {
  const blob = new Blob([file.bytes], { type: file.mediaType });
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

export function parseAssembledArtifact(bytes: Uint8Array): { manifest: ExportManifest; records: ExportRecord[] } | null {
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
