import { type CommandPrincipal } from '../command/command.ts';
import type { ActionCatalogue, Actor } from '../request/access.ts';
export declare const SESSION_HEADER = "rezics-session-token";
export declare const IDEMPOTENCY_HEADER = "idempotency-key";
export declare function idempotencyKeyOf(header: string | null | undefined, principal?: CommandPrincipal): string;
export declare function requestDigest(operation: string, actor: Actor, body: unknown): Uint8Array;
/** Stable tuple home under the server-owned route key; grants no authorization. */
export declare function anonymousCommandTarget(routeKey: Uint8Array, operation: string, key: string): {
    route: number;
    id: string;
};
/** The caller owns all normalized effect fields in semantic; fresh proof is excluded. */
export declare function anonymousRequestDigest(operation: string, input: {
    semantic: unknown;
    abuse?: unknown;
}): Uint8Array;
export type MountedRoute = {
    method: string;
    path: string;
    hooks?: {
        detail?: unknown;
    };
};
type RouteApp = {
    routes: readonly MountedRoute[];
    '~map'?: {
        [method: string]: Record<string, unknown> | undefined;
    };
    '~config'?: {
        strictPath?: boolean;
    };
};
/** Composes mounted routes with trusted native declarations, checking their agreement. */
export declare function actionCatalogue(app: RouteApp, nativeActions?: ActionCatalogue): ActionCatalogue;
/** A snapshot of server declarations, indexed by native method and matched template.
 * Construct only after composition; Elysia's routes getter composes hook views.
 * Request paths are never matched here: Elysia has already selected the route.
 */
export declare class MountedRouteCatalogue {
    #private;
    readonly routes: readonly MountedRoute[];
    constructor(routes: readonly MountedRoute[], app?: RouteApp);
    find(request: Request, matchedTemplate?: string): MountedRoute | undefined;
}
/** App instances and standalone stage route arrays have independent catalogue lifetimes. */
export declare function mountedRouteCatalogue(app: RouteApp | readonly MountedRoute[], routes?: readonly MountedRoute[]): MountedRouteCatalogue;
/** The action label is also available for errors before authorization is initialized. */
export declare function actionLabelOfMountedRoute(route: MountedRoute | undefined): string;
export declare function actionOfMountedRoute(route: MountedRoute | undefined): string;
/** Finds and validates Elysia's mounted route, never routing a parameterized URL again. */
export declare function actionForRequest(app: RouteApp, request: Request, routePath?: string): string;
export {};
