import type { Actor } from '../../request/access.ts';
import type { FeedDependencies, FeedProducerCapabilities } from './feed-capabilities.ts';
export type { FeedDependencies } from './feed-capabilities.ts';
import type { FeedApplicationPorts } from '../contract/index.ts';
/** Request-scoped native producers for the Content feed application. */
export declare function createNativeFeedPorts(deps: FeedDependencies, liveActor: () => Actor, capabilities: FeedProducerCapabilities): FeedApplicationPorts;
