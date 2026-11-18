import { captureCostFoldedInternal, type GrowthCaptureOptions, type GrowthDatabase } from './growth-capture.ts';
import type { CostFoldedCapture } from './growth-cost-fold.ts';

/** Captures one complete caller while folding each native plan and retaining any selected foreground documents. */
export function captureWithFoldedCost<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions = {},
): Promise<{ value: T; capture: CostFoldedCapture }> {
  return captureCostFoldedInternal(database, operation, options);
}
