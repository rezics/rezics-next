import type { Actor } from '../request/access.ts';
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
