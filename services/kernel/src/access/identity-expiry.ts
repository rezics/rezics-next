import type { KernelClock } from '../clock.ts';

/** Private verified identity facts; public actors carry no clock or expiry. */
export type IdentityExpiry = { expires: number; expiryClock: 'wall' | 'kernel' };

export function identityExpired(
  expiry: { expires: number; expiryClock?: IdentityExpiry['expiryClock'] },
  clock: KernelClock,
): boolean {
  const now = expiry.expiryClock === 'wall' ? new Date() : clock();
  return now.getTime() >= expiry.expires;
}

/** Carry a remaining duration across clocks, sampling the target before the source. */
export function carryExpiry(expires: number, clock: KernelClock, target: 'wall' | 'kernel'): number {
  const targetNow = target === 'kernel' ? clock().getTime() : new Date().getTime();
  const sourceNow = target === 'kernel' ? new Date().getTime() : clock().getTime();
  return targetNow + (expires - sourceNow);
}
