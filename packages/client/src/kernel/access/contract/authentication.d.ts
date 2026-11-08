/** Shared authentication error identity, independent of native authorization. */
export declare class AuthenticationError extends Error {
    readonly status: 400 | 401;
    readonly challenge: string;
    constructor(status: 400 | 401, challenge: string);
}
