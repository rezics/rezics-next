import type { KernelClock } from '../clock.ts';
/** Private verified identity facts; public actors carry no clock or expiry. */
export type IdentityExpiry = {
    expires: number;
    expiryClock: 'wall' | 'kernel';
};
export declare function identityExpired(expiry: {
    expires: number;
    expiryClock?: IdentityExpiry['expiryClock'];
}, clock: KernelClock): boolean;
/** Carry a remaining duration across clocks, sampling the target before the source. */
export declare function carryExpiry(expires: number, clock: KernelClock, target: 'wall' | 'kernel'): number;
