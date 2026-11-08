import type { FeedProducerCapabilities } from './feed-capabilities.ts';
export type { FeedProducerCapabilities } from './feed-capabilities.ts';
export declare function bindFeedCapabilities(capabilities: FeedProducerCapabilities): FeedProducerCapabilities;
export declare function feedCapabilities(): FeedProducerCapabilities;
export declare function tryFeedCapabilities(): FeedProducerCapabilities | undefined;
export declare function unbindFeedCapabilities(): void;
