import type { Metric, Slack } from './growth-bound.ts';

export const GROWTH_UNCERTAINTY: Readonly<Record<Metric, Slack>> = {
  rows: { absolute: 22, relative: 0 },
  blocks: { absolute: 9, relative: 0.03 },
  statements: { absolute: 0, relative: 0 },
};
