import type { AccessClock, AccessIdentityExpiry } from '../contract/index.ts';

export type IdentityExpiry = AccessIdentityExpiry;

export function identityExpired(
  expiry: { expires: number; expiryClock?: AccessIdentityExpiry['expiryClock'] },
  clock: AccessClock,
): boolean {
  const now = expiry.expiryClock === 'wall' ? new Date() : clock();
  return now.getTime() >= expiry.expires;
}

/** Carry a remaining duration across clocks, sampling the target before the source. */
export function carryExpiry(expires: number, clock: AccessClock, target: 'wall' | 'kernel'): number {
  const targetNow = target === 'kernel' ? clock().getTime() : new Date().getTime();
  const sourceNow = target === 'kernel' ? new Date().getTime() : clock().getTime();
  return targetNow + (expires - sourceNow);
}
