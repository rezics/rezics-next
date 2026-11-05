import { type IdentityExpiry } from './identity-expiry.ts';
import { type KernelClock } from '../clock.ts';
import { type FetchImplementation } from 'jose';
import { type AccessClient, type AccessContext, type AccountActor } from '../request/access.ts';
import { type DurableIdentity } from './durable-identity.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { type ApprovedIdentity } from './approved-identity.ts';
import { type Account } from './account-data.ts';
export type AuthenticationConfig = {
    issuer: string;
    audience: string;
    jwksUrl: string;
    /** Public JWKS transport only. No credential, token or private key is passed. */
    fetch?: FetchImplementation;
};
type Identity = IdentityExpiry & {
    account: Account;
    pool: AccessContext['pool'];
    deadline: number;
    observedAt: number;
    requestContext?: AccessContext;
    requestWork?: AccessContext['work'];
    requestTime?: AuthoritativeTime;
    durableTime?: AuthoritativeTime;
    durableAction?: string;
};
/** Also bounds pool queueing and transports that do not honor AbortSignal. */
export declare function within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
/** Preserve pg's decoding capabilities when wrapping reylo's query transport. */
export declare function deadlineClient(client: AccessClient, deadline: number): AccessClient;
/** Each factory owns its key cache and its opaque, immutable request identities. */
export declare function createAuthenticator(configuration?: AuthenticationConfig, clock?: KernelClock): {
    authenticate: (token: string, context: {
        pool: import("pg").Pool;
        deadline: number;
    }) => Promise<AccountActor>;
    /** Refresh only an identity already verified by THIS authenticator/pool.
     * No cryptography or key-fetch callback is treated as zero work. */
    refresh(actor: AccountActor, context: AccessContext): Promise<boolean>;
    approvalScope: Readonly<{}>;
    durableScope: Readonly<{}>;
    /** Private operation proof, not a row/Actor registration API. */
    restoreDurable(proof: DurableIdentity, context: AccessContext, time: AuthoritativeTime): Promise<AccountActor>;
    discardDurable(actor: AccountActor): void;
    /** Internal native approval proof only. Reconstructed actors have no proof. */
    restoreApproval(proof: ApprovedIdentity, context: AccessContext): Promise<AccountActor>;
    identity(actor: AccountActor): Identity | undefined;
};
/** Native read time minted from this exact admitted SQL observation. Caller releases it. */
export declare function readNativeAccessTime(context: AccessContext, clock?: KernelClock, instant?: string): Promise<AuthoritativeTime>;
export {};
