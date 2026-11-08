import type { KeyRing } from '../tokens/seal.ts';
type Environment = Readonly<Record<string, string | undefined>>;
/** Public JWKS identity only. Do not import authenticate.ts: that module loads SQL at init. */
type AuthJwksConfig = {
    issuer: string;
    audience: string;
    jwksUrl: string;
    fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
};
export declare const MEMBERSHIP_WORK_DEADLINE_MS = 30000;
export type MembershipWorkConfig = {
    routeKey: Buffer;
    referenceKeys: KeyRing;
    auth: AuthJwksConfig;
};
export declare function readMembershipRouteKey(env: Environment): Buffer;
/**
 * Local stacks keep AUTH_JWKS_URL on the issuer origin. Native Auth is only the
 * loopback transport for that exact public document; other URLs are not forwarded.
 * A different loopback port is not an allowed JWKS identity.
 */
export declare function localJwksTransport(env: Environment, auth: AuthJwksConfig): AuthJwksConfig;
/** Registration reads only the supplied deployment environment, once. */
export declare function readMembershipWorkConfig(env: Environment): MembershipWorkConfig;
export {};
