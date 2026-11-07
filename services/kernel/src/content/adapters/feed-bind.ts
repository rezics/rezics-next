import type { FeedProducerCapabilities } from './feed-capabilities.ts';
export type { FeedProducerCapabilities } from './feed-capabilities.ts';

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
