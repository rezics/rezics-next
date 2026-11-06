import type { AccessClock, AccessIdentityExpiry } from '../contract/index.ts';
export type IdentityExpiry = AccessIdentityExpiry;
export declare function identityExpired(expiry: {
    expires: number;
    expiryClock?: AccessIdentityExpiry['expiryClock'];
}, clock: AccessClock): boolean;
/** Carry a remaining duration across clocks, sampling the target before the source. */
export declare function carryExpiry(expires: number, clock: AccessClock, target: 'wall' | 'kernel'): number;
