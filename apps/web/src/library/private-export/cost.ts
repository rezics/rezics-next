import {
  EXPORT_PAGE_RECORD_BYTES,
  EXPORT_PAGE_ROWS,
  encodedBytes,
  type ExportManifest,
  type ExportPage,
} from './contract';

/** Machine-independent work at the private export loader/controller boundary. */
export type ExportCallKind = 'create' | 'status' | 'page' | 'cancel';

export type ExportCostSnapshot = {
  calls: Record<ExportCallKind, number>;
  retries: number;
  pagesVisited: number;
  emptyPages: number;
  recordsProcessed: number;
  recordBytesProcessed: number;
  retainedBytes: number;
  artifactBytes: number;
  maxPageRecords: number;
  maxPageBytes: number;
  prefixCopies: number;
  finalizeCount: number;
};

export function emptyExportCost(): ExportCostSnapshot {
  return {
    calls: { create: 0, status: 0, page: 0, cancel: 0 },
    retries: 0,
    pagesVisited: 0,
    emptyPages: 0,
    recordsProcessed: 0,
    recordBytesProcessed: 0,
    retainedBytes: 0,
    artifactBytes: 0,
    maxPageRecords: 0,
    maxPageBytes: 0,
    prefixCopies: 0,
    finalizeCount: 0,
  };
}

export function exportCallTotal(cost: ExportCostSnapshot): number {
  const calls = cost.calls;
  return calls.create + calls.status + calls.page + calls.cancel;
}

/**
 * K returned pages, including empty continuing pages, plus a fixed create/status/cancel
 * component and explicit retries R. Parent transitions may emit empty pages, so K is not
 * ceil(N / 16).
 */
export function expectedExportCalls(input: {
  pages: number;
  create?: number;
  status?: number;
  cancel?: number;
  retries: number;
}): number {
  return (input.create ?? 1) + (input.status ?? 0) + input.pages + (input.cancel ?? 0) + input.retries;
}

export function exportRetainedBound(input: { recordBytes: number; manifestBytes: number; pageBytes: number }): number {
  return input.recordBytes + input.manifestBytes + input.pageBytes;
}

export class ExportCostLedger {
  readonly snapshot: ExportCostSnapshot = emptyExportCost();

  recordCall(kind: ExportCallKind, retry = false): void {
    this.snapshot.calls[kind] += 1;
    if (retry) this.snapshot.retries += 1;
  }

  recordPage(page: ExportPage): void {
    const bytes = encodedBytes(page.records);
    this.snapshot.pagesVisited += 1;
    if (page.records.length === 0) this.snapshot.emptyPages += 1;
    this.snapshot.recordsProcessed += page.records.length;
    this.snapshot.recordBytesProcessed += bytes;
    this.snapshot.maxPageRecords = Math.max(this.snapshot.maxPageRecords, page.records.length);
    this.snapshot.maxPageBytes = Math.max(this.snapshot.maxPageBytes, bytes);
  }

  recordFinalize(bytes: number): void {
    this.snapshot.finalizeCount += 1;
    this.snapshot.artifactBytes = bytes;
  }

  retain(input: { chunks: readonly unknown[][]; manifest: ExportManifest | null; artifactBytes: number }): void {
    const pageBytes = input.chunks.length ? encodedBytes(input.chunks[input.chunks.length - 1]) : 0;
    const manifestBytes = input.manifest ? encodedBytes(input.manifest) : 0;
    const recordBytes = input.chunks.reduce((sum, chunk) => sum + encodedBytes(chunk), 0);
    this.snapshot.retainedBytes = recordBytes + manifestBytes + pageBytes + input.artifactBytes;
  }

  withinCaps(): boolean {
    return (
      this.snapshot.maxPageRecords <= EXPORT_PAGE_ROWS && this.snapshot.maxPageBytes <= EXPORT_PAGE_RECORD_BYTES
    );
  }
}
