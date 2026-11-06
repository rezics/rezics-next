/** Library work-dimension vocabulary. Pure types: no runtime imports, no adapter or foreign module imports.
 * Native Source, Search, Access, Semantic and Content callers share these shapes; none of them owns the ledger.
 */

/** Shared caller-ledger dimensions. These types allocate no budget and implement no ledger. */
export interface WorkDimensions {
  readonly candidateKeys: number;
  /** Shared Source.rows unit: charged plan-proved row-work upper bound; observed physical rows are measured separately. */
  readonly nativeRows: number;
  /** TWO independently released 4096-home sweeps per full Semantic basis read; not candidate work. */
  readonly identityMetadataRows: number;
  readonly emptySeeks: number;
  readonly nativePoints: number;
  readonly witnessKeys: number;
  readonly statements: number;
  readonly bytes: number;
}

/** Reserved BEFORE dispatch, from the ONE Search/Zone request ledger; all dimensions are finite integers >= 0. */
export interface WorkAllowance {
  readonly reservationId: string;
  readonly remaining: WorkDimensions;
}

/**
 * Every used dimension <= its reservation. `used.nativeRows` sums charged per-operation plan bounds, not observed
 * physical tuples. Failures settle consumed dispatched work through caller instrumentation; unused reservation is
 * never reported as spent.
 */
export interface WorkReceipt {
  readonly reservationId: string;
  readonly used: WorkDimensions;
}
