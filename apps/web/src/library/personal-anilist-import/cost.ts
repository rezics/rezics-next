import {
  ANILIST_APPLY,
  ANILIST_PAGE,
  encodedBytes,
  type AniListCommand,
  type AniListPage,
  type AniListRowMeta,
} from './contract';

/** Machine-independent work at the AniList loader/controller boundary. */
export type AniListCallKind = 'preview' | 'page' | 'review' | 'apply' | 'cancel';

export type AniListCostSnapshot = {
  calls: Record<AniListCallKind, number>;
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

export function emptyAniListCost(): AniListCostSnapshot {
  return {
    calls: { preview: 0, page: 0, review: 0, apply: 0, cancel: 0 },
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

export function aniListCallTotal(cost: AniListCostSnapshot): number {
  const calls = cost.calls;
  return calls.preview + calls.page + calls.review + calls.apply + calls.cancel;
}

/**
 * 1 preview + K page reads + M reviews + Q apply batches + lifecycle + explicit retries.
 * Lifecycle is cancel (stop or remove). Retries are counted in both retries and the matching method.
 */
export function expectedAniListCalls(input: {
  pages: number;
  reviews: number;
  applyBatches: number;
  lifecycle: number;
  retries: number;
  preview?: number;
}): number {
  return (input.preview ?? 1) + input.pages + input.reviews + input.applyBatches + input.lifecycle + input.retries;
}

export function aniListRetainedBound(input: {
  uploadBytes: number;
  pageRowBytes: number;
  metaBytes: number;
  count: number;
}): number {
  return input.uploadBytes + ANILIST_PAGE * input.pageRowBytes + input.count * input.metaBytes;
}

export class AniListCostLedger {
  readonly snapshot: AniListCostSnapshot = emptyAniListCost();

  recordCall(kind: AniListCallKind, retry = false): void {
    this.snapshot.calls[kind] += 1;
    if (retry) this.snapshot.retries += 1;
  }

  recordPage(page: AniListPage): void {
    this.snapshot.pagesVisited += 1;
    this.snapshot.maxPageRows = Math.max(this.snapshot.maxPageRows, page.rows.length);
    this.snapshot.processed += page.rows.reduce((sum, row) => sum + 1 + row.source.fields.length, 0);
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
    page?: AniListPage | null;
    meta: Iterable<AniListRowMeta>;
    command?: AniListCommand | null;
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
    return this.snapshot.maxPageRows <= ANILIST_PAGE && this.snapshot.maxApplyRows <= ANILIST_APPLY;
  }
}
