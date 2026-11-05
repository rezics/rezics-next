import type { ExportArtifact, ExportManifest } from './contract';

/** One completed local archive for the current signed-in owner. Bytes stay in process memory. */
export type CompletedArchiveCustody = {
  owner: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  exportId: string;
  capturedAt: string;
  version: ExportManifest['version'];
};

const held = new Map<string, CompletedArchiveCustody>();

function drop(owner: string): void {
  const previous = held.get(owner);
  if (!previous) return;
  previous.bytes.fill(0);
  held.delete(owner);
}

/** A replacement owner cannot inherit another account's completed bytes. */
export function bindArchiveCustodyOwner(owner: string): void {
  for (const key of [...held.keys()]) if (key !== owner) drop(key);
}

export function holdCompletedArchive(
  owner: string,
  artifact: ExportArtifact,
  manifest: Pick<ExportManifest, 'exportId' | 'capturedAt' | 'version'>,
): void {
  bindArchiveCustodyOwner(owner);
  const bytes = new Uint8Array(artifact.bytes.byteLength);
  bytes.set(artifact.bytes);
  drop(owner);
  held.set(owner, {
    owner,
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    bytes,
    exportId: manifest.exportId,
    capturedAt: manifest.capturedAt,
    version: manifest.version,
  });
}

export function completedArchiveFor(owner: string): CompletedArchiveCustody | null {
  return held.get(owner) ?? null;
}

export function releaseCompletedArchive(owner: string): void {
  drop(owner);
}

export function archiveFileFromCustody(value: CompletedArchiveCustody): File {
  const copy = new Uint8Array(value.bytes.byteLength);
  copy.set(value.bytes);
  return new File([copy.buffer as ArrayBuffer], value.filename, { type: value.mediaType });
}

export function archiveTextFromCustody(value: CompletedArchiveCustody): string {
  return new TextDecoder().decode(value.bytes);
}

export function archiveBase64FromCustody(value: CompletedArchiveCustody): string {
  const parts: string[] = [];
  const chunk = 16 * 1024;
  for (let offset = 0; offset < value.bytes.length; offset += chunk) {
    parts.push(String.fromCharCode(...value.bytes.subarray(offset, Math.min(offset + chunk, value.bytes.length))));
  }
  return btoa(parts.join(''));
}
