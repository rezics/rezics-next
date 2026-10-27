import type { Metric, Slack } from './growth-bound.ts';

// Calibration sets these per-metric uncertainty values.
export const GROWTH_UNCERTAINTY: Readonly<Record<Metric, Slack>> = {
  rows: { absolute: 2, relative: 0.1 },
  blocks: { absolute: 4, relative: 0.5 },
  statements: { absolute: 0, relative: 0 },
};
