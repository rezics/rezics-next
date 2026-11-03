import {
  BANGUMI_APPLY,
  BANGUMI_PAGE,
  encodedBytes,
  type BangumiCommand,
  type BangumiPage,
  type BangumiRowMeta,
} from './contract';

/** Machine-independent work at the Bangumi loader/controller boundary. */
export type BangumiCallKind = 'preview' | 'page' | 'review' | 'apply' | 'cancel' | 'delete';

export type BangumiCostSnapshot = {
  calls: Record<BangumiCallKind, number>;
  retries: number;
  pagesVisited: number;
  reviewed: number;
  applyBatches: number;
  applyRows: number;
  processed: number;
  rendered: number;
  uploadBytes: number;
  pageBytes: number;
  metaBytes: number;
  commandBytes: number;
  retainedBytes: number;
  maxPageRows: number;
  maxApplyRows: number;
};

export function emptyBangumiCost(): BangumiCostSnapshot {
  return {
    calls: { preview: 0, page: 0, review: 0, apply: 0, cancel: 0, delete: 0 },
    retries: 0,
    pagesVisited: 0,
    reviewed: 0,
    applyBatches: 0,
    applyRows: 0,
    processed: 0,
    rendered: 0,
    uploadBytes: 0,
    pageBytes: 0,
    metaBytes: 0,
    commandBytes: 0,
    retainedBytes: 0,
    maxPageRows: 0,
    maxApplyRows: 0,
  };
}

export function bangumiCallTotal(cost: BangumiCostSnapshot): number {
  const calls = cost.calls;
  return calls.preview + calls.page + calls.review + calls.apply + calls.cancel + calls.delete;
}

/**
 * 1 preview + K page reads + M reviews + Q apply batches + lifecycle + explicit retries.
 * Lifecycle is cancel/delete. Retries are counted in both retries and the matching method.
 */
export function expectedBangumiCalls(input: {
  pages: number;
  reviews: number;
  applyBatches: number;
  lifecycle: number;
  retries: number;
  preview?: number;
}): number {
  return (input.preview ?? 1) + input.pages + input.reviews + input.applyBatches + input.lifecycle + input.retries;
}

export function bangumiRetainedBound(input: {
  uploadBytes: number;
  pageRowBytes: number;
  metaBytes: number;
  count: number;
}): number {
  return input.uploadBytes + BANGUMI_PAGE * input.pageRowBytes + input.count * input.metaBytes;
}

export class BangumiCostLedger {
  readonly snapshot: BangumiCostSnapshot = emptyBangumiCost();

  recordCall(kind: BangumiCallKind, retry = false): void {
    this.snapshot.calls[kind] += 1;
    if (retry) this.snapshot.retries += 1;
  }

  recordPage(page: BangumiPage): void {
    this.snapshot.pagesVisited += 1;
    this.snapshot.maxPageRows = Math.max(this.snapshot.maxPageRows, page.rows.length);
    this.snapshot.processed += page.rows.reduce((sum, row) => sum + 1 + row.evidence.fields.length, 0);
  }

  recordReview(): void {
    this.snapshot.reviewed += 1;
  }

  recordApply(count: number): void {
    this.snapshot.applyBatches += 1;
    this.snapshot.applyRows += count;
    this.snapshot.maxApplyRows = Math.max(this.snapshot.maxApplyRows, count);
  }

  recordRender(count: number): void {
    this.snapshot.rendered = count;
  }

  retain(input: {
    upload?: string | null;
    page?: BangumiPage | null;
    meta: Iterable<BangumiRowMeta>;
    command?: BangumiCommand | null;
  }): void {
    const meta = [...input.meta];
    this.snapshot.uploadBytes = input.upload ? encodedBytes(input.upload) : 0;
    this.snapshot.pageBytes = input.page ? encodedBytes(input.page) : 0;
    this.snapshot.metaBytes = encodedBytes(meta);
    this.snapshot.commandBytes = input.command ? encodedBytes(input.command) : 0;
    this.snapshot.retainedBytes =
      this.snapshot.uploadBytes + this.snapshot.pageBytes + this.snapshot.metaBytes + this.snapshot.commandBytes;
  }

  withinCaps(): boolean {
    return this.snapshot.maxPageRows <= BANGUMI_PAGE && this.snapshot.maxApplyRows <= BANGUMI_APPLY;
  }
}
