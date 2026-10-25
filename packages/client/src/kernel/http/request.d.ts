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
