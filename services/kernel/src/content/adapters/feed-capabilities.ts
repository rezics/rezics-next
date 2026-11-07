import { createContinuePageAdapter } from '../../library/adapters/continue-page.ts';
import { createPublicSummaryAdapter } from '../../semantic/adapters/public-summary.ts';
import type { FeedProducerCapabilities } from './feed-bind.ts';

/** Ordinary composition installs the real Library Continue and Semantic summary producers. */
export function createNativeFeedCapabilities(): FeedProducerCapabilities {
  return {
    createContinuation: createContinuePageAdapter,
    createPublicSummary: createPublicSummaryAdapter,
    present: (row) => row,
  };
}
