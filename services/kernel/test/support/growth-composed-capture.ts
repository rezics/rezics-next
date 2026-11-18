import { captureCostFoldedInternal, type GrowthCaptureOptions, type GrowthDatabase } from './growth-capture.ts';
import type { CostFoldedCapture } from './growth-cost-fold.ts';

/** Captures one complete caller while retaining only bounded native cost and occurrence summaries. */
export function captureWithFoldedCost<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions = {},
): Promise<{ value: T; capture: CostFoldedCapture }> {
  return captureCostFoldedInternal(database, operation, options);
}
