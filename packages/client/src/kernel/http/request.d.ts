export { idempotencyKeyOf } from './idempotency-key.ts';
export { requestDigest, anonymousCommandTarget, anonymousRequestDigest } from '../command/request.ts';
import type { ActionCatalogue } from '../request/access.ts';
export { SESSION_HEADER, IDEMPOTENCY_HEADER } from './headers.ts';
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
