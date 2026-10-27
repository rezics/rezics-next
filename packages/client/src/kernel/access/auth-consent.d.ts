export type AuthConsentConfig = Readonly<{
    url: string;
    serviceTokenId: string;
    serviceTokenSecret: string;
}>;
export declare const AUTH_CONSENT_VARIABLES: readonly ["KERNEL_AUTH_CONSENT_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"];
/** Shared host configuration for every module that restores an initiator.
 * The group is absent or complete; errors name a variable, never its value. */
export declare function readAuthConsentConfig(env: Readonly<Record<string, string | undefined>>): AuthConsentConfig | null;
export type CurrentConsent = Readonly<{
    actorAccountId: string;
    clientId: string;
    scopes: readonly string[];
}>;
export type CurrentConsentReader = (input: {
    actorAccountId: string;
    clientId: string;
    deadline: number;
}) => Promise<CurrentConsent | null>;
/** Trusted server composition for durable person-attributed steps only. Supply
 * the exact private HTTPS Tunnel/Access URL and service token credentials; never
 * accept these from request fields. Exact loopback HTTP is for isolated tests.
 * No Auth database, keys, cookies or provider introspection enter the kernel.
 * Every invocation obtains Auth's native current fact, independently of Access's
 * evaluator T/clock. Inject into the restorer; do not install in requestJSON.
 */
export declare function createAuthConsentReader(config: AuthConsentConfig & {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): CurrentConsentReader;
