import { RECOVERY_PAGE_ROWS, RECOVERY_SELECTED_OCCURRENCES } from './contract';

export type RecoveryCallKind =
  | 'upload'
  | 'status'
  | 'collections'
  | 'occurrences'
  | 'review'
  | 'apply'
  | 'outcomes'
  | 'cancel';
export type RecoveryCost = {
  calls: Record<RecoveryCallKind, number>;
  retries: number;
  pages: number;
  rows: number;
  maxPageRows: number;
  applyRequests: number;
};

export function emptyRecoveryCost(): RecoveryCost {
  return {
    calls: { upload: 0, status: 0, collections: 0, occurrences: 0, review: 0, apply: 0, outcomes: 0, cancel: 0 },
    retries: 0,
    pages: 0,
    rows: 0,
    maxPageRows: 0,
    applyRequests: 0,
  };
}

export class RecoveryCostLedger {
  readonly current = emptyRecoveryCost();

  call(kind: RecoveryCallKind, retry = false): void {
    this.current.calls[kind] += 1;
    if (retry) this.current.retries += 1;
    if (kind === 'apply') this.current.applyRequests += 1;
  }

  page(kind: 'collections' | 'occurrences' | 'outcomes', rows: number): void {
    this.call(kind);
    this.current.pages += 1;
    this.current.rows += rows;
    this.current.maxPageRows = Math.max(this.current.maxPageRows, rows);
  }

  withinCaps(selected: number): boolean {
    return this.current.maxPageRows <= RECOVERY_PAGE_ROWS && selected <= RECOVERY_SELECTED_OCCURRENCES;
  }

  snapshot(): RecoveryCost {
    return { ...this.current, calls: { ...this.current.calls } };
  }
}
