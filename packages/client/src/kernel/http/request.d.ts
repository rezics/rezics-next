import type { AccountActor } from '../request/access.ts';
import type { ActionCatalogue } from '../request/access.ts';
export declare const SESSION_HEADER = "rezics-session-token";
export declare const IDEMPOTENCY_HEADER = "idempotency-key";
export declare function idempotencyKeyOf(header: string | null | undefined): string;
export declare function requestDigest(operation: string, actor: AccountActor, body: unknown): Uint8Array;
type Route = {
    method: string;
    path: string;
    hooks?: {
        detail?: unknown;
    };
};
type RouteApp = {
    routes: readonly Route[];
};
/** Derives the configured action set from the routes mounted on an application. */
export declare function actionCatalogue(app: RouteApp): ActionCatalogue;
/** Finds and validates the mounted route that is handling this request. */
export declare function actionForRequest(app: RouteApp, request: Request, routePath?: string): string;
export {};
