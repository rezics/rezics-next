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
export declare function createAuthConsentReader(config: {
    url: string;
    serviceTokenId: string;
    serviceTokenSecret: string;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): CurrentConsentReader;
