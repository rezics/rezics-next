import type { Pool } from 'pg';
import type { ContentLifecyclePort, HashPort, RoutePort } from '../contract/domain-ports.ts';
/** Composition installs the native Content adapter. Inward files never import that adapter. */
export declare function bindOrdinaryContentLifecycle(port: ContentLifecyclePort): void;
export declare function hashingOf(pool?: Pool): HashPort;
export declare function routingOf(pool?: Pool): RoutePort;
export declare function contentLifecycleOf(pool?: Pool): ContentLifecyclePort;
