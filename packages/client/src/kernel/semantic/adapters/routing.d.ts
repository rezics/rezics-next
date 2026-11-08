import type { RoutePort } from '../contract/domain-ports.ts';
/** Native routed IDs. Composition binds this; cores never import the route encoder. */
export declare function nativeRouting(): RoutePort;
