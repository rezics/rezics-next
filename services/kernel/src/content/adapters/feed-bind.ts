import type { createContinuePageAdapter } from '../../library/adapters/continue-page.ts';
import type { createPublicSummaryAdapter } from '../../semantic/adapters/public-summary.ts';
import type { FeedContinuationSubject } from '../contract/index.ts';

/** Library Continue, Semantic public summary and Library session presentation as Home consumes them. */
export type FeedProducerCapabilities = {
  createContinuation: typeof createContinuePageAdapter;
  createPublicSummary: typeof createPublicSummaryAdapter;
  present(row: FeedContinuationSubject): FeedContinuationSubject;
};

let bound: FeedProducerCapabilities | undefined;

export function bindFeedCapabilities(capabilities: FeedProducerCapabilities): FeedProducerCapabilities {
  bound = capabilities;
  return capabilities;
}

export function feedCapabilities(): FeedProducerCapabilities {
  if (!bound) throw new Error('Content feed capabilities are not bound');
  return bound;
}

export function tryFeedCapabilities(): FeedProducerCapabilities | undefined {
  return bound;
}

export function unbindFeedCapabilities(): void {
  bound = undefined;
}
